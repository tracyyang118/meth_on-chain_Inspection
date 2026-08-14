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
    LiquidityBuffer: '0x006FaD88c35D973A87E451CF8D000c7e83Dad409',
    UnstakeRequestsManager: '0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9'
};

// ==========================================
// 3. 提取只读 ABI
// ==========================================
const ABIS = {
    LiquidityBuffer: [
        // 获取缓冲池可用余额[cite: 20]
        "function getAvailableBalance() external view returns (uint256)"
    ],
    UnstakeRequestsManager: [
        // 获取已分配但未领取的 ETH 余额[cite: 18]
        "function balance() external view returns (uint256)",
        // 获取当前解押队列的 ETH 缺口[cite: 18]
        "function allocatedETHDeficit() external view returns (uint256)"
    ]
};

// ==========================================
// 4. 实例化合约
// ==========================================
const liquidityBufferContract = new ethers.Contract(ADDRESSES.LiquidityBuffer, ABIS.LiquidityBuffer, provider);
const unstakeMgrContract = new ethers.Contract(ADDRESSES.UnstakeRequestsManager, ABIS.UnstakeRequestsManager, provider);

// 飞书告警 Webhook 发送模块
async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;

    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("告警发送失败:", e.message));
}

// ==========================================
// 5. 核心逻辑：流动性挤兑风险评估
// ==========================================
async function checkLiquidityRunRisk() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在执行解押流动性风险评估...`);

    try {
        // 并发读取链上流动性状态
        const [
            bufferAvailableBal,
            managerBalance,
            managerDeficit
        ] = await Promise.all([
            liquidityBufferContract.getAvailableBalance(),    // LiquidityBuffer.balance[cite: 20]
            unstakeMgrContract.balance(),                     // UnstakeRequestsManager.Balance[cite: 18]
            unstakeMgrContract.allocatedETHDeficit()          // 还缺多少 ETH 才能满足所有解押[cite: 18]
        ]);

        const bufferBal = BigInt(bufferAvailableBal);
        const managerBal = BigInt(managerBalance);
        const deficit = BigInt(managerDeficit);

        // -----------------------------------------------------------
        // 计算指标
        // -----------------------------------------------------------
        // 1. Pending 状态的总需求额度 = 当前资金缺口 + 已经分配准备给用户 Claim 的资金
        const totalPendingDemand = deficit + managerBal;

        // 2. Buffer 余额的 80% (使用 BigInt 的乘除法)
        const buffer80Percent = (bufferBal * 80n) / 100n;

        // 3. 告警阈值 = Buffer 余额 * 80% + UnstakeRequestsManager.Balance
        const warningThreshold = buffer80Percent + managerBal;

        // 格式化输出对账单
        console.log(`📊 解押流动性核对单:`);
        console.log(`   ├─ [资金池] LiquidityBuffer 可用余额 : ${ethers.formatEther(bufferBal)} ETH`);
        console.log(`   ├─ [解押池] Manager 已备付余额       : ${ethers.formatEther(managerBal)} ETH`);
        console.log(`   ├─ [需求端] 当前解押资金总缺口       : ${ethers.formatEther(deficit)} ETH`);
        console.log(`   └─ [需求端] Pending 解押总需求额度   : ${ethers.formatEther(totalPendingDemand)} ETH`);

        console.log(`   👉 当前挤兑告警阈值界线              : ${ethers.formatEther(warningThreshold)} ETH`);

        // -----------------------------------------------------------
        // 🚨 核心断言：流动性挤兑预警 (P1 警告)
        // 逻辑：Pending 额度 > Buffer 余额 * 80% + UnstakeRequestsManager.Balance
        // -----------------------------------------------------------
        if (totalPendingDemand > warningThreshold) {
            // 计算超出安全水位多少
            const exceededAmount = totalPendingDemand - warningThreshold;

            const warningMsg =
                `🚨 [P1 流动性告警] 解押队列出现挤兑风险！\n` +
                `当前 Pending 解押总需求（${ethers.formatEther(totalPendingDemand)} ETH）已突破流动性安全红线。\n` +
                `超出安全水位: ${ethers.formatEther(exceededAmount)} ETH\n` +
                `请立刻评估是否需要从信标链发起验证者退出 (Validator Exit) 操作以补充流动性！`;

            console.warn(warningMsg);
            await triggerAlert(warningMsg);
        } else {
            console.log(`✅ 流动性充裕。当前 Pending 额度在 Buffer 80% 安全水位之内。`);
        }

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        await triggerAlert(`解押流动性探针异常，请检查网络节点！错误信息: ${error.message}`);
    }
}

// 立即执行一次
checkLiquidityRunRisk();

// ==========================================
// 6. 设置执行频率：每 15 分钟循环执行一次
// ==========================================
//const FIFTEEN_MINUTES = 15 * 60 * 1000;
//setInterval(checkLiquidityRunRisk, FIFTEEN_MINUTES);
console.log(`🎧 流动性挤兑监控已启动 (每 15 分钟巡检一次，按 Ctrl+C 退出)...`);