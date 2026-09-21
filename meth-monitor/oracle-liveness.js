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

// 2. Oracle 合约地址配置
const ORACLE_ADDRESS = '0x8735049F496727f824Cc0f2B174d826f5c408192';

// 3. 提取所需的 ABI
const ABIS = {
    Oracle: [
        "function numRecords() external view returns (uint256)",
        "function recordAt(uint256 idx) external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))",
        "function latestRecord() external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))"
    ]
};

const oracleContract = new ethers.Contract(ORACLE_ADDRESS, ABIS.Oracle, provider);

// 飞书告警模块
async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if(!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("告警发送失败:", e.message));
}

// ==========================================
// 4. 核心逻辑 (不包含 try-catch，让网络错误向上抛出)
// ==========================================
async function performOracleCheck() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在探测 Oracle 节点更新状态...`);
    let isBusinessHealthy = true; // 记录业务是否健康

    // --- 第一部分：当前主网状态 vs 最新 Oracle 记录 ---
    const currentBlock = await provider.getBlock('latest');
    const currentTime = currentBlock.timestamp;

    const numRecords = await oracleContract.numRecords();

    if (numRecords === 0n) {
        console.log("⚠️ Oracle 中尚无有效记录！");
        return true;
    }

    // 获取最新记录 (N)
    const latestRecord = await oracleContract.latestRecord();
    const latestUpdateEndBlock = Number(latestRecord.updateEndBlock || latestRecord[1]);

    const latestRecordBlock = await provider.getBlock(latestUpdateEndBlock);
    if (!latestRecordBlock) throw new Error(`无法获取区块 ${latestUpdateEndBlock} 的信息。`);

    const latestReportTimestamp = latestRecordBlock.timestamp;

    // 计算当前离上次更新的时差
    const timeDiffSeconds = currentTime - latestReportTimestamp;
    const timeDiffHours = (timeDiffSeconds / 3600).toFixed(2);

    console.log(`📊 Oracle 状态核推单:`);
    console.log(`   ├─ 当前主网最新区块 : ${currentBlock.number} (Time: ${new Date(currentTime * 1000).toLocaleString()})`);
    console.log(`   ├─ Oracle 截止区块  : ${latestUpdateEndBlock} (Time: ${new Date(latestReportTimestamp * 1000).toLocaleString()})`);
    console.log(`   └─ 距离上次更新已过 : ${timeDiffHours} 小时`);

    const MAX_ALLOWED_HOURS = 9;
    const THRESHOLD_SECONDS = MAX_ALLOWED_HOURS * 3600;

    if (timeDiffSeconds >= THRESHOLD_SECONDS) {
        const errorMsg = `🚨 [P1 告警] Oracle 预言机距离上次更新已过 ${timeDiffHours} 小时，达到/超过了 ${MAX_ALLOWED_HOURS} 小时的阈值。`;
        console.error(errorMsg);
        await triggerAlert(errorMsg);
        isBusinessHealthy = false; // 业务异常
    }

    // --- 第二部分：回溯最近两次报告的时间差 ---
    if (numRecords >= 2n) {
        const prevRecord = await oracleContract.recordAt(numRecords - 2n);
        const prevUpdateEndBlock = Number(prevRecord.updateEndBlock || prevRecord[1]);

        const prevRecordBlock = await provider.getBlock(prevUpdateEndBlock);
        const prevReportTimestamp = prevRecordBlock.timestamp;

        const intervalSeconds = latestReportTimestamp - prevReportTimestamp;
        const intervalHours = (intervalSeconds / 3600).toFixed(2);

        console.log(`\n🔍 [历史回溯] 最近两次 Oracle 报告的提交时间差:`);
        console.log(`   ├─ 报告 [N-1] 截止区块 : ${prevUpdateEndBlock} (Time: ${new Date(prevReportTimestamp * 1000).toLocaleString()})`);
        console.log(`   ├─ 报告 [N]   截止区块 : ${latestUpdateEndBlock} (Time: ${new Date(latestReportTimestamp * 1000).toLocaleString()})`);
        console.log(`   └─ 两次报告的时间差    : ${intervalHours} 小时`);

        if (intervalSeconds >= THRESHOLD_SECONDS) {
            const intervalErrorMsg = `🚨 [P2 警告] Oracle 历史提交记录不达标！\n最近两次出块报告的时间差为 ${intervalHours} 小时，未满足小于 ${MAX_ALLOWED_HOURS} 小时的频率要求。`;
            console.error(intervalErrorMsg);
            await triggerAlert(intervalErrorMsg);
            isBusinessHealthy = false; // 业务异常
        } else {
            console.log(`   ✅ 两次报告时间差小于 ${MAX_ALLOWED_HOURS} 小时，提交频率合规。`);
        }
    }

    return isBusinessHealthy;
}

// ==========================================
// 5. 坚如磐石的全局重试引擎 (遇到限流无限重试直到成功)
// ==========================================
async function main() {
    let attempt = 1;
    // 设定一个极高的上限，防止 GitHub Actions 因无限死循环而超时扣费 (Actions 最长运行 6 小时)
    const MAX_RETRIES = 30;

    while (true) {
        try {
            // 只要这里不抛出网络 Error，就代表代码正常执行完毕
            const isHealthy = await performOracleCheck();

            console.log("\n🏁 巡检顺利结束，退出进程。");
            // 根据业务是否健康返回退出码。0 为成功，1 为触发了告警。
            process.exit(isHealthy ? 0 : 1);

        } catch (error) {
            const errMsg = error.shortMessage || error.message;
            console.error(`\n❌ [第 ${attempt} 次执行遭遇 RPC 崩溃/限流]:`, errMsg);

            if (attempt >= MAX_RETRIES) {
                console.error(`\n🏁 连续重试了 ${MAX_RETRIES} 次仍然被限流，为保护 CI 资源，强制退出。`);
                process.exit(1);
            }

            // 智能指数退避：第 1 次等 5 秒，第 2 次等 10 秒，最多等待 30 秒 (给 Alchemy 喘息恢复的时间)
            const waitTime = Math.min(attempt * 5000, 30000);
            console.log(`⏳ 遇到并发限流 (HTTP 429)，等待 ${waitTime / 1000} 秒后进行自动重试...\n`);

            await new Promise(resolve => setTimeout(resolve, waitTime));
            attempt++;
        }
    }
}

// 启动大管家
main();