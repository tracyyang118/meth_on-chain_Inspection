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
        "function numRecords() external view returns (uint256)", // 获取记录总数[cite: 14]
        "function recordAt(uint256 idx) external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))", // 获取指定记录[cite: 14]
        "function latestRecord() external view returns (tuple(uint64 updateStartBlock, uint64 updateEndBlock, uint64 currentNumValidatorsNotWithdrawable, uint64 cumulativeNumValidatorsWithdrawable, uint128 windowWithdrawnPrincipalAmount, uint128 windowWithdrawnRewardAmount, uint128 currentTotalValidatorBalance, uint128 cumulativeProcessedDepositAmount))" // 获取最新记录[cite: 14]
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
// 4. 核心逻辑：存活度与历史报告时间差断言
// ==========================================
async function checkOracleLiveness() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在探测 Oracle 节点更新状态...`);
    try {
        // --- 第一部分：当前主网状态 vs 最新 Oracle 记录 ---
        const currentBlock = await provider.getBlock('latest');
        const currentTime = currentBlock.timestamp;

        const numRecords = await oracleContract.numRecords(); // 获取总记录数[cite: 14]

        if (numRecords === 0n) {
            console.log("⚠️ Oracle 中尚无有效记录！");
            return;
        }

        // 获取最新记录 (N)
        const latestRecord = await oracleContract.latestRecord(); // 获取最新记录[cite: 14]
        const latestUpdateEndBlock = Number(latestRecord.updateEndBlock || latestRecord[1]); // 提取截止区块[cite: 14]

        const latestRecordBlock = await provider.getBlock(latestUpdateEndBlock);
        if (!latestRecordBlock) throw new Error(`无法获取区块 ${latestUpdateEndBlock} 的信息。`);

        const latestReportTimestamp = latestRecordBlock.timestamp;

        // 计算当前离上次更新的时差
        const timeDiffSeconds = currentTime - latestReportTimestamp;
        const timeDiffHours = (timeDiffSeconds / 3600).toFixed(2);

        // 保留要求的输出格式
        console.log(`📊 Oracle 状态核推单:`);
        console.log(`   ├─ 当前主网最新区块 : ${currentBlock.number} (Time: ${new Date(currentTime * 1000).toLocaleString()})`);
        console.log(`   ├─ Oracle 截止区块  : ${latestUpdateEndBlock} (Time: ${new Date(latestReportTimestamp * 1000).toLocaleString()})`);
        console.log(`   └─ 距离上次更新已过 : ${timeDiffHours} 小时`);

        // 设置严格阈值：8 小时
        const MAX_ALLOWED_HOURS = 8.1;
        const THRESHOLD_SECONDS = MAX_ALLOWED_HOURS * 3600;

        if (timeDiffSeconds >= THRESHOLD_SECONDS) {
            const errorMsg = `🚨 [P1 严重告警] Oracle 预言机当前已停摆预警！\n距离上次更新已过 ${timeDiffHours} 小时，达到/超过了 ${MAX_ALLOWED_HOURS} 小时的阈值。`;
            console.error(errorMsg);
            await triggerAlert(errorMsg);
        }

        // --- 第二部分：回溯最近两次报告的时间差 ---
        if (numRecords >= 2n) {
            // 获取上一条记录 (N-1)
            const prevRecord = await oracleContract.recordAt(numRecords - 2n); // 获取上一条记录[cite: 14]
            const prevUpdateEndBlock = Number(prevRecord.updateEndBlock || prevRecord[1]); // 提取截止区块[cite: 14]

            const prevRecordBlock = await provider.getBlock(prevUpdateEndBlock);
            const prevReportTimestamp = prevRecordBlock.timestamp;

            // 计算 N 和 N-1 两次报告之间的时差
            const intervalSeconds = latestReportTimestamp - prevReportTimestamp;
            const intervalHours = (intervalSeconds / 3600).toFixed(2);

            console.log(`\n🔍 [历史回溯] 最近两次 Oracle 报告的提交时间差:`);
            console.log(`   ├─ 报告 [N-1] 截止区块 : ${prevUpdateEndBlock} (Time: ${new Date(prevReportTimestamp * 1000).toLocaleString()})`);
            console.log(`   ├─ 报告 [N]   截止区块 : ${latestUpdateEndBlock} (Time: ${new Date(latestReportTimestamp * 1000).toLocaleString()})`);
            console.log(`   └─ 两次报告的时间差    : ${intervalHours} 小时`);

            // 断言条件：时间差要小于 8 小时
            if (intervalSeconds >= THRESHOLD_SECONDS) {
                const intervalErrorMsg = `🚨 [P2 警告] Oracle 历史提交记录不达标！\n最近两次出块报告的时间差为 ${intervalHours} 小时，未满足小于 ${MAX_ALLOWED_HOURS} 小时的频率要求。`;
                console.error(intervalErrorMsg);
                await triggerAlert(intervalErrorMsg);
            } else {
                console.log(`   ✅ 两次报告时间差小于 ${MAX_ALLOWED_HOURS} 小时，提交频率合规。`);
            }
        }

    } catch (error) {
        console.error("❌ 巡检脚本执行异常:", error);
    }
}

// 立即执行一次
checkOracleLiveness();