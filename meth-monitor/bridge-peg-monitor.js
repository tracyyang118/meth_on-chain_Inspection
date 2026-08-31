require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==========================================
// 1. 基础配置与多链 RPC 节点初始化
// ==========================================
const RPC_URL = process.env.RPC_URL;
const L2_RPC_URL = process.env.L2_RPC_URL;

if (!RPC_URL || !L2_RPC_URL) {
    console.error("❌ 未找到 RPC_URL 或 L2_RPC_URL 环境变量，请检查 .env 文件。");
    process.exit(1);
}

const l1Provider = new ethers.JsonRpcProvider(RPC_URL);
const l2Provider = new ethers.JsonRpcProvider(L2_RPC_URL);

// 状态文件路径 (持久化记录增量区块和在途资金)
const STATE_FILE = path.join(__dirname, 'sync-state.json');

// ==========================================
// 2. 核心跨链合约地址配置
// ==========================================
const ADDRESSES = {
    // --- L1 (Ethereum) 资产端 ---
    L1mETH: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa',
    L1Adapter: '0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d',               // 1. mETH 专用跨链桥适配器
    MantleOfficialBridge: '0x95fc37a27a2f68e3a647cdc081f0a89bb47c3012', // 2. Mantle 官方通用跨链桥 (分流的锁仓)

    // --- L2 (Mantle) 负债端 ---
    L2mETH: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0',
    L2MantleBridge: '0x4200000000000000000000000000000000000010'        // 3. Mantle L2 官方跨链桥 (创世系统合约)
};

// ==========================================
// 3. 提取只读 ABI
// ==========================================
const ABIS = {
    ERC20: [
        "function balanceOf(address account) external view returns (uint256)",
        "function totalSupply() external view returns (uint256)"
    ],
    // 跨链桥出入金事件
    BridgeEvents: [
        "event ERC20WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
        "event ERC20WithdrawalFinalized(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)"
    ]
};

// ==========================================
// 4. 实例化合约
// ==========================================
const l1MethContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.ERC20, l1Provider);
const l2MethContract = new ethers.Contract(ADDRESSES.L2mETH, ABIS.ERC20, l2Provider);
const l1BridgeContract = new ethers.Contract(ADDRESSES.MantleOfficialBridge, ABIS.BridgeEvents, l1Provider);
const l2BridgeContract = new ethers.Contract(ADDRESSES.L2MantleBridge, ABIS.BridgeEvents, l2Provider);

// ==========================================
// 5. 辅助函数
// ==========================================
async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;

    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("告警发送失败:", e.message));
}

