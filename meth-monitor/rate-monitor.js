require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

// ==========================================
// 1. 基础配置与 RPC 节点初始化
// ==========================================
const RPC_URL = process.env.WSS_URL || process.env.RPC_URL;
if (!RPC_URL) {
    console.error("❌ 未找到 RPC_URL 或 WSS_URL 环境变量，请检查 .env 文件。");
    process.exit(1);
}

const provider = RPC_URL.startsWith('wss')
    ? new ethers.WebSocketProvider(RPC_URL)
    : new ethers.JsonRpcProvider(RPC_URL);

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

// ==========================================
// 3. 提取所有关联变量的只读 ABI 与事件
// ==========================================
const ABIS = {
    mETH: [
        "function totalSupply() view returns (uint256)"
    ],
    LiquidityBuffer: [
        "function getAvailableBalance() external view returns (uint256)"
    ],
    Staking: [
        "function totalDepositedInValidators() external view returns (uint256)",
        "function allocatedETHForDeposits() external view returns (uint256)",
        // 官方提供的 1 ETH 兑换 mETH 的报价方法
        "function ethToMETH(uint256 _ethAmount) external view returns (uint256)"
    ],
    Oracle: [
        "function numRecords() external view returns (uint256)",
        "function recordAt(uint256 idx) external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))",
        "function latestRecord() external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))",
        "event ExchangeRateUpdated(uint256 newRate)"
    ],
    UnstakeRequestsManager: [
        "function balance() external view returns (uint256)"
    ]
};

// ==========================================
// 4. 实例化合约
// ==========================================
const methContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.mETH, provider);
const liquidityBufferContract = new ethers.Contract(ADDRESSES.LiquidityBuffer, ABIS.LiquidityBuffer, provider);
const stakingContract = new ethers.Contract(ADDRESSES.Staking, ABIS.Staking, provider);
const oracleContract = new ethers.Contract(ADDRESSES.Oracle, ABIS.Oracle, provider);
const unstakeMgrContract = new ethers.Contract(ADDRESSES.UnstakeRequestsManager, ABIS.UnstakeRequestsManager, provider);

// ==========================================
// 5. 辅助函数：计算并查询指定区块的兑换率 (1 ETH = ? mETH)
// ==========================================
async function getExchangeRateAtBlock(blockNumber) {
    const overrides = { blockTag: blockNumber };
    const ONE_ETHER = 1000000000000000000n; // 1 ETH (1e18)

    // 并发查询该历史区块下的底层资产，同时调用 ethToMETH(1 ETH)
    const [
        totalSupply,
        stakingBal,
        availableBal,
        allocatedETH,
        totalDeposited,
        unstakeBal,
        historicalOracleRecord,
        contractEthToMeth // 从 Staking 合约中读取的官方 ethToMETH
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

    // H = A + B + C + (D - E) + F + G (总储备 ETH 资产)
    const H_TotalAssets = A + B + C + (D - E) + F + G;

    // 反向计算：1 ETH 能换多少 mETH = (TotalSupply * 1e18) / H_TotalAssets
    const calculatedEthToMeth = (BigInt(totalSupply) * ONE_ETHER) / H_TotalAssets;

    return {
        calculatedEthToMeth: calculatedEthToMeth,
        contractEthToMeth: BigInt(contractEthToMeth)
    };
}

// ==========================================
// 6. 飞书告警 Webhook 发送模块
// ==========================================
async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("告警发送失败:", e.message));
}

