require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

// ==========================================
// 1. 基础配置与 RPC 节点初始化
// ==========================================
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    console.error("❌ 未找到 RPC_URL 环境变量，请检查 .env 文件。");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ==========================================
// 2. 核心合约地址配置
// ==========================================
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
        "function recordAt(uint256 idx) external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))",
        "function latestRecord() external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))"
    ],
    UnstakeRequestsManager: ["function balance() external view returns (uint256)"]
};

const methContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.mETH, provider);
const liquidityBufferContract = new ethers.Contract(ADDRESSES.LiquidityBuffer, ABIS.LiquidityBuffer, provider);
const stakingContract = new ethers.Contract(ADDRESSES.Staking, ABIS.Staking, provider);
const oracleContract = new ethers.Contract(ADDRESSES.Oracle, ABIS.Oracle, provider);
const unstakeMgrContract = new ethers.Contract(ADDRESSES.UnstakeRequestsManager, ABIS.UnstakeRequestsManager, provider);

// ==========================================
// 3. 辅助函数：计算指定区块的兑换率
// ==========================================
async function getExchangeRateAtBlock(blockNumber) {
    const overrides = blockNumber === 'latest' ? {} : { blockTag: blockNumber };
    const ONE_ETHER = 1000000000000000000n;

    const [
        totalSupply, stakingBal, availableBal, allocatedETH, totalDeposited,
        unstakeBal, historicalOracleRecord, contractEthToMeth
    ] = await Promise.all([
        methContract.totalSupply(overrides),
        provider.getBalance(ADDRESSES.Staking, blockNumber),
        liquidityBufferContract.getAvailableBalance(overrides),
        stakingContract.allocatedETHForDeposits(overrides),
        stakingContract.totalDepositedInValidators(overrides),
        unstakeMgrContract.balance(overrides),
        oracleContract.latestRecord(overrides),
        stakingContract.ethToMETH(ONE_ETHER, overrides)
    ]);

    const A = BigInt(stakingBal);
    const B = BigInt(availableBal);
    const C = BigInt(allocatedETH);
    const D = BigInt(totalDeposited);
    const G = BigInt(unstakeBal);
    const F = BigInt(historicalOracleRecord.currentTotalValidatorBalance || historicalOracleRecord[6]);
    const E = BigInt(historicalOracleRecord.cumulativeProcessedDepositAmount || historicalOracleRecord[7]);

    // 注意：这里的算法保留了你之前的盘点逻辑
    const H_TotalAssets = A + B + C + (D - E) + F + G;
    const calculatedEthToMeth = (BigInt(totalSupply) * ONE_ETHER) / H_TotalAssets;

    return {
        calculatedEthToMeth: calculatedEthToMeth,
        contractEthToMeth: BigInt(contractEthToMeth)
    };
}

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) {
        console.log("⚠️ 未配置 FEISHU_WEBHOOK，跳过发送告警。");
        return;
    }
    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("❌ 告警发送失败:", e.message));
}

