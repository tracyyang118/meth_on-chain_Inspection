require('dotenv').config();
const { execSync } = require('child_process');

// ============================================================================
// 环境与常量配置
// ============================================================================
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;
const REPO_NAME = process.env.GITHUB_REPOSITORY || 'meth_online_check';

const MODULES = [
    { name: '预言机存活', title: '🔮 预言机存活 (Oracle Liveness)', file: 'oracle-liveness.js' },
    { name: '流动性防挤兑', title: '💧 流动性防挤兑 (Liquidity Monitor)', file: 'liquidity-monitor.js' },
    { name: '跨链桥对账', title: '🌉 跨链桥对账 (Bridge Peg)', file: 'bridge-peg-monitor.js' },
    { name: '汇率防跌断言', title: '📈 汇率防跌断言 (Rate Monitor)', file: 'rate-monitor.js' },
    { name: '前端防投毒', title: '🛡️ 前端防投毒 (Frontend Integrity)', file: 'frontend-monitor.js' }
];

// ============================================================================
// 核心功能 1：获取近一周的 Actions 运行统计数据 & 失败链接
// ============================================================================
async function getGithubStatsAndFailedUrls() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        return {
            statsText: "⚠️ *未提供 GITHUB_TOKEN，无法统计历史数据。*",
            failedUrlsText: ""
        };
    }

    try {
        // 计算一周前的时间 (ISO 格式)
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // 调用 GitHub API 获取过去一周的 runs
        const apiUrl = `https://api.github.com/repos/${REPO_NAME}/actions/runs?created=>${oneWeekAgo}&per_page=100`;
        const response = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!response.ok) throw new Error(`HTTP 错误: ${response.status}`);
        const data = await response.json();

        let passCount = 0;
        let failCount = 0;
        let cancelCount = 0;
        let failedRuns = [];

        // 统计状态并收集失败任务
        (data.workflow_runs || []).forEach(run => {
            if (run.conclusion === 'success') passCount++;
            else if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
                failCount++;
                // 只收集最近 5 个失败的链接防止刷屏
                if (failedRuns.length < 5) failedRuns.push(run);
            }
            else if (run.conclusion === 'cancelled') cancelCount++;
        });

        const totalRuns = passCount + failCount + cancelCount;
        const healthScore = totalRuns > 0 ? ((passCount / totalRuns) * 100).toFixed(1) + "%" : "0%";

        // 组装【本周全局执行概览】文字
        const startDateStr = new Date(oneWeekAgo).toLocaleDateString('zh-CN');
        const statsText = `**📊 本周全局执行概览 (自 ${startDateStr} 起)**\n监控引擎 7*24 小时守护 mETH 协议安全。\n\n🟢 **Pass (成功)**: ${passCount} 次\n🔴 <font color='red'>Fail (失败/超时)</font>: ${failCount} 次\n⚪️ **Cancel (被取消)**: ${cancelCount} 次\n🚨 **本周总体健康度**: ${healthScore} (共计运行 ${totalRuns} 次)`;

        // 组装【近期失败链接】文字
        let failedUrlsText = "";
        if (failedRuns.length > 0) {
            failedUrlsText = "**🚨 近期 GitHub Actions 失败记录直达：**\n";
            failedRuns.forEach(run => {
                const timeStr = new Date(run.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                failedUrlsText += `• [${timeStr}] [${run.name}](${run.html_url})\n`;
            });
        }

        return { statsText, failedUrlsText };

    } catch (error) {
        console.error("❌ 获取 GitHub 数据异常:", error);
        return {
            statsText: `⚠️ *获取历史统计数据异常: ${error.message}*`,
            failedUrlsText: ""
        };
    }
}

// ============================================================================
// 核心功能 2：执行子脚本并捕获真实完整日志 (带重试)
// ============================================================================
function runModuleWithRetry(moduleName, scriptFile, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`🚀 正在现场执行 ${moduleName}...`);
        try {
            const output = execSync(`node ${scriptFile}`, { encoding: 'utf8', stdio: 'pipe' });
            return { success: true, log: output.trim() };
        } catch (error) {
            const realErrorMsg = (error.stderr || error.stdout || error.message || "未知错误").trim();
            if (attempt === maxRetries) {
                return { success: false, log: `[ERROR_LOG] 达到最大重试次数崩溃。\n\n❌ 崩溃原因:\n${realErrorMsg}` };
            }
            execSync('sleep 5');
        }
    }
}

// ============================================================================
// 主程序执行流
// ============================================================================
async function main() {
    console.log("🔍 开始生成周报...");

    // 💡 第一步：通过 API 抓取过去一周的全局运行统计和失败链接 (完美还原你的第一版)
    const githubData = await getGithubStatsAndFailedUrls();

    let currentRunFailures = 0; // 记录【当前这一次】现场执行有没有失败
    let logElements = []; // 存储现场执行的精美排版元素

    // 💡 第二步：现场调度子脚本抓取最新业务数据 (完美还原独立区块排版)
    for (const mod of MODULES) {
        const result = runModuleWithRetry(mod.name, mod.file);
        if (!result.success) currentRunFailures++;

        logElements.push({
            tag: "markdown",
            content: `**${mod.title}**`
        });

        let safeLog = result.log;
        if (safeLog.length > 2000) safeLog = safeLog.substring(0, 2000) + "\n\n... [日志过长，已截断] ...";

        logElements.push({
            tag: "markdown",
            content: `\`\`\`text\n${safeLog}\n\`\`\``
        });
    }

    // 💡 第三步：组装最终飞书卡片
    console.log("📤 准备发送飞书报告...");

    let cardElements = [
        // 1. 本周全局执行统计 (自动计算，不用读本地 JSON)
        {
            tag: "markdown",
            content: githubData.statsText
        },
        { tag: "hr" }
    ];

    // 2. 如果有失败链接，插入失败链接区块
    if (githubData.failedUrlsText) {
        cardElements.push({ tag: "markdown", content: githubData.failedUrlsText });
        cardElements.push({ tag: "hr" });
    }

    // 3. 现场详细执行日志大标题
    cardElements.push({
        tag: "markdown",
        content: `**📋 最近一次巡检详细报告 (提取自现场执行)**\n以下内容为自动化原生终端输出。`
    });

    // 4. 将所有模块的独立灰底代码块平铺进去
    cardElements.push(...logElements);

    // 5. 底部备注
    cardElements.push({ tag: "hr" });
    cardElements.push({
        tag: "note",
        elements: [{ tag: "plain_text", content: "此报告由 GitHub Actions 统帅脚本自动调度并推送。" }]
    });

    const body = {
        msg_type: "interactive",
        card: {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: "plain_text", content: "📊 mETH 链上监控 - 周度运行简报" },
                // 如果近一周数据有失败，或者当前这次运行有失败，标题标红
                template: (githubData.failedUrlsText || currentRunFailures > 0) ? "red" : "blue"
            },
            elements: cardElements
        }
    };

    if (FEISHU_WEBHOOK) {
        const response = await fetch(FEISHU_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const result = await response.json();
        if (result.code === 0) console.log("✅ 飞书精美报告发送成功！");
        else console.error("❌ 飞书报错:", result);
    }
}

main().catch(err => {
    console.error("🔥 崩溃:", err);
    process.exit(1);
});