require('dotenv').config();
const { execSync } = require('child_process');

// ============================================================================
// 环境与常量配置
// ============================================================================
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK;
const REPO_NAME = process.env.GITHUB_REPOSITORY || 'mantle-xyz/meth_online_check';

const MODULES = [
    { name: '预言机存活', title: '🔮 预言机存活 (Oracle Liveness)', file: 'oracle-liveness.js' },
    { name: '流动性防挤兑', title: '💧 流动性防挤兑 (Liquidity Monitor)', file: 'liquidity-monitor.js' },
    { name: '跨链桥对账', title: '🌉 跨链桥对账 (Bridge Peg)', file: 'oracle-liveness.js' },
    { name: '汇率防跌断言', title: '📈 汇率防跌断言 (Rate Monitor)', file: 'rate-monitor.js' },
    { name: '前端防投毒', title: '🛡️ 前端防投毒 (Frontend Integrity)', file: 'frontend-monitor.js' },
    { name: '储备金对账', title: '🏦 储备金对账 (Backing Check)', file: 'backing-check.js' },
    { name: '全站深度巡检', title: '🌐 全站深度巡检 (Site Liveness)', file: 'site-liveness-monitor.js' }
];

// ============================================================================
// 核心功能 1：获取近一周的 Actions 运行统计数据 & 失败链接 (修复聚合统计版)
// ============================================================================
async function getGithubStatsAndFailedUrls() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { statsText: "⚠️ *未配置 GITHUB_TOKEN*", failedUrlsText: "" };

    try {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // 1. 初始化模块统计桶
        const stats = {};
        MODULES.forEach(m => {
            stats[m.name] = { title: m.title, file: m.file, pass: 0, fail: 0, cancel: 0, failures: [] };
        });
        const unclassified = { title: '📦 基础设施/环境异常 (未执行到业务层)', fail: 0, failures: [] };

        let failedRunsCache = [];
        let page = 1;
        let keepFetching = true;
        let totalWorkflowRuns = 0; // 记录真实的流水线执行总次数

        // 2. 抓取历史 Runs
        while (keepFetching && page <= 30) {
            const apiUrl = `https://api.github.com/repos/${REPO_NAME}/actions/runs?created=>${oneWeekAgo}&per_page=100&page=${page}`;
            const response = await fetch(apiUrl, {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
            });

            if (!response.ok) throw new Error(`HTTP 错误: ${response.status}`);
            const data = await response.json();
            const runs = data.workflow_runs || [];

            if (runs.length === 0) { keepFetching = false; break; }

            runs.forEach(run => {
                totalWorkflowRuns++;
                if (run.conclusion === 'success') {
                    // 🚨 核心修复 1：既然一起跑，流水线成功 = 7个模块全部成功！
                    MODULES.forEach(m => stats[m.name].pass++);
                }
                else if (run.conclusion === 'cancelled') {
                    MODULES.forEach(m => stats[m.name].cancel++);
                }
                else if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
                    failedRunsCache.push(run); // 失败的留到下一步去“抓内鬼”
                }
            });

            if (runs.length < 100) keepFetching = false;
            page++;
        }
        // 👇 1. 加上这句：提示开始分析日志了
        console.log(`   ├─ 抓取到 ${totalWorkflowRuns} 次运行记录，其中 ${failedRunsCache.length} 次异常。正在逐个深入拉取报错日志 (请耐心等待)...`);

        // 3. 深入失败流水线，抓出导致失败的具体模块
        for (const [index, run] of failedRunsCache.entries()) {
            // 👇 现在 index 变量存在了，不会再报错了
            console.log(`      └─ [${index + 1}/${failedRunsCache.length}] 正在分析 Run #${run.run_number}...`);
            let blamedModule = null;
            let isEnvError = false;
            let errorDesc = "未知异常";

            const dateObj = new Date(run.created_at);
            dateObj.setHours(dateObj.getHours() + 8);
            const shortTimeStr = `${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')} ${String(dateObj.getUTCHours()).padStart(2, '0')}:${String(dateObj.getUTCMinutes()).padStart(2, '0')}`;

            if (run.conclusion === 'timed_out') {
                errorDesc = "整体工作流执行超时";
                isEnvError = true;
            } else if (run.name && (run.name.includes('.yml') || run.name.includes('.yaml'))) {
                errorDesc = "工作流YAML配置异常";
                isEnvError = true;
            } else {
                try {
                    const jobsRes = await fetch(run.jobs_url, { headers: { 'Authorization': `Bearer ${token}` } });
                    const jobsData = await jobsRes.json();
                    const failedJob = (jobsData.jobs || []).find(j => j.conclusion === 'failure');

                    if (failedJob) {
                        const failedStep = failedJob.steps.find(s => s.conclusion === 'failure');
                        if (failedStep) {
                            // 检查是否是底层环境崩了
                            if (/install|npm|setup|checkout/i.test(failedStep.name)) {
                                isEnvError = true;
                                errorDesc = "环境依赖安装异常";
                            } else {
                                // 根据 Step 名字匹配是哪个具体模块背锅
                                const stepName = failedStep.name.toLowerCase();
                                for (const mod of MODULES) {
                                    if (stepName.includes(mod.name.toLowerCase()) || stepName.includes(mod.file.toLowerCase())) {
                                        blamedModule = stats[mod.name];
                                        break;
                                    }
                                }

                                // 提取具体报错日志
                                const logRes = await fetch(`https://api.github.com/repos/${REPO_NAME}/actions/jobs/${failedJob.id}/logs`, { headers: { 'Authorization': `Bearer ${token}` } });
                                if (logRes.ok) {
                                    const rawLog = await logRes.text();
                                    const lines = rawLog.split('\n');
                                    let specificError = "执行崩溃";

                                    for (let i = lines.length - 1; i >= 0; i--) {
                                        const cleanLine = lines[i].replace(/^[0-9TZ:.-]+\s*/, '').trim();
                                        if (!cleanLine) continue;

                                        if (/npm ERR!|npm error/i.test(cleanLine)) { specificError = "NPM依赖缺失"; break; }
                                        if (/(Error|Exception|Failed):/i.test(cleanLine)) {
                                            if (/missing revert data|CALL_EXCEPTION|\-32000/i.test(cleanLine)) specificError = "RPC节点网络异常";
                                            else if (/ETIMEDOUT|timeout/i.test(cleanLine)) specificError = "网络请求超时";
                                            else if (/ECONNRESET|refused|socket/i.test(cleanLine)) specificError = "节点拒绝连接";
                                            else if (/revert/i.test(cleanLine) && !/missing revert/i.test(cleanLine)) specificError = "链上抛出Revert";
                                            else {
                                                const match = cleanLine.match(/(?:Error|Exception|Failed):\s*(.*)/i);
                                                if (match && match[1]) specificError = match[1].substring(0, 15).trim() + "...";
                                            }
                                            break;
                                        }
                                        if (cleanLine.includes('CALL_EXCEPTION') || cleanLine.includes('missing revert data')) { specificError = "RPC节点网络异常"; break; }
                                        if (cleanLine.includes('ETIMEDOUT')) { specificError = "TCP连接超时"; break; }
                                    }
                                    errorDesc = (specificError === "RPC节点网络异常" || specificError === "节点拒绝连接") ? "RPC 节点连通性异常" : specificError;
                                }
                            }
                        }
                    }
                } catch (e) {
                    errorDesc = "日志拉取或解析失败";
                }
            }

            // 🚨 核心修复 2：责任分配
            if (isEnvError || !blamedModule) {
                // 如果是环境崩了，或者找不到具体的背锅侠，记入基础设施异常
                unclassified.fail++;
                unclassified.failures.push({ runNumber: run.run_number, url: run.html_url, time: shortTimeStr, error: errorDesc });
                // 因为环境崩了，7个模块根本没跑完，记为 cancel (被打断)
                MODULES.forEach(m => stats[m.name].cancel++);
            } else {
                // 找到了明确报错的业务模块！该模块记 fail
                blamedModule.fail++;
                blamedModule.failures.push({ runNumber: run.run_number, url: run.html_url, time: shortTimeStr, error: errorDesc });

                // 其他无辜的 6 个模块记为 pass (维护大盘数据对齐)
                MODULES.forEach(m => {
                    if (m.name !== blamedModule.title.split(' ')[0]) { // 避免匹配错误
                        stats[m.name].pass++;
                    }
                });
            }
        }

        // 4. 组装 UI 报告展示
        let moduleDetailsText = "\n🧩 **各模块执行详情：**\n";

        // 遍历这 7 个固定模块
        MODULES.forEach(m => {
            const mod = stats[m.name];
            const total = mod.pass + mod.fail + mod.cancel;
            const statusIcon = mod.fail > 0 ? "🔴" : (total > 0 ? "🟢" : "⚪");
            moduleDetailsText += `${statusIcon} **${mod.title}**: 共 ${total} 次 (✔️ ${mod.pass}, ❌ ${mod.fail}, ⚪ ${mod.cancel})\n`;
        });

        // 补充底层的未归类异常 (如果发生了的话)
        if (unclassified.fail > 0) {
            moduleDetailsText += `🔴 **${unclassified.title}**: 共触发 ${unclassified.fail} 次\n`;
        }

        const globalFail = MODULES.reduce((sum, m) => sum + stats[m.name].fail, 0) + unclassified.fail;
        const healthScore = totalWorkflowRuns > 0 ? (((totalWorkflowRuns - globalFail) / totalWorkflowRuns) * 100).toFixed(1) + "%" : "0%";
        const startDateStr = new Date(oneWeekAgo).toLocaleDateString('zh-CN');

        const statsText = `**📊 本周全局执行概览 (自 ${startDateStr} 起)**\n监控引擎 7*24 小时守护 mETH 协议安全。\n\n**总体健康度**: ${healthScore} (流水线共执行 ${totalWorkflowRuns} 次，异常 ${globalFail} 次)\n${moduleDetailsText}`;

        let failedUrlsText = "";
        if (globalFail > 0) {
            failedUrlsText = "**🚨 本周详细异常链路追踪：**\n\n";
            const allTrackers = [...MODULES.map(m => stats[m.name]), unclassified];

            for (const mod of allTrackers) {
                if (mod.failures && mod.failures.length > 0) {
                    // ❌ 错误代码：const iconName = mod.title.split(' ')[0] || mod.title;

                    // ✅ 修复方案：直接用正则去掉括号里的英文，保留完整的中文名称和 Emoji
                    const displayName = mod.title.replace(/\s*\(.*\)/, '');

                    failedUrlsText += `**${displayName} 异常清单:**\n`;
                    for (const f of mod.failures) {
                        failedUrlsText += `• [Run #${f.runNumber} (${f.error})](${f.url}) - ${f.time}\n`;
                    }
                    failedUrlsText += "\n";
                }
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
            // 👇 在这里加上 timeout: 60000 (单位为毫秒，即60秒超时) 👇
            const output = execSync(`node ${scriptFile}`, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
            return { success: true, log: output.trim() };
        } catch (error) {
            const realErrorMsg = (error.stderr || error.stdout || error.message || "未知错误").trim();
            // 如果是因为 timeout 强制杀死的，error.message 会包含 ETIMEDOUT 相关信息
            if (attempt === maxRetries) {
                return { success: false, log: `[ERROR_LOG] 达到最大重试次数崩溃 (或执行超时)。\n\n❌ 崩溃原因:\n${realErrorMsg}` };
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

    const githubData = await getGithubStatsAndFailedUrls();
    let currentRunFailures = 0;
    let logElements = [];

    for (const mod of MODULES) {
        const result = runModuleWithRetry(mod.name, mod.file);
        if (!result.success) currentRunFailures++;

        logElements.push({ tag: "markdown", content: `**${mod.title}**` });

        const safeLog = result.log;
        const CHUNK_SIZE = 3000;

        if (safeLog.length <= CHUNK_SIZE) {
            logElements.push({ tag: "markdown", content: `\`\`\`text\n${safeLog}\n\`\`\`` });
        } else {
            const lines = safeLog.split('\n');
            let currentChunk = "";
            for (const line of lines) {
                if (currentChunk.length + line.length > CHUNK_SIZE) {
                    logElements.push({ tag: "markdown", content: `\`\`\`text\n${currentChunk}\n\`\`\`` });
                    currentChunk = "";
                }
                currentChunk += line + "\n";
            }
            if (currentChunk.trim().length > 0) {
                logElements.push({ tag: "markdown", content: `\`\`\`text\n${currentChunk}\n\`\`\`` });
            }
        }
    }

    console.log("📤 准备发送飞书报告...");

    let cardElements = [
        { tag: "markdown", content: githubData.statsText },
        { tag: "hr" }
    ];

    if (githubData.failedUrlsText) {
        cardElements.push({ tag: "markdown", content: githubData.failedUrlsText });
        cardElements.push({ tag: "hr" });
    }

    cardElements.push({ tag: "markdown", content: `**📋 最近一次巡检详细报告 (提取自现场执行)**\n以下内容为自动化原生终端输出。` });
    cardElements.push(...logElements);
    cardElements.push({ tag: "hr" });
    cardElements.push({ tag: "note", elements: [{ tag: "plain_text", content: "此报告由 GitHub Actions 统帅脚本自动调度并推送。" }] });

    const body = {
        msg_type: "interactive",
        card: {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: "plain_text", content: "📊 mETH 链上监控 - 周度运行简报" },
                template: (githubData.failedUrlsText || currentRunFailures > 0) ? "red" : "blue"
            },
            elements: cardElements
        }
    };

    if (FEISHU_WEBHOOK) {
        const response = await fetch(FEISHU_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        if (result.code === 0) console.log("✅ 飞书精美报告发送成功！");
        else console.error("❌ 飞书报错:", result);
    }
}

main().catch(err => {
    console.error("🔥 崩溃:", err);
    process.exit(1);
});