// ==========================================
// 4. 核心逻辑：快照对账断言
// ==========================================
async function checkExchangeRate() {
    console.log(`\n[${new Date().toISOString()}] 🚀 启动兑换率快照巡检 (CI 定时版)...`);
    try {
        const recordsCount = await oracleContract.numRecords();

        if (recordsCount >= 2n) {
            const latestRecord = await oracleContract.recordAt(recordsCount - 1n);
            const previousRecord = await oracleContract.recordAt(recordsCount - 2n);
            const latestBlock = Number(latestRecord.updateEndBlock || latestRecord[1]);
            const previousBlock = Number(previousRecord.updateEndBlock || previousRecord[1]);

            // 并发获取过去两次 Oracle 更新时的状态，以及当下的最新状态和最新区块高
            const [prevData, latestData, currentContractEthToMeth, currentBlock] = await Promise.all([
                getExchangeRateAtBlock(previousBlock),
                getExchangeRateAtBlock(latestBlock),
                stakingContract.ethToMETH(1000000000000000000n),
                provider.getBlockNumber()
            ]);

            // 格式化数值用于打印和计算
            const prevCalcStr = ethers.formatUnits(prevData.calculatedEthToMeth, 18);
            const prevContractStr = ethers.formatUnits(prevData.contractEthToMeth, 18);

            const latestCalcStr = ethers.formatUnits(latestData.calculatedEthToMeth, 18);
            const latestContractStr = ethers.formatUnits(latestData.contractEthToMeth, 18);

            const currentContractStr = ethers.formatUnits(currentContractEthToMeth, 18);

            // 构造完整的报告文本
            let reportMsg = `🔍 [快照核查] 正在核算历史及当前实时兑换率...\n`;
            reportMsg += `\n--- 区块 [${previousBlock}] (历史) ---`;
            reportMsg += `\n├─ 盘点计算 (1 ETH = ? mETH): ${prevCalcStr}`;
            reportMsg += `\n└─ 合约报价 (1 ETH = ? mETH): ${prevContractStr}`;

            reportMsg += `\n\n--- 区块 [${latestBlock}] (最新 Oracle 报告) ---`;
            reportMsg += `\n├─ 盘点计算 (1 ETH = ? mETH): ${latestCalcStr}`;
            reportMsg += `\n└─ 合约报价 (1 ETH = ? mETH): ${latestContractStr}`;

            reportMsg += `\n\n--- 主网当前最新实时报价 [实时块高: ${currentBlock}] ---`;
            reportMsg += `\n└─ 合约报价 (1 ETH = ? mETH): ${currentContractStr}`;

            reportMsg += `\n\n--- 状态防跌断言检查 ---`;

            let shouldAlert = false;
            let alertLevel = "";

            // 断言 1: 历史到最新报告的汇率是否健康
            if (latestData.calculatedEthToMeth > prevData.calculatedEthToMeth || latestData.contractEthToMeth > prevData.contractEthToMeth) {
                alertLevel = "🚨 [P0 致命告警] 历史 Oracle 更新显示汇率异常下跌 (mETH 贬值)！";
                reportMsg += `\n${alertLevel}`;
                shouldAlert = true;
            } else {
                reportMsg += `\n✅ 历史 Oracle 更新汇率单调递减 (升值)，符合预期。`;
            }

            // 断言 2: 计算 1 mETH 的 ETH 价值贬值幅度
            // 数学逻辑: ethToMETH 是 1 ETH 换多少 mETH，所以 1 / ethToMETH 就是 1 mETH 等于多少 ETH。
            // 如果 mETH 贬值，旧的价值会大于新的价值，两者的差值即为跌幅。
            const latestMethValueInEth = 1 / parseFloat(latestContractStr);
            const currentMethValueInEth = 1 / parseFloat(currentContractStr);
            const valueDrop = latestMethValueInEth - currentMethValueInEth;

            // 如果贬值幅度超过 0.001 ETH
            if (valueDrop > 0.001) {
                alertLevel = `🚨 [P0 致命告警] 当前实时合约 ethToMETH 报价差于上一次 Oracle 报告！mETH 发生贬值 (跌幅超阈值: ${valueDrop.toFixed(6)})！`;
                reportMsg += `\n${alertLevel}`;
                shouldAlert = true;
            } else {
                // 如果微幅贬值但在阈值内，或者正常升值
                if (valueDrop > 0) {
                    reportMsg += `\n✅ 当前实时汇率相较于最新报告存在微幅贬值 (跌幅: ${valueDrop.toFixed(6)})，在 0.001 容忍阈值内，业务健康。`;
                } else {
                    reportMsg += `\n✅ 当前实时汇率相较于最新报告保持平稳或升值，业务健康。`;
                }
            }

            // 在控制台打印完整日志
            console.log(reportMsg);

            // 触发飞书告警 (把上下文一并带上)
            if (shouldAlert) {
                console.log("\n⚠️ 满足告警条件，正在推送消息...");
                await triggerAlert(reportMsg);
            }

        } else {
            console.log(`📌 Oracle 记录不足两条，跳过对账。`);
        }

    } catch (error) {
        console.error("❌ 探针执行失败:", error);
    } finally {
        // CI 模式：执行完毕后立刻强制退出进程，不留后台
        console.log("\n🏁 巡检结束，退出进程。");
        process.exit(0);
    }
}

checkExchangeRate();