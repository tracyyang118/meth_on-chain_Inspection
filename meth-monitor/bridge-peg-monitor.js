require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.RPC_URL;
const L2_RPC_URL = process.env.L2_RPC_URL;

if (!RPC_URL || !L2_RPC_URL) {
    console.error("❌ 未找到 RPC_URL 或 L2_RPC_URL 环境变量，请检查 .env 文件。");
    process.exit(1);
}

const l1Provider = new ethers.JsonRpcProvider(RPC_URL);
const l2Provider = new ethers.JsonRpcProvider(L2_RPC_URL);
const STATE_FILE = path.join(__dirname, 'sync-state.json');

const ADDRESSES = {
    L1mETH: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa',
    L1Adapter: '0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d',
    MantleOfficialBridge: '0x95fc37a27a2f68e3a647cdc081f0a89bb47c3012',
    L2mETH: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0'
};

const ABIS = {
    ERC20: [
        "function balanceOf(address account) external view returns (uint256)",
        "function totalSupply() external view returns (uint256)",
        "event Transfer(address indexed from, address indexed to, uint256 value)"
    ],
    BridgeEvents: [
        "event ERC20WithdrawalFinalized(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
        "event ERC20DepositInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)"
    ]
};

const l1MethContract = new ethers.Contract(ADDRESSES.L1mETH, ABIS.ERC20, l1Provider);
const l2MethContract = new ethers.Contract(ADDRESSES.L2mETH, ABIS.ERC20, l2Provider);
const l1BridgeContract = new ethers.Contract(ADDRESSES.MantleOfficialBridge, ABIS.BridgeEvents, l1Provider);

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, { msg_type: "text", content: { text: message } }).catch(e => console.error("告警发送失败:", e.message));
}

function loadState() {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return null;
}
function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getBatchedLogsConcurrent(contract, filter, fromBlock, toBlock, maxConcurrency = 15, logger = console.log) {
    let allEvents = [];
    let chunkSize = 2000;
    let currentBlock = fromBlock;

    logger(`   [探测阶段] 测试节点最大支持的区块范围...`);
    while (currentBlock <= toBlock) {
        try {
            const endBlock = Math.min(currentBlock + chunkSize - 1, toBlock);
            const events = await contract.queryFilter(filter, currentBlock, endBlock);
            allEvents.push(...events);
            currentBlock = endBlock + 1;
            logger(`   ✅ [探测成功] 节点接受 ${chunkSize} 块/次查询`);
            break;
        } catch (error) {
            const errorStr = (error.message || error.toString()).toLowerCase();
            if (errorStr.includes('10 block range')) { chunkSize = 10; break; }
            else if (errorStr.includes('429') || errorStr.includes('rate limit')) await sleep(2000);
            else { chunkSize = Math.floor(chunkSize / 2); if (chunkSize < 1) throw new Error(`无法获取日志，区块分片降至 0`); }
        }
    }

    if (currentBlock > toBlock) return allEvents;

    let tasks = [];
    for (let i = currentBlock; i <= toBlock; i += chunkSize) {
        tasks.push({ start: i, end: Math.min(i + chunkSize - 1, toBlock) });
    }

    let completed = 0, activeWorkers = 0, taskIndex = 0;
    return new Promise((resolve) => {
        const next = async () => {
            if (taskIndex >= tasks.length && activeWorkers === 0) return resolve(allEvents);
            while (activeWorkers < maxConcurrency && taskIndex < tasks.length) {
                const task = tasks[taskIndex++];
                activeWorkers++;
                fetchChunk(task).finally(() => { activeWorkers--; next(); });
            }
        };

        const fetchChunk = async (task) => {
            let retries = 5;
            while (retries > 0) {
                try {
                    const events = await contract.queryFilter(filter, task.start, task.end);
                    allEvents.push(...events);
                    completed++;
                    if (completed % 100 === 0 || completed === tasks.length) {
                        const progress = ((completed / tasks.length) * 100).toFixed(2);
                        logger(`   └─ ⚡ 并发进度: ${progress}%`);
                    }
                    return;
                } catch (error) {
                    const errorStr = (error.message || "").toLowerCase();
                    if (errorStr.includes('429') || errorStr.includes('rate limit')) {
                        await sleep((6 - retries) * 1000 + Math.random() * 500);
                        retries--;
                    } else { await sleep(2000); retries--; }
                }
            }
        };
        next();
    });
}

