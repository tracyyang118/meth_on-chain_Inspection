require('dotenv').config();
const { execSync } = require('child_process');

// ============================================================================
// 环境与常量配置
// ============================================================================
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;
const REPO_NAME = process.env.GITHUB_REPOSITORY || 'tracyyang118/meth_on-chain_Inspection';

const MODULES = [
    { name: '预言机存活', title: '🔮 预言机存活 (Oracle Liveness)', file: 'oracle-liveness.js' },
    { name: '流动性防挤兑', title: '💧 流动性防挤兑 (Liquidity Monitor)', file: 'liquidity-monitor.js' },
    { name: '跨链桥对账', title: '🌉 跨链桥对账 (Bridge Peg)', file: 'bridge-peg-monitor.js' },
    { name: '汇率防跌断言', title: '📈 汇率防跌断言 (Rate Monitor)', file: 'rate-monitor.js' },
    { name: '前端防投毒', title: '🛡️ 前端防投毒 (Frontend Integrity)', file: 'frontend-monitor.js' },
    { name: '储备金对账', title: '🏦 储备金对账 (Backing Check)', file: 'backing-check.js' },
    { name: '全站深度巡检', title: '🌐 全站深度巡检 (Site Liveness)', file: 'site-liveness-monitor.js' }
];

// ============================================================================
// 核心功能 1：获取近一周的 Actions 运行统计数据 & 失败链接 (精准诊断树版)
// ============================================================================
async function getGithubStatsAndFailedUrls() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { statsText: "⚠️ *未配置 GITHUB_TOKEN*", failedUrlsText: "" };

    try {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const apiUrl = `https://api.github.com/repos/${REPO_NAME}/actions/runs?created=>${oneWeekAgo}&per_page=100`;
        const response = await fetch(apiUrl, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });

        if (!response.ok) throw new Error(`HTTP 错误: ${response.status}`);
        const data = await response.json();

        let passCount = 0, failCount = 0, cancelCount = 0, failedRuns = [];

        (data.workflow_runs || []).forEach(run => {
            if (run.conclusion === 'success') passCount++;
            else if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
                failCount++;
                if (failedRuns.length < 5) failedRuns.push(run);
            }
            else if (run.conclusion === 'cancelled') cancelCount++;
        });

        const totalRuns = passCount + failCount + cancelCount;
        const healthScore = totalRuns > 0 ? ((passCount / totalRuns) * 100).toFixed(1) + "%" : "0%";
        const startDateStr = new Date(oneWeekAgo).toLocaleDateString('zh-CN');
        const statsText = `**📊 本周全局执行概览 (自 ${startDateStr} 起)**\n监控引擎 7*24 小时守护 mETH 协议安全。\n\n🟢 **Pass (成功)**: ${passCount} 次\n🔴 <font color='red'>Fail (异常)</font>: ${failCount} 次\n⚪️ **Cancel (被取消)**: ${cancelCount} 次\n🚨 **本周总体健康度**: ${healthScore} (共计运行 ${totalRuns} 次)`;

        let failedUrlsText = "";
        if (failedRuns.length > 0) {
            failedUrlsText = "**🚨 本周失败/异常任务清单列表：**\n";

            for (const run of failedRuns) {
                const dateObj = new Date(run.created_at);
                dateObj.setHours(dateObj.getHours() + 8);
                const shortTimeStr = `${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')} ${String(dateObj.getUTCHours()).padStart(2, '0')}:${String(dateObj.getUTCMinutes()).padStart(2, '0')}`;

                let errorDesc = "未知异常";

                // 1. 判断是否是整体超时
                if (run.conclusion === 'timed_out') {
                    errorDesc = "整体工作流执行超时";
                }
                // 2. 判断是否是 YAML 语法错误 (Run #1 的救星)
                else if (run.name && (run.name.includes('.yml') || run.name.includes('.yaml'))) {
                    errorDesc = "工作流YAML配置异常";
                }
                // 3. 深入 Job 级别提取真实报错
                else {
                    try {
                        const jobsRes = await fetch(run.jobs_url, {
                            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
                        });
                        const jobsData = await jobsRes.json();
                        const failedJob = (jobsData.jobs || []).find(j => j.conclusion === 'failure');

                        if (failedJob) {
                            let moduleName = "未知";
                            const failedStep = failedJob.steps.find(s => s.conclusion === 'failure');

                            if (failedStep && /install|npm|setup/i.test(failedStep.name)) {
                                errorDesc = "环境依赖安装异常";
                            } else {
                                if (failedStep) {
                                    const zhMatch = failedStep.name.match(/[\u4e00-\u9fa5]+/g);
                                    if (zhMatch) moduleName = zhMatch.join('').replace(/执行|断言|防跌/g, '');
                                    else moduleName = failedStep.name.split(' ')[0].substring(0, 8);
                                }

                                const logRes = await fetch(`https://api.github.com/repos/${REPO_NAME}/actions/jobs/${failedJob.id}/logs`, {
                                    headers: { 'Authorization': `Bearer ${token}` }
                                });

                                if (logRes.ok) {
                                    const rawLog = await logRes.text();
                                    const lines = rawLog.split('\n');
                                    let specificError = "执行崩溃";

                                    for (let i = lines.length - 1; i >= 0; i--) {
                                        const cleanLine = lines[i].replace(/^[0-9TZ:.-]+\s*/, '').trim();
                                        if (!cleanLine) continue;

                                        if (/npm ERR!|npm error/i.test(cleanLine)) {
                                            specificError = "NPM依赖缺失"; break;
                                        }

                                        if (/(Error|Exception|Failed):/i.test(cleanLine)) {
                                            // 💡 修复重点：优先拦截 RPC 专有错误！
                                            if (/missing revert data|CALL_EXCEPTION|\-32000/i.test(cleanLine)) {
                                                specificError = "RPC节点网络异常";
                                            } else if (/ETIMEDOUT|timeout/i.test(cleanLine)) {
                                                specificError = "网络请求超时";
                                            } else if (/ECONNRESET|refused|socket/i.test(cleanLine)) {
                                                specificError = "节点拒绝连接";
                                            }
                                            // 只有确认没有 missing revert data 时，才是真实的链上 revert
                                            else if (/revert/i.test(cleanLine) && !/missing revert/i.test(cleanLine)) {
                                                specificError = "链上抛出Revert";
                                            } else {
                                                const match = cleanLine.match(/(?:Error|Exception|Failed):\s*(.*)/i);
                                                if (match && match[1]) specificError = match[1].substring(0, 15).trim() + "...";
                                            }
                                            break;
                                        }

                                        // 兜底捕捉
                                        if (cleanLine.includes('CALL_EXCEPTION') || cleanLine.includes('missing revert data')) {
                                            specificError = "RPC节点网络异常"; break;
                                        }
                                        if (cleanLine.includes('ETIMEDOUT')) { specificError = "TCP连接超时"; break; }
                                    }

                                    // 根据 specificError 组装最终结果
                                    if (specificError === "RPC节点网络异常" || specificError === "节点拒绝连接") {
                                        // 强制重写为我们想要的 RPC 异常格式，对应你截图中的需求
                                        errorDesc = `RPC 节点连通性异常`;
                                    } else {
                                        errorDesc = `${moduleName} (${specificError})`;
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        errorDesc = "日志拉取或解析失败";
                    }
                }

                failedUrlsText += `• [Run #${run.run_number} (${errorDesc})](${run.html_url}) - ${shortTimeStr}\n`;
            }
        }

        return { statsText, failedUrlsText };
    } catch (error) {
        return { statsText: `⚠️ *获取历史数据异常: ${error.message}*`, failedUrlsText: "" };
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

        // 🌟 【黑科技：智能分块突破飞书字数限制】
        const safeLog = result.log;
        const CHUNK_SIZE = 3000; // 设定飞书单块安全限制

        if (safeLog.length <= CHUNK_SIZE) {
            // 如果长度安全，直接塞入
            logElements.push({
                tag: "markdown",
                content: `\`\`\`text\n${safeLog}\n\`\`\``
            });
        } else {
            // 如果超长，按行分割，防止把 URL 或单词从中间粗暴切断
            const lines = safeLog.split('\n');
            let currentChunk = "";

            for (const line of lines) {
                // 如果当前积累的字符数 + 这一行 超过了 3000
                if (currentChunk.length + line.length > CHUNK_SIZE) {
                    // 把装满的这部分先推入数组
                    logElements.push({
                        tag: "markdown",
                        content: `\`\`\`text\n${currentChunk}\n\`\`\``
                    });
                    // 清空桶，准备装下一批
                    currentChunk = "";
                }
                currentChunk += line + "\n";
            }
            // 把最后剩下的尾巴也推入数组
            if (currentChunk.trim().length > 0) {
                logElements.push({
                    tag: "markdown",
                    content: `\`\`\`text\n${currentChunk}\n\`\`\``
                });
            }
        }
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