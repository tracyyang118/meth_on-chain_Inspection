require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    console.error("❌ 未找到 RPC_URL 环境变量，请检查 .env 文件。");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);

const ADDRESSES = {
    L1mETH: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa',
    LiquidityBuffer: '0x006FaD88c35D973A87E451CF8D000c7e83Dad409',
    Staking: '0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f',
    UnstakeRequestsManager: '0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9',
    Oracle: '0x8735049F496727f824Cc0f2B174d826f5c408192'
};

const ABIS = {
    mETH: ["function totalSupply() view returns (uint256)"],
    LiquidityBuffer: ["function getAvailableBalance() external view returns (uint256)"],
    Staking: [
        "function totalDepositedInValidators() external view returns (uint256)",
        "function allocatedETHForDeposits() external view returns (uint256)",
        "function ethToMETH(uint256 _ethAmount) external view returns (uint256)"
    ],
    Oracle: [
        "function numRecords() external view returns (uint256)",
        "function latestRecord() external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))",
        "function recordAt(uint256 idx) external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))"
    ],
    UnstakeRequestsManager: ["function balance() external view returns (uint256)"]
};

const methContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.mETH, provider);
const liquidityBufferContract = new ethers.Contract(ADDRESSES.LiquidityBuffer, ABIS.LiquidityBuffer, provider);
const stakingContract = new ethers.Contract(ADDRESSES.Staking, ABIS.Staking, provider);
const oracleContract = new ethers.Contract(ADDRESSES.Oracle, ABIS.Oracle, provider);
const unstakeMgrContract = new ethers.Contract(ADDRESSES.UnstakeRequestsManager, ABIS.UnstakeRequestsManager, provider);

async function getExchangeRateAtBlock(blockNumber) {
    const overrides = blockNumber === 'latest' ? {} : { blockTag: blockNumber };
    const ONE_ETHER = 1000000000000000000n;
    const [
        totalSupply, stakingBal, availableBal, allocatedETH, totalDeposited,
        unstakeBal, historicalOracleRecord, contractEthToMeth
    ] = await Promise.all([
        methContract.totalSupply(overrides), provider.getBalance(ADDRESSES.Staking, blockNumber),
        liquidityBufferContract.getAvailableBalance(overrides), stakingContract.allocatedETHForDeposits(overrides),
        stakingContract.totalDepositedInValidators(overrides), unstakeMgrContract.balance(overrides),
        oracleContract.latestRecord(overrides), stakingContract.ethToMETH(ONE_ETHER, overrides)
    ]);

    const H_TotalAssets = BigInt(stakingBal) + BigInt(availableBal) + BigInt(allocatedETH) +
                          (BigInt(totalDeposited) - BigInt(historicalOracleRecord.cumulativeProcessedDepositAmount || historicalOracleRecord[7])) +
                          BigInt(historicalOracleRecord.currentTotalValidatorBalance || historicalOracleRecord[6]) + BigInt(unstakeBal);
    return { calculatedEthToMeth: (BigInt(totalSupply) * ONE_ETHER) / H_TotalAssets, contractEthToMeth: BigInt(contractEthToMeth) };
}

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, { msg_type: "text", content: { text: message } }).catch(e => console.error("❌ 告警发送失败:", e.message));
}

async function checkExchangeRate() {
    console.log(`\n[${new Date().toISOString()}] 🚀 启动兑换率快照巡检 (CI 定时版)...`);
    let exitCode = 0; // 默认成功
    try {
        const recordsCount = await oracleContract.numRecords();
        if (recordsCount >= 2n) {
            const latestRecord = await oracleContract.recordAt(recordsCount - 1n);
            const previousRecord = await oracleContract.recordAt(recordsCount - 2n);
            const latestBlock = Number(latestRecord.updateEndBlock || latestRecord[1]);
            const previousBlock = Number(previousRecord.updateEndBlock || previousRecord[1]);

            const [prevData, latestData, currentContractEthToMeth, currentBlock] = await Promise.all([
                getExchangeRateAtBlock(previousBlock), getExchangeRateAtBlock(latestBlock),
                stakingContract.ethToMETH(1000000000000000000n), provider.getBlockNumber()
            ]);

            const prevContractStr = ethers.formatUnits(prevData.contractEthToMeth, 18);
            const latestContractStr = ethers.formatUnits(latestData.contractEthToMeth, 18);
            const currentContractStr = ethers.formatUnits(currentContractEthToMeth, 18);

            let reportMsg = `🔍 [快照核查] 正在核算历史及当前实时兑换率...\n`;
            reportMsg += `\n--- 区块 [${previousBlock}] (历史) ---\n├─ 盘点计算 (1 ETH = ? mETH): ${ethers.formatUnits(prevData.calculatedEthToMeth, 18)}\n└─ 合约报价 (1 ETH = ? mETH): ${prevContractStr}`;
            reportMsg += `\n\n--- 区块 [${latestBlock}] (最新 Oracle 报告) ---\n├─ 盘点计算 (1 ETH = ? mETH): ${ethers.formatUnits(latestData.calculatedEthToMeth, 18)}\n└─ 合约报价 (1 ETH = ? mETH): ${latestContractStr}`;
            reportMsg += `\n\n--- 主网当前最新实时报价 [补充实时块高: ${currentBlock}] ---\n└─ 合约报价 (1 ETH = ? mETH): ${currentContractStr}\n\n--- 状态防跌断言检查 ---`;

            let shouldAlert = false;
            const historicalValueDrop = (1 / parseFloat(prevContractStr)) - (1 / parseFloat(latestContractStr));

            if (historicalValueDrop > 0.0001) {
                reportMsg += `\n🚨 [P0 致命告警] 历史 Oracle 更新显示汇率异常下跌 (mETH 发生贬值，跌幅超阈值: ${historicalValueDrop.toFixed(6)})！`;
                shouldAlert = true;
            } else {
                reportMsg += historicalValueDrop > 0 ? `\n✅ 历史 Oracle 更新汇率微幅贬值 (跌幅: ${historicalValueDrop.toFixed(6)})，在 0.0001 容忍阈值内，业务健康。` : `\n✅ 历史 Oracle 更新汇率保持平稳或升值，符合预期。`;
            }

            const valueDrop = (1 / parseFloat(latestContractStr)) - (1 / parseFloat(currentContractStr));
            if (valueDrop > 0.001) {
                reportMsg += `\n🚨 [P0 致命告警] 当前实时合约 ethToMETH 报价差于上一次 Oracle 报告！mETH 发生贬值 (跌幅超阈值: ${valueDrop.toFixed(6)})！`;
                shouldAlert = true;
            } else {
                reportMsg += valueDrop > 0 ? `\n✅ 当前实时汇率相较于最新报告存在微幅贬值 (跌幅: ${valueDrop.toFixed(6)})，在 0.001 容忍阈值内，业务健康。` : `\n✅ 当前实时汇率相较于最新报告保持平稳或升值，业务健康。`;
            }

            console.log(reportMsg);

            if (shouldAlert) {
                console.log("\n⚠️ 满足告警条件，正在推送消息...");
                await triggerAlert(reportMsg);
                exitCode = 1; // 触发防跌告警，标记失败
            }
        }
    } catch (error) {
        console.error("❌ 探针执行失败:", error);
        exitCode = 1; // 异常报错，标记失败
    } finally {
        console.log("\n🏁 巡检结束，退出进程。");
        process.exit(exitCode);
    }
}

checkExchangeRate();