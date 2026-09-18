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
        "function allocatedETHForDeposits() external view returns (uint256)"
    ],
    Oracle: [
        "function latestRecord() external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))"
    ],
    UnstakeRequestsManager: ["function balance() external view returns (uint256)"]
};

const methContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.mETH, provider);
const liquidityBufferContract = new ethers.Contract(ADDRESSES.LiquidityBuffer, ABIS.LiquidityBuffer, provider);
const stakingContract = new ethers.Contract(ADDRESSES.Staking, ABIS.Staking, provider);
const oracleContract = new ethers.Contract(ADDRESSES.Oracle, ABIS.Oracle, provider);
const unstakeMgrContract = new ethers.Contract(ADDRESSES.UnstakeRequestsManager, ABIS.UnstakeRequestsManager, provider);

async function checkBackingInvariant() {
    console.log(`[${new Date().toISOString()}] 🔍 正在获取链上状态并计算底层资产...`);
    let exitCode = 0; // 默认成功
    try {
        const [
            totalSupply, stakingBalance, availableBalance, allocatedETH, totalDeposited, oracleRecord, unstakeBalance
        ] = await Promise.all([
            methContract.totalSupply(),
            provider.getBalance(ADDRESSES.Staking),
            liquidityBufferContract.getAvailableBalance(),
            stakingContract.allocatedETHForDeposits(),
            stakingContract.totalDepositedInValidators(),
            oracleContract.latestRecord(),
            unstakeMgrContract.balance()
        ]);

        const F = BigInt(oracleRecord.currentTotalValidatorBalance || oracleRecord[6]);
        const E = BigInt(oracleRecord.cumulativeProcessedDepositAmount || oracleRecord[7]);
        const A = BigInt(stakingBalance);
        const B = BigInt(availableBalance);
        const C = BigInt(allocatedETH);
        const D = BigInt(totalDeposited);
        const G = BigInt(unstakeBalance);

        const H_TotalAssets = A + B + C + (D - E) + F + G;
        const totalLiabilitiesFloor = BigInt(totalSupply);

        console.log(`📊 [负债端] mETH 总发行量: ${ethers.formatEther(totalLiabilitiesFloor)} mETH`);
        console.log(`💰 [资产端] 储备总计 (H)  : ${ethers.formatEther(H_TotalAssets)} ETH`);
        console.log(`   ├─ [A] 待分配原生余额   : ${ethers.formatEther(A)} ETH (Staking)`);
        console.log(`   ├─ [B] 缓冲池可用余额   : ${ethers.formatEther(B)} ETH (LiquidityBuffer)`);
        console.log(`   ├─ [C] 待存入验证者额度 : ${ethers.formatEther(C)} ETH`);
        console.log(`   ├─ [D] 已发送存款总额   : ${ethers.formatEther(D)} ETH`);
        console.log(`   ├─ [E] 信标链已处理存款 : ${ethers.formatEther(E)} ETH`);
        console.log(`   ├─ [F] 信标链验证者余额 : ${ethers.formatEther(F)} ETH`);
        console.log(`   └─ [G] 未领取解押余额   : ${ethers.formatEther(G)} ETH`);
        console.log(`   👉 (D - E) 在途存款差值 : ${ethers.formatEther(D - E)} ETH`);

        if (H_TotalAssets < totalLiabilitiesFloor) {
            const deficit = totalLiabilitiesFloor - H_TotalAssets;
            const errorMsg = `🚨 [P0 致命告警] 储备金脱锚！总资产 (H) 小于发行的 mETH 总量！资金缺口: ${ethers.formatEther(deficit)} ETH`;
            console.error(errorMsg);
            await triggerAlert(errorMsg);
            exitCode = 1; // 触发告警，标记失败
        } else {
            console.log("✅ 储备金对账成功，底层综合资产能够足额覆盖发行的 mETH。");
        }

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        await triggerAlert(`巡检探针异常，请检查！错误信息: ${error.message}`);
        exitCode = 1; // 异常报错，标记失败
    } finally {
        process.exit(exitCode);
    }
}

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, { msg_type: "text", content: { text: message } }).catch(e => console.error("告警发送失败:", e.message));
}

checkBackingInvariant();