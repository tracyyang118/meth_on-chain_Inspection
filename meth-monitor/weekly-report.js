require('dotenv').config();
const axios = require('axios');

// ==========================================
// 1. 基础配置
// ==========================================
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;

const REPO_OWNER = 'tracyyang118';
const REPO_NAME = 'meth_on-chain_Inspection';
const WORKFLOW_ID = 'monitor-cron.yml';

// ==========================================
// 2. 主函数：抓取统计 & 最新日志
// ==========================================
async function fetchWeeklyStatsAndLogs() {
    if (!GITHUB_TOKEN) {
        console.error("❌ 缺少 GITHUB_TOKEN 环境变量。请在 .env 文件中配置 GITHUB_TOKEN=ghp_xxxx");
        return;
    }

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const dateQuery = oneWeekAgo.toISOString().split('T')[0];

    console.log(`🔍 正在拉取 ${dateQuery} 至今的 GitHub Actions 运行记录...`);

    let allRuns = [];
    let page = 1;
    let keepFetching = true;

    try {
        // 1) 分页拉取所有统计数据
        while (keepFetching) {
            const response = await axios.get(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_ID}/runs`,
                {
                    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
                    params: { created: `>=${dateQuery}`, per_page: 100, page: page }
                }
            );

            const runs = response.data.workflow_runs;
            allRuns.push(...runs);

            console.log(`   ├─ 已拉取第 ${page} 页，本页获取: ${runs.length} 条数据`);

            if (runs.length < 100) keepFetching = false;
            else page++;
        }

        console.log(`✅ 数据拉取完毕，7天内共计获取到 ${allRuns.length} 条巡检记录。`);

        // 2) 统计 Pass / Fail
        const total = allRuns.length;
        const passCount = allRuns.filter(r => r.conclusion === 'success').length;
        const failCount = allRuns.filter(r => r.conclusion === 'failure' || r.conclusion === 'timed_out').length;
        const cancelCount = allRuns.filter(r => r.conclusion === 'cancelled').length;

        // 3) 获取最近一次执行完成的详细日志
        const latestCompletedRun = allRuns.find(r => r.status === 'completed');
        let latestLogData = null;

        if (latestCompletedRun) {
            console.log(`⏳ 正在下载最新一次完成执行 (Run #${latestCompletedRun.run_number}) 的详细日志...`);
            latestLogData = await fetchLatestRunLog(latestCompletedRun.id);
        }

        // 发送飞书卡片
        await sendFeishuCard(total, passCount, failCount, cancelCount, dateQuery, latestCompletedRun, latestLogData);

    } catch (error) {
        console.error("❌ 执行失败:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
}

// ==========================================
// 3. 辅助函数：抓取并解析特定 Run 的终端日志
// ==========================================
async function fetchLatestRunLog(runId) {
    try {
        // 1. 获取该 run 下的 jobs
        const jobsResp = await axios.get(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/jobs`,
            { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
        );
        const job = jobsResp.data.jobs[0]; // 默认取第一个 job
        if (!job) return null;

        // 2. 获取原生的日志文本
        const logResp = await axios.get(
            `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/jobs/${job.id}/logs`,
            {
                headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
                responseType: 'text'
            }
        );

        return parseJobLogs(logResp.data);
    } catch (error) {
        console.log("⚠️ 获取日志详情失败:", error.message);
        return null;
    }
}

// 提取并清洗日志的核心报告片段
function parseJobLogs(rawLog) {
    // 剔除 GitHub Actions 每一行前带的系统时间戳 (如 2026-09-18T10:25:32.7000000Z)
    const cleanLog = rawLog.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:Z|[-+]\d{2}:\d{2})\s?/gm, '');

    // 通用提取器：支持过滤垃圾日志，防止撑爆飞书卡片
    const extract = (startKeyword, endKeyword, maxLines = 40) => {
        const startIdx = cleanLog.indexOf(startKeyword);
        if (startIdx === -1) return "⏳ 暂无数据 (可能该模块在前序节点异常后被强制跳过，或关键字未匹配)";

        const tail = cleanLog.substring(startIdx);
        const lines = tail.split('\n');

        let result = [];
        let validLineCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trimEnd();

            // 🛡️ 核心优化：过滤掉无用的刷屏日志，防止核心报告被顶掉
            if (line.includes('并发进度:')) continue;
            if (line.includes('正在拉取 L')) continue;
            if (line.includes('探测阶段')) continue;
            if (line.includes('探测结果')) continue;

            result.push(line);
            validLineCount++;

            // 找到结束标志就提前终止
            if (endKeyword && line.includes(endKeyword)) {
                break;
            }

            // 达到有效行数上限再截断
            if (validLineCount >= maxLines) {
                result.push('... (截取部分关键展示)');
                break;
            }
        }
        return result.join('\n').trim();
    };

    return {
        oracle: extract('📊 Oracle 状态核推单:', '提交频率合规。'),
        liquidity: extract('📊 解押流动性核对单:', '水位之内。'),
        // Bridge 的终点词改成了推算，因为并发进度被过滤后，报告行数就非常紧凑了
        bridge: extract('📊 宏观资产核单:', '👉 [理论在途推算]', 25),
        frontend: extract('📊 防篡改核对单:', '未发现钓鱼篡改。'),
        rate: extract('🔍 [快照核查]', '状态防跌断言检查 ---', 25)
    };
}

// ==========================================
// 4. 发送飞书可视化周报卡片
// ==========================================
async function sendFeishuCard(total, passCount, failCount, cancelCount, startDate, latestRun, latestLogData) {
    if (!FEISHU_WEBHOOK) return console.log("⚠️ 未配置 FEISHU_WEBHOOK，跳过周报发送。");

    const successRate = total === 0 ? 0 : ((passCount / total) * 100).toFixed(1);
    const themeColor = successRate >= 95.0 ? "green" : "red";
    const statusEmoji = successRate >= 95.0 ? "🎯" : "🚨";

    // 1. 组装顶部的统计信息
    const elements = [
        {
            tag: "div",
            text: {
                tag: "lark_md",
                content: `**📊 本周全局执行概览 (自 ${startDate} 起)**\n监控引擎 7*24 小时守护 mETH 协议安全。\n\n🟢 **Pass (成功)**: **${passCount}** 次\n🔴 **Fail (失败/超时)**: **${failCount}** 次\n⚪ **Cancel (被取消)**: **${cancelCount}** 次\n${statusEmoji} **本周总体健康度**: **${successRate}%** (共计运行 ${total} 次)`
            }
        },
        { tag: "hr" }
    ];

    // 2. 将截取的终端文本以原生 Markdown 代码块的形式插入
    if (latestLogData && latestRun) {
        elements.push({
            tag: "div",
            text: {
                tag: "lark_md",
                content: `**📋 最近一次巡检详细报告 (提取自 Run #${latestRun.run_number})**\n以下内容为自动化原声终端输出。`
            }
        });

        const addModule = (title, content) => {
            elements.push({
                tag: "div",
                text: {
                    tag: "lark_md",
                    // 🛡️ 修复飞书无法渲染 text 尾缀的问题，只用三个反引号包裹即可产生代码高亮框
                    content: `**${title}**\n\`\`\`\n${content}\n\`\`\``
                }
            });
        };

        addModule("🔮 预言机存活 (Oracle Liveness)", latestLogData.oracle);
        addModule("💧 流动性防挤兑 (Liquidity Monitor)", latestLogData.liquidity);
        addModule("🌉 跨链桥对账 (Bridge Peg)", latestLogData.bridge);
        addModule("💱 汇率防跌断言 (Exchange Rate)", latestLogData.rate);
        addModule("🌐 前端防投毒 (Frontend Integrity)", latestLogData.frontend);
    } else {
        elements.push({
            tag: "div",
            text: { tag: "lark_md", content: "⚠️ *暂无法获取最近一次执行的详细日志。*" }
        });
    }

    const cardMsg = {
        msg_type: "interactive",
        card: {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: "plain_text", content: "📊 mETH 链上监控 - 周度运行简报" },
                template: themeColor
            },
            elements: elements
        }
    };

    console.log("✈️ 正在将携带终端日志的汇总报告推送到飞书...");
    await axios.post(FEISHU_WEBHOOK, cardMsg)
        .then(() => console.log("✅ 飞书周报卡片发送成功！"))
        .catch(e => console.error("❌ 飞书周报发送失败:", e.response ? JSON.stringify(e.response.data) : e.message));
}

fetchWeeklyStatsAndLogs();