// 增量状态读写 (本地 JSON 存储)
// ⚠️ 如果在 GitHub Actions 中运行，请确保持久化该文件状态（如使用 actions/cache 或 Redis）
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    return null;
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ==========================================
// 6. 核心逻辑：精准量化对账与双重断言
// ==========================================
async function checkCrossChainPeg() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在执行 L1-L2 增量跨链对账...`);

    try {
        // 6.1 并发读取宏观状态
        const [
            l1AdapterBalance,
            l1MantleBridgeBalance,
            l2TotalSupply,
            l1Block,
            l2Block
        ] = await Promise.all([
            l1MethContract.balanceOf(ADDRESSES.L1Adapter),
            l1MethContract.balanceOf(ADDRESSES.MantleOfficialBridge),
            l2MethContract.totalSupply(),
            l1Provider.getBlockNumber(),
            l2Provider.getBlockNumber()
        ]);

        const l1AdapterLocked = BigInt(l1AdapterBalance);
        const l1MantleBridgeLocked = BigInt(l1MantleBridgeBalance);

        // 跨链桥真实锁仓支撑总量 = 专用桥 + 通用桥
        const totalL1Locked = l1AdapterLocked + l1MantleBridgeLocked;
        const supply = BigInt(l2TotalSupply);

        console.log(`📊 宏观资产核对单:`);
        console.log(`   ├─ [L1 Ethereum] 当前区块 : ${l1Block}`);
        console.log(`   ├─ [L2 Mantle]   当前区块 : ${l2Block}`);
        console.log(`   ├─ [L1 mETH 专用桥锁仓]   : ${ethers.formatEther(l1AdapterLocked)} mETH`);
        console.log(`   ├─ [L1 Mantle 官方桥锁仓] : ${ethers.formatEther(l1MantleBridgeLocked)} mETH`);
        console.log(`   ├─ [L1 总支撑储备资产]    : ${ethers.formatEther(totalL1Locked)} mETH`);
        console.log(`   └─ [L2 实际网络总发行]    : ${ethers.formatEther(supply)} mETH`);

        // 实际在途资金 = 总资产 - 负债
        const actualInTransit = totalL1Locked - supply;

        console.log(`   👉 跨链在途资金差值       : ${ethers.formatEther(actualInTransit)} mETH`);

        // -----------------------------------------------------------
        // 🚨 核心断言 1：系统失血漏洞 (P0 致命告警) - L1 < L2
        // -----------------------------------------------------------
        if (actualInTransit < 0n) {
            const deficit = supply - totalL1Locked;
            const errorMsg =
                `🚨 [P0 致命告警] 跨链桥脱锚！发现 L2 恶意增发！\n` +
                `L2 mETH 发行量超过了 L1 真实储备资产（专用桥+官方桥）的总和。\n` +
                `物理储备已被击穿，凭空超发: ${ethers.formatEther(deficit)} mETH\n` +
                `请立即拉起跨链桥熔断机制阻断提现！`;

            console.error(errorMsg);
            await triggerAlert(errorMsg);
            return;
        }

        // -----------------------------------------------------------
        // ⚠️ 核心断言 2：业务拥堵红线 (P1 警告) - 排队 > 1000
        // -----------------------------------------------------------
        const MAX_PENDING_THRESHOLD = ethers.parseEther("1000.0");
        if (actualInTransit > MAX_PENDING_THRESHOLD) {
            const warningMsg =
                `⚠️ [P1 拥堵告警] 跨链排队资金突破 1000 mETH 红线！\n` +
                `当前在途积压: ${ethers.formatEther(actualInTransit)} mETH。\n` +
                `请检查 Mantle Bridge Relayer 是否停摆，或是否发生大规模用户离场挤兑。`;

            console.warn(warningMsg);
            await triggerAlert(warningMsg);
        }

        // -----------------------------------------------------------
        // 🔍 核心对账 3：增量记账法验证资金去向
        // -----------------------------------------------------------
        const state = loadState();

        // 第一次运行，初始化账本
        if (!state) {
            console.log(`\n初始化账本：初次运行，记录当前区块与基准在途资金...`);
            saveState({
                lastL1Block: l1Block,
                lastL2Block: l2Block,
                theoreticalInTransit: actualInTransit.toString()
            });
            console.log(`✅ 账本初始化完成，等待下一次巡检进行增量对账。`);
            return;
        }

        console.log(`\n🔍 开始增量事件对账 (核对范围: L1[${state.lastL1Block}-${l1Block}], L2[${state.lastL2Block}-${l2Block}])`);

        // 1. 拉取 L2 新发起的提现 (会让在途增加)
        const initiatedFilter = l2BridgeContract.filters.ERC20WithdrawalInitiated(ADDRESSES.L1mETH);
        const initiatedEvents = await l2BridgeContract.queryFilter(initiatedFilter, state.lastL2Block + 1, l2Block);

        let newPendingAmount = 0n;
        initiatedEvents.forEach(e => newPendingAmount += e.args.amount);

        // 2. 拉取 L1 已完成的提现 (会让在途减少)
        const finalizedFilter = l1BridgeContract.filters.ERC20WithdrawalFinalized(ADDRESSES.L1mETH);
        const finalizedEvents = await l1BridgeContract.queryFilter(finalizedFilter, state.lastL1Block + 1, l1Block);

        let claimedAmount = 0n;
        finalizedEvents.forEach(e => claimedAmount += e.args.amount);

        // 3. 计算理论应有资金
        const prevTheoretical = BigInt(state.theoreticalInTransit);
        const currentTheoretical = prevTheoretical + newPendingAmount - claimedAmount;

        console.log(`   ├─ [上次结转在途] : ${ethers.formatEther(prevTheoretical)} mETH`);
        console.log(`   ├─ [+] 期间新增排队 : ${ethers.formatEther(newPendingAmount)} mETH (${initiatedEvents.length} 笔)`);
        console.log(`   ├─ [-] 期间完成提取 : ${ethers.formatEther(claimedAmount)} mETH (${finalizedEvents.length} 笔)`);
        console.log(`   👉 [理论在途推算] : ${ethers.formatEther(currentTheoretical)} mETH`);

        // 4. 核对实际在途与理论推算 (允许由区块同步导致的一点点容差，比如 0.1 mETH)
        const diff = actualInTransit > currentTheoretical
                     ? actualInTransit - currentTheoretical
                     : currentTheoretical - actualInTransit;

        const TOLERANCE = ethers.parseEther("0.1");

        if (diff > TOLERANCE) {
            const driftMsg = `🚨 [P1 账本异常] 发现不可解释的资金差额！\n实际在途 (${ethers.formatEther(actualInTransit)}) 与事件推算理论值 (${ethers.formatEther(currentTheoretical)}) 不符。\n差异: ${ethers.formatEther(diff)} mETH，请核实是否产生死账！`;
            console.error(driftMsg);
            await triggerAlert(driftMsg);
        } else {
            console.log(`   ✅ 账本对齐成功！资金流水清晰，未发生暗箱扣款。`);
        }

        // 保存本次状态给下一次执行用
        saveState({
            lastL1Block: l1Block,
            lastL2Block: l2Block,
            theoreticalInTransit: actualInTransit.toString() // 以链上实际最新值为准
        });

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        await triggerAlert(`L1-L2 跨链对账探针异常，请检查网络节点！错误信息: ${error.message}`);
    }
}

// 立即执行一次
checkCrossChainPeg();