require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');

// ==========================================
// 1. 基础配置与多链 RPC 节点初始化
// ==========================================
// 此脚本需要同时连接以太坊 (L1) 和 Mantle (L2) 的 RPC 节点
const RPC_URL = process.env.RPC_URL; // 已修改为直接使用 RPC_URL
const L2_RPC_URL = process.env.L2_RPC_URL;

if (!RPC_URL || !L2_RPC_URL) {
    console.error("❌ 未找到 RPC_URL 或 L2_RPC_URL 环境变量，请检查 .env 文件。");
    console.log("💡 提示: 请在 .env 中补充 L2_RPC_URL='https://rpc.mantle.xyz'");
    process.exit(1);
}

const l1Provider = new ethers.JsonRpcProvider(RPC_URL);
const l2Provider = new ethers.JsonRpcProvider(L2_RPC_URL);

// ==========================================
// 2. 核心跨链合约地址配置
// ==========================================
const ADDRESSES = {
    // L1 (Ethereum)
    L1mETH: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa',
    L1Adapter: '0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d', // 负责锁定 L1 资产的跨链桥适配器

    // L2 (Mantle)
    L2mETH: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0'
};

// ==========================================
// 3. 提取只读 ABI
// ==========================================
const ABIS = {
    ERC20: [
        "function balanceOf(address account) external view returns (uint256)",
        "function totalSupply() external view returns (uint256)"
    ]
};

// ==========================================
// 4. 实例化合约
// ==========================================
const l1MethContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.ERC20, l1Provider);
const l2MethContract = new ethers.Contract(ADDRESSES.L2mETH, ABIS.ERC20, l2Provider);

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
// 5. 核心逻辑：跨链账本对账与防超发断言
// ==========================================
async function checkCrossChainPeg() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在执行 L1-L2 跨链账本一致性对账...`);

    try {
        // 并发读取 L1 锁定余额和 L2 发行总量
        const [
            l1LockedBalance,
            l2TotalSupply,
            l1Block,
            l2Block
        ] = await Promise.all([
            l1MethContract.balanceOf(ADDRESSES.L1Adapter), // L1 实际锁定的 mETH
            l2MethContract.totalSupply(),                  // L2 凭空映射的 mETH
            l1Provider.getBlockNumber(),
            l2Provider.getBlockNumber()
        ]);

        const locked = BigInt(l1LockedBalance);
        const supply = BigInt(l2TotalSupply);

        console.log(`📊 跨链资产核对单:`);
        console.log(`   ├─ [L1 Ethereum] 当前区块 : ${l1Block}`);
        console.log(`   ├─ [L2 Mantle]   当前区块 : ${l2Block}`);
        console.log(`   ├─ [L1 资产端] 桥内锁定 : ${ethers.formatEther(locked)} mETH`);
        console.log(`   └─ [L2 负债端] 网络总发行 : ${ethers.formatEther(supply)} mETH`);

        // 计算差值 (在途资金)
        const inTransit = locked - supply;

        console.log(`   👉 跨链在途资金差值       : ${ethers.formatEther(inTransit)} mETH`);

        // -----------------------------------------------------------
        // 🚨 核心断言 1：防止 Infinite Mint 漏洞 (P0 致命告警)
        // 逻辑：L2 铸造的代币绝不能超过 L1 锁定的代币
        // -----------------------------------------------------------
        if (supply > locked) {
            const deficit = supply - locked;
            const errorMsg =
                `🚨 [P0 致命告警] 跨链桥脱锚！发现 L2 恶意增发！\n` +
                `L2 mETH 发行量超过了 L1 真实锁定资产。\n` +
                `凭空超发数量: ${ethers.formatEther(deficit)} mETH\n` +
                `请立即联系安全团队，并拉起跨链桥熔断机制！`;

            console.error(errorMsg);
            await triggerAlert(errorMsg);
            return; // 发生致命错误，直接中断后续检查
        }

        // -----------------------------------------------------------
        // 🚨 核心断言 2：跨链消息卡顿预警 (P2 警告)
        // 逻辑：在途资金差值过大，说明用户跨链充提严重拥堵
        // -----------------------------------------------------------
        // 设定容忍阈值，例如 50 mETH (代表可能由于区块时间差导致的在途资金)
        // 您可以根据业务日常的跨链水位调整这个阈值
        const IN_TRANSIT_THRESHOLD = ethers.parseEther("50.0");

        if (inTransit > IN_TRANSIT_THRESHOLD) {
            const warningMsg =
                `⚠️ [P2 警告] 跨链在途资金过高。\n` +
                `当前有 ${ethers.formatEther(inTransit)} mETH 锁定在 L1 但 L2 尚未铸造（或已在 L2 销毁但 L1 尚未解锁）。\n` +
                `请检查 Mantle Bridge Relayer (中继器) 是否工作正常。`;

            console.warn(warningMsg);
            await triggerAlert(warningMsg);
        } else {
            console.log(`✅ 跨链账本对齐成功。`);
            if (inTransit === 0n) {
                console.log(`   完美 1:1 锚定，当前无在途跨链消息。`);
            } else {
                console.log(`   差值在安全阈值（50 mETH）内，属于正常的在途跨链请求。`);
            }
        }

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        await triggerAlert(`L1-L2 跨链对账探针异常，请检查网络节点！错误信息: ${error.message}`);
    }
}

// 立即执行一次
checkCrossChainPeg();