async function checkCrossChainPeg() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在执行 L1-L2 增量跨链对账...`);
    let alertContext = "";
    const log = (msg) => { console.log(msg); alertContext += msg + "\n"; };

    let exitCode = 0;
    let hasAlert = false;

    // 初始化状态，确保包含 consecutiveFailures 字段
    let state = loadState() || { consecutiveFailures: 0 };
    if (typeof state.consecutiveFailures !== 'number') state.consecutiveFailures = 0;

    try {
        const [l1AdapterBalance, l1MantleBridgeBalance, l2TotalSupply, l1Block, l2Block] = await Promise.all([
            l1MethContract.balanceOf(ADDRESSES.L1Adapter),
            l1MethContract.balanceOf(ADDRESSES.MantleOfficialBridge),
            l2MethContract.totalSupply(),
            l1Provider.getBlockNumber(),
            l2Provider.getBlockNumber()
        ]);

        const totalL1Locked = BigInt(l1AdapterBalance) + BigInt(l1MantleBridgeBalance);
        const supply = BigInt(l2TotalSupply);
        const actualInTransit = totalL1Locked - supply;

        log(`📊 宏观资产核单:`);
        log(`   ├─ [L1 Ethereum] 当前区块 : ${l1Block}`);
        log(`   ├─ [L2 Mantle]   当前区块 : ${l2Block}`);
        log(`   ├─ [L1 mETH 专用桥锁仓]   : ${ethers.formatEther(BigInt(l1AdapterBalance))} mETH`);
        log(`   ├─ [L1 Mantle 官方桥锁仓] : ${ethers.formatEther(BigInt(l1MantleBridgeBalance))} mETH`);
        log(`   ├─ [L1 总支撑储备资产]    : ${ethers.formatEther(totalL1Locked)} mETH`);
        log(`   └─ [L2 实际网络总发行]    : ${ethers.formatEther(supply)} mETH`);
        log(`   👉 跨链在途资金差值       : ${ethers.formatEther(actualInTransit)} mETH`);

        if (actualInTransit < 0n) {
            log(`\n🚨 [P0 致命告警] 跨链桥脱锚！发现 L2 恶意增发！\n物理储备已被击穿，凭空超发: ${ethers.formatEther(supply - totalL1Locked)} mETH`);
            hasAlert = true;
        } else {
            const MAX_PENDING_THRESHOLD = ethers.parseEther("1000.0");
            if (actualInTransit > MAX_PENDING_THRESHOLD) {
                log(`\n⚠️ [P1 拥堵告警] 跨链排队资金突破 1000 mETH 红线！\n当前在途积压: ${ethers.formatEther(actualInTransit)} mETH。`);
                hasAlert = true;
            }

            if (!state.lastL1Block) {
                console.log(`\n初始化账本：初次运行，记录当前区块与基准在途资金...`);
                state.lastL1Block = l1Block;
                state.lastL2Block = l2Block;
                state.theoreticalInTransit = actualInTransit.toString();
                saveState(state);
                process.exit(0);
            }

            // 1. L2 提款发起 (销毁 L2代币)
            const burnFilter = l2MethContract.filters.Transfer(null, ethers.ZeroAddress);
            const l2BurnEvents = await getBatchedLogsConcurrent(l2MethContract, burnFilter, state.lastL2Block + 1, l2Block, 15, log);
            let l2BurnAmount = 0n;
            l2BurnEvents.forEach(e => l2BurnAmount += e.args.value);

            // 2. L1 提款到账 (释放 L1代币)
            const finalizedFilter = l1BridgeContract.filters.ERC20WithdrawalFinalized(ADDRESSES.L1mETH);
            const l1FinalizedEvents = await getBatchedLogsConcurrent(l1BridgeContract, finalizedFilter, state.lastL1Block + 1, l1Block, 15, log);
            let l1FinalizedAmount = 0n;
            l1FinalizedEvents.forEach(e => l1FinalizedAmount += e.args.amount);

            // 3. L1 充值发起 (锁定 L1代币)
            const depositFilter = l1BridgeContract.filters.ERC20DepositInitiated(ADDRESSES.L1mETH);
            const l1DepositEvents = await getBatchedLogsConcurrent(l1BridgeContract, depositFilter, state.lastL1Block + 1, l1Block, 15, log);
            let l1DepositAmount = 0n;
            l1DepositEvents.forEach(e => l1DepositAmount += e.args.amount);

            // 4. L2 充值到账 (铸造 L2代币)
            const mintFilter = l2MethContract.filters.Transfer(ethers.ZeroAddress, null);
            const l2MintEvents = await getBatchedLogsConcurrent(l2MethContract, mintFilter, state.lastL2Block + 1, l2Block, 15, log);
            let l2MintAmount = 0n;
            l2MintEvents.forEach(e => l2MintAmount += e.args.value);

            // 重新计算理论推算值
            const prevTheoretical = BigInt(state.theoreticalInTransit);
            const totalAdds = l2BurnAmount + l1DepositAmount;
            const totalSubs = l1FinalizedAmount + l2MintAmount;
            const currentTheoretical = prevTheoretical + totalAdds - totalSubs;

            log(`\n   ├─ [上次结转在途] : ${ethers.formatEther(prevTheoretical)} mETH`);
            log(`   ├─ [+] 期间新增排队 (提款+充值发起) : ${ethers.formatEther(totalAdds)} mETH (${l2BurnEvents.length + l1DepositEvents.length} 笔)`);
            log(`   ├─ [-] 期间完成核销 (提款+充值到账) : ${ethers.formatEther(totalSubs)} mETH (${l1FinalizedEvents.length + l2MintEvents.length} 笔)`);
            log(`   👉 [理论在途推算] : ${ethers.formatEther(currentTheoretical)} mETH`);

            const diff = actualInTransit > currentTheoretical ? actualInTransit - currentTheoretical : currentTheoretical - actualInTransit;
            const TOLERANCE = ethers.parseEther("0.1");

            if (diff > TOLERANCE) {
                log(`🚨 [P1 账本异常] 发现不可解释的资金差额！\n差异: ${ethers.formatEther(diff)} mETH，请核实！`);
                hasAlert = true;
            } else {
                console.log(`   ✅ 账本对齐成功！资金双向流水清晰，未发生暗箱扣款。`);
            }
        }

        // 成功读取区块并执行完主逻辑，准备更新区块高度
        state.lastL1Block = l1Block;
        state.lastL2Block = l2Block;
        state.theoreticalInTransit = actualInTransit.toString();

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
        alertContext += `\nL1-L2 跨链对账探针异常，请检查网络节点！错误信息: ${error.message}`;
        hasAlert = true;
    } finally {
        if (hasAlert) {
            state.consecutiveFailures += 1;
            if (state.consecutiveFailures >= 2) {
                await triggerAlert(alertContext.trim());
            } else {
                console.log(`⚠️ 首次检测到异常 (或超出容忍度)，暂不告警，等待下一次运行确认。`);
            }
            exitCode = 1;
        } else {
            // 本次运行完全健康，计数清零
            state.consecutiveFailures = 0;
        }

        saveState(state);
        process.exit(exitCode);
    }
}

checkCrossChainPeg();