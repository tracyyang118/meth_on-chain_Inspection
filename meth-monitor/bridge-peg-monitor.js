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

const STATE_FILE = path.join(__dirname, 'sync-state.json');

// ==========================================
// 2. 核心跨链合约地址配置
// ==========================================
const ADDRESSES = {
    L1mETH: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa',
    L1Adapter: '0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d',
    MantleOfficialBridge: '0x95fc37a27a2f68e3a647cdc081f0a89bb47c3012',

    L2mETH: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0',
    L2MantleBridge: '0x4200000000000000000000000000000000000010'
};

// ==========================================
// 3. 提取只读 ABI
// ==========================================
const ABIS = {
    ERC20: [
        "function balanceOf(address account) external view returns (uint256)",
        "function totalSupply() external view returns (uint256)"
    ],
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

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    return null;
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 🚀 高并发探测拉取机制 (Concurrent Fetcher)
 */
async function getBatchedLogsConcurrent(contract, filter, fromBlock, toBlock, maxConcurrency = 15) {
    let allEvents = [];
    let chunkSize = 2000;
    let currentBlock = fromBlock;

    // --- 阶段 1: 探测节点支持的最大区块范围 ---
    console.log(`   [探测阶段] 测试节点最大支持的区块范围...`);
    while (currentBlock <= toBlock) {
        try {
            const endBlock = Math.min(currentBlock + chunkSize - 1, toBlock);
            const events = await contract.queryFilter(filter, currentBlock, endBlock);
            allEvents.push(...events);
            currentBlock = endBlock + 1;
            console.log(`   ✅ [探测成功] 节点接受 ${chunkSize} 块/次查询`);
            break; // 探测出支持的 size，跳出循环进入并发阶段
        } catch (error) {
            const errorStr = (error.message || error.toString()).toLowerCase();

            if (errorStr.includes('10 block range')) {
                chunkSize = 10;
                console.log(`   ⚠️ [探测结果] 节点严格限制 ${chunkSize} 块/次查询`);
                break;
            } else if (errorStr.includes('429') || errorStr.includes('rate limit') || errorStr.includes('too many requests')) {
                await sleep(2000);
            } else {
                chunkSize = Math.floor(chunkSize / 2);
                if (chunkSize < 1) throw new Error(`无法获取日志，区块分片降至 0。报错: ${errorStr}`);
            }
        }
    }

    if (currentBlock > toBlock) return allEvents;

    // --- 阶段 2: 构建任务队列并启动高并发拉取 ---
    console.log(`   [并发阶段] 启动 ${maxConcurrency} 个并发线程加速同步...`);
    let tasks = [];
    for (let i = currentBlock; i <= toBlock; i += chunkSize) {
        tasks.push({ start: i, end: Math.min(i + chunkSize - 1, toBlock) });
    }

    let completed = 0;
    let activeWorkers = 0;
    let taskIndex = 0;

    return new Promise((resolve) => {
        const next = async () => {
            // 所有任务完成
            if (taskIndex >= tasks.length && activeWorkers === 0) {
                return resolve(allEvents);
            }
            // 填满并发池
            while (activeWorkers < maxConcurrency && taskIndex < tasks.length) {
                const task = tasks[taskIndex++];
                activeWorkers++;
                fetchChunk(task).finally(() => {
                    activeWorkers--;
                    next(); // 一个任务完成后，拉取下一个任务
                });
            }
        };

        const fetchChunk = async (task) => {
            let retries = 5;
            while (retries > 0) {
                try {
                    const events = await contract.queryFilter(filter, task.start, task.end);
                    allEvents.push(...events); // 线程安全：直接推入数组，因为跨链金额累加与事件顺序无关

                    completed++;
                    if (completed % 100 === 0 || completed === tasks.length) {
                        const progress = ((completed / tasks.length) * 100).toFixed(2);
                        console.log(`   └─ ⚡ 并发进度: ${progress}% (已完成 ${completed}/${tasks.length} 个请求批次)`);
                    }
                    return;
                } catch (error) {
                    const errorStr = (error.message || "").toLowerCase();
                    if (errorStr.includes('429') || errorStr.includes('rate limit')) {
                        // 触发限流，进行指数退避休眠，避免持续报错
                        const delay = (6 - retries) * 1000 + Math.random() * 500;
                        await sleep(delay);
                        retries--;
                    } else {
                        await sleep(2000);
                        retries--;
                    }
                }
            }
            console.error(`   ❌ 放弃拉取区块区间 ${task.start}-${task.end}，重试次数耗尽！`);
        };

        next(); // 启动并发控制器
    });
}

// ==========================================
// 6. 核心逻辑：精准量化对账与双重断言
// ==========================================
async function checkCrossChainPeg() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在执行 L1-L2 增量跨链对账...`);

    try {
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
        const totalL1Locked = l1AdapterLocked + l1MantleBridgeLocked;
        const supply = BigInt(l2TotalSupply);

        console.log(`📊 宏观资产核对单:`);
        console.log(`   ├─ [L1 Ethereum] 当前区块 : ${l1Block}`);
        console.log(`   ├─ [L2 Mantle]   当前区块 : ${l2Block}`);
        console.log(`   ├─ [L1 mETH 专用桥锁仓]   : ${ethers.formatEther(l1AdapterLocked)} mETH`);
        console.log(`   ├─ [L1 Mantle 官方桥锁仓] : ${ethers.formatEther(l1MantleBridgeLocked)} mETH`);
        console.log(`   ├─ [L1 总支撑储备资产]    : ${ethers.formatEther(totalL1Locked)} mETH`);
        console.log(`   └─ [L2 实际网络总发行]    : ${ethers.formatEther(supply)} mETH`);

        const actualInTransit = totalL1Locked - supply;
        console.log(`   👉 跨链在途资金差值       : ${ethers.formatEther(actualInTransit)} mETH`);

        // 🚨 核心断言 1：L1 < L2
        if (actualInTransit < 0n) {
            const deficit = supply - totalL1Locked;
            const errorMsg =
                `🚨 [P0 致命告警] 跨链桥脱锚！发现 L2 恶意增发！\n` +
                `物理储备已被击穿，凭空超发: ${ethers.formatEther(deficit)} mETH\n`;
            console.error(errorMsg);
            await triggerAlert(errorMsg);
            return;
        }

        // ⚠️ 核心断言 2：排队 > 1000
        const MAX_PENDING_THRESHOLD = ethers.parseEther("1000.0");
        if (actualInTransit > MAX_PENDING_THRESHOLD) {
            const warningMsg = `⚠️ [P1 拥堵告警] 跨链排队资金突破 1000 mETH 红线！\n当前在途积压: ${ethers.formatEther(actualInTransit)} mETH。`;
            console.warn(warningMsg);
            await triggerAlert(warningMsg);
        }

        const state = loadState();

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

        console.log(`   ⏳ 正在拉取 L2 Initiated 事件 (Mantle)...`);
        const initiatedFilter = l2BridgeContract.filters.ERC20WithdrawalInitiated(ADDRESSES.L1mETH);
        const initiatedEvents = await getBatchedLogsConcurrent(l2BridgeContract, initiatedFilter, state.lastL2Block + 1, l2Block, 15);

        let newPendingAmount = 0n;
        initiatedEvents.forEach(e => newPendingAmount += e.args.amount);

        console.log(`   ⏳ 正在拉取 L1 Finalized 事件 (Ethereum)...`);
        const finalizedFilter = l1BridgeContract.filters.ERC20WithdrawalFinalized(ADDRESSES.L1mETH);
        const finalizedEvents = await getBatchedLogsConcurrent(l1BridgeContract, finalizedFilter, state.lastL1Block + 1, l1Block, 15);

        let claimedAmount = 0n;
        finalizedEvents.forEach(e => claimedAmount += e.args.amount);

        const prevTheoretical = BigInt(state.theoreticalInTransit);
        const currentTheoretical = prevTheoretical + newPendingAmount - claimedAmount;

        console.log(`   ├─ [上次结转在途] : ${ethers.formatEther(prevTheoretical)} mETH`);
        console.log(`   ├─ [+] 期间新增排队 : ${ethers.formatEther(newPendingAmount)} mETH (${initiatedEvents.length} 笔)`);
        console.log(`   ├─ [-] 期间完成提取 : ${ethers.formatEther(claimedAmount)} mETH (${finalizedEvents.length} 笔)`);
        console.log(`   👉 [理论在途推算] : ${ethers.formatEther(currentTheoretical)} mETH`);

        const diff = actualInTransit > currentTheoretical
                     ? actualInTransit - currentTheoretical
                     : currentTheoretical - actualInTransit;

        const TOLERANCE = ethers.parseEther("0.1");

        if (diff > TOLERANCE) {
            const driftMsg = `🚨 [P1 账本异常] 发现不可解释的资金差额！\n差异: ${ethers.formatEther(diff)} mETH，请核实是否产生死账！`;
            console.error(driftMsg);
            await triggerAlert(driftMsg);
        } else {
            console.log(`   ✅ 账本对齐成功！资金流水清晰，未发生暗箱扣款。`);
        }

        saveState({
            lastL1Block: l1Block,
            lastL2Block: l2Block,
            theoreticalInTransit: actualInTransit.toString()
        });

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        await triggerAlert(`L1-L2 跨链对账探针异常，请检查网络节点！错误信息: ${error.message}`);
    }
}

checkCrossChainPeg();