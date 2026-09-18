require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    console.error("❌ 未找到 RPC_URL 环境变量，请检查 .env 文件。");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL, 1, { staticNetwork: true });

const ADDRESSES = {
    LiquidityBuffer: '0x006FaD88c35D973A87E451CF8D000c7e83Dad409',
    UnstakeRequestsManager: '0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9'
};

const ABIS = {
    LiquidityBuffer: ["function getAvailableBalance() external view returns (uint256)"],
    UnstakeRequestsManager: ["function balance() external view returns (uint256)", "function allocatedETHDeficit() external view returns (uint256)"]
};

const liquidityBufferContract = new ethers.Contract(ADDRESSES.LiquidityBuffer, ABIS.LiquidityBuffer, provider);
const unstakeMgrContract = new ethers.Contract(ADDRESSES.UnstakeRequestsManager, ABIS.UnstakeRequestsManager, provider);

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, { msg_type: "text", content: { text: message } }).catch(e => console.error("告警发送失败:", e.message));
}

async function checkLiquidityRunRisk() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在执行解押流动性风险评估...`);
    let exitCode = 0; // 默认成功

    try {
        const bufferAvailableBal = await liquidityBufferContract.getAvailableBalance();
        const managerBalance = await unstakeMgrContract.balance();
        const managerDeficit = await unstakeMgrContract.allocatedETHDeficit();

        const bufferBal = BigInt(bufferAvailableBal);
        const managerBal = BigInt(managerBalance);
        const deficit = BigInt(managerDeficit);

        const totalPendingDemand = deficit + managerBal;
        const buffer80Percent = (bufferBal * 80n) / 100n;
        const warningThreshold = buffer80Percent + managerBal;

        console.log(`📊 解押流动性核对单:`);
        console.log(`   ├─ [资金池] LiquidityBuffer 可用余额 : ${ethers.formatEther(bufferBal)} ETH`);
        console.log(`   ├─ [解押池] Manager 已备付余额       : ${ethers.formatEther(managerBal)} ETH`);
        console.log(`   ├─ [需求端] 当前解押资金总缺口       : ${ethers.formatEther(deficit)} ETH`);
        console.log(`   └─ [需求端] Pending 解押总需求额度   : ${ethers.formatEther(totalPendingDemand)} ETH`);
        console.log(`   👉 当前挤兑告警阈值界线              : ${ethers.formatEther(warningThreshold)} ETH`);

        if (totalPendingDemand > warningThreshold) {
            const exceededAmount = totalPendingDemand - warningThreshold;
            const warningMsg = `🚨 [P1 流动性告警] 解押队列出现挤兑风险！\n当前 Pending 解押总需求已突破流动性安全红线。\n超出安全水位: ${ethers.formatEther(exceededAmount)} ETH\n请立刻评估是否需要从信标链发起验证者退出！`;
            console.warn(warningMsg);
            await triggerAlert(warningMsg);
            exitCode = 1; // 触发挤兑告警，标记失败
        } else {
            console.log(`✅ 流动性充裕。当前 Pending 额度在 Buffer 80% 安全水位之内。`);
        }

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        await triggerAlert(`解押流动性探针异常，请检查网络节点！错误信息: ${error.message}`);
        exitCode = 1; // 异常报错，标记失败
    } finally {
        process.exit(exitCode);
    }
}

// 直接运行一次即结束，不再使用 setInterval 造成 6 小时卡死
checkLiquidityRunRisk();