// ==========================================
// 7. 核心监控引擎 (回溯 + 监听)
// ==========================================
async function startMonitoring() {
    console.log(`[${new Date().toISOString()}] 🚀 启动 Oracle 记录回溯与实时监听探针...`);

    let previousContractRateBaseline = 0n; // 记录合约 ethToMETH 的历史值

    try {
        // -----------------------------------------------------------
        // 阶段 1：回溯最近的两条 Oracle 记录
        // -----------------------------------------------------------
        const recordsCount = await oracleContract.numRecords();
        console.log(`📚 当前 Oracle 链上总记录数: ${recordsCount}`);

        if (recordsCount >= 2n) {
            const latestRecord = await oracleContract.recordAt(recordsCount - 1n);
            const previousRecord = await oracleContract.recordAt(recordsCount - 2n);

            const latestBlock = Number(latestRecord.updateEndBlock || latestRecord[1]);
            const previousBlock = Number(previousRecord.updateEndBlock || previousRecord[1]);

            console.log(`\n🔍 [历史回溯] 正在计算历史区块的盘点汇率，并读取合约 ethToMETH 报价...`);

            try {
                const prevData = await getExchangeRateAtBlock(previousBlock);
                const latestData = await getExchangeRateAtBlock(latestBlock);

                console.log(`\n   --- 区块 [${previousBlock}] 历史基准 ---`);
                console.log(`   ├─ 手动盘点计算 (1 ETH = ? mETH): ${ethers.formatUnits(prevData.calculatedEthToMeth, 18)}`);
                console.log(`   └─ 合约官方读取 (1 ETH = ? mETH): ${ethers.formatUnits(prevData.contractEthToMeth, 18)}`);

                console.log(`\n   --- 区块 [${latestBlock}] 最新基准 ---`);
                console.log(`   ├─ 手动盘点计算 (1 ETH = ? mETH): ${ethers.formatUnits(latestData.calculatedEthToMeth, 18)}`);
                console.log(`   └─ 合约官方读取 (1 ETH = ? mETH): ${ethers.formatUnits(latestData.contractEthToMeth, 18)}`);

                console.log(`\n   --- 状态防跌断言检查 ---`);

                // 1. 断言手动计算的 1 ETH 兑换 mETH 的数量是否单调递减（变少代表升值）
                if (latestData.calculatedEthToMeth > prevData.calculatedEthToMeth) {
                    console.log(`   🚨 致命警告: 手动盘点显示 1 ETH 换出的 mETH 变多了 (mETH 贬值)！`);
                } else {
                    console.log(`   ✅ 手动盘点计算显示 1 ETH 换出的 mETH 越来越少 (单调递减/持平)，符合升值预期。`);
                }

                // 2. 断言合约返回的官方 ethToMETH 数量是否单调递减
                if (latestData.contractEthToMeth > prevData.contractEthToMeth) {
                    console.log(`   🚨 致命警告: 合约 ethToMETH 换出的数量竟然变多了，说明净值遭到破坏！`);
                } else {
                    console.log(`   ✅ 合约 ethToMETH 官方报价单调递减或持平，业务状态健康。`);
                }

                // 将最新的合约读取值设为后续实时监听的基准
                previousContractRateBaseline = latestData.contractEthToMeth;

            } catch (err) {
                console.log(`   ⚠️ 历史数据读取失败 (可能 RPC 不支持归档节点访问): ${err.message}`);
                previousContractRateBaseline = 0n;
            }
        } else {
            console.log(`📌 Oracle 记录不足两条，跳过历史回溯。`);
        }

        // -----------------------------------------------------------
        // 阶段 2：无缝切换为实时事件监听
        // -----------------------------------------------------------
        console.log(`\n🎧 正在监听 Oracle 合约的新事件 (Ctrl+C 退出)...`);

        oracleContract.on("ExchangeRateUpdated", async (newRate, event) => {
            try {
                const txHash = event.log.transactionHash;
                const blockNumber = event.log.blockNumber;

                console.log(`\n[${new Date().toISOString()}] 🔔 监听到 ExchangeRateUpdated 更新事件!`);

                // 事件触发后，立刻读取当前最新区块的合约 ethToMETH
                const ONE_ETHER = 1000000000000000000n;
                const currentContractEthToMeth = await stakingContract.ethToMETH(ONE_ETHER);

                console.log(`   ├─ 区块高度: ${blockNumber}`);
                console.log(`   ├─ 交易哈希: ${txHash}`);
                console.log(`   └─ 链上最新 ethToMETH: ${ethers.formatUnits(currentContractEthToMeth, 18)} mETH`);

                if (previousContractRateBaseline === 0n) {
                    console.log(`📌 初始化实时基准汇率...`);
                    previousContractRateBaseline = currentContractEthToMeth;
                    return;
                }

                // 🚨 实时单调性断言 (1 ETH 换出的 mETH 绝不允许变多)
                if (currentContractEthToMeth > previousContractRateBaseline) {
                    const diff = currentContractEthToMeth - previousContractRateBaseline;
                    const errorMsg =
                        `🚨 [P0 致命告警] ethToMETH 报价异常上涨（mETH 贬值打破单调性）！\n` +
                        `历史 ethToMETH: ${ethers.formatUnits(previousContractRateBaseline, 18)}\n` +
                        `最新 ethToMETH: ${ethers.formatUnits(currentContractEthToMeth, 18)}\n` +
                        `异常多出差值: ${ethers.formatUnits(diff, 18)} mETH\n` +
                        `交易哈希: ${txHash}`;

                    console.error(errorMsg);
                    await triggerAlert(errorMsg);
                } else {
                    console.log("✅ 实时单调性验证通过 (ethToMETH 递减或持平)。");
                }

                previousContractRateBaseline = currentContractEthToMeth;

            } catch (error) {
                console.error("❌ 处理事件时发生错误:", error);
            }
        });

    } catch (error) {
        console.error("❌ 探针初始化失败，请检查网络或合约地址:", error);
    }
}

// ==========================================
// 8. 优雅退出机制与启动
// ==========================================
process.on('SIGINT', () => {
    console.log("\n🛑 接收到中断信号，正在关闭事件监听器并退出...");
    oracleContract.removeAllListeners();
    process.exit(0);
});

startMonitoring();