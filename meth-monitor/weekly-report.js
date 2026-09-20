require('dotenv').config();
const axios = require('axios');
const { execSync } = require('child_process');

// ==========================================
// 辅助函数：带重试机制的脚本执行
// ==========================================
function runScriptAndCaptureOutputWithRetry(scriptName, moduleName, maxRetries = 3) {
    let attempt = 1;
    let finalOutput = '';

    while (attempt <= maxRetries) {
        console.log(`[${new Date().toISOString()}] 🚀 [Attempt ${attempt}/${maxRetries}] 正在现场执行 ${moduleName} (${scriptName})...`);
        try {
            const output = execSync(`node ${scriptName}`, { encoding: 'utf8', stdio: 'pipe' });
            console.log(`✅ ${moduleName} 执行完毕。`);
            return output.trim() || '⏳ 暂无数据 (输出为空)';

        } catch (error) {
            console.warn(`⚠️ ${moduleName} 第 ${attempt} 次执行失败/异常。`);

            const stdout = error.stdout ? error.stdout.trim() : '';
            const stderr = error.stderr ? error.stderr.trim() : '';

            let log = stdout;
            if (stderr) {
                log += `\n[ERROR_LOG] ${stderr}`;
            }
            if (!log) {
                log = `[ERROR_LOG] 脚本启动失败或无输出: ${error.message}`;
            }

            finalOutput = log;

            if (finalOutput.includes('MODULE_NOT_FOUND')) {
                console.error(`🚨 检测到致命错误：找不到文件 ${scriptName}！请检查文件名。停止重试。`);
                return finalOutput;
            }

            attempt++;
            if (attempt <= maxRetries) {
                console.log(`⏳ 遇到异常，等待 5 秒后进行第 ${attempt} 次重试...`);
                execSync('sleep 5');
            }
        }
    }

    console.error(`❌ ${moduleName} 达到最大重试次数 (${maxRetries})，最终放弃。`);
    return finalOutput;
}

// ==========================================
// 发送飞书互动卡片 (Interactive Card)
// ==========================================
async function sendToFeishuCard(passCount, failCount, cancelCount, healthScore, startDateStr, oracleLog, liquidityLog, bridgeLog, exchangeRateLog, frontendLog) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if (!WEBHOOK_URL) {
        console.warn("\n⚠️ 未配置 FEISHU_WEBHOOK，跳过发送卡片。");
        return;
    }

    // 根据健康度决定卡片顶部颜色 (低于 80 分变红，否则为蓝色/绿色)
    let cardColor = "blue";
    if (healthScore < 80) {
        cardColor = "red";
    }

    // 构建飞书富文本卡片的 JSON 结构
    const cardContent = {
        "msg_type": "interactive",
        "card": {
            "config": {
                "wide_screen_mode": true,
                "enable_forward": true
            },
            "header": {
                "title": {
                    "tag": "plain_text",
                    "content": "📊 mETH 链上监控 - 周度运行简报"
                },
                "template": cardColor
            },
            "elements": [
                {
                    "tag": "markdown",
                    "content": `**📊 本周全局执行概览 (自 ${startDateStr} 起)**\n监控引擎 7*24 小时守护 mETH 协议安全。\n\n🟢 **Pass (成功):** ${passCount} 次\n🔴 **Fail (失败/超时):** ${failCount} 次\n⚪ **Cancel (被取消):** ${cancelCount} 次\n🚨 **本周总体健康度:** ${healthScore}\% (共计运行 ${passCount + failCount + cancelCount} 次)`
                },
                {
                    "tag": "hr"
                },
                {
                    "tag": "markdown",
                    "content": `**📋 最近一次巡检详细报告 (提取自现场执行)**\n以下内容为自动化原声终端输出。`
                },
                {
                    "tag": "markdown",
                    "content": `**🔮 预言机存活 (Oracle Liveness)**\n\`\`\`\n${oracleLog}\n\`\`\``
                },
                {
                    "tag": "markdown",
                    "content": `**💧 流动性防挤兑 (Liquidity Monitor)**\n\`\`\`\n${liquidityLog}\n\`\`\``
                },
                {
                    "tag": "markdown",
                    "content": `**🌉 跨链桥对账 (Bridge Peg)**\n\`\`\`\n${bridgeLog}\n\`\`\``
                },
                {
                    "tag": "markdown",
                    "content": `**💱 汇率防跌断言 (Exchange Rate)**\n\`\`\`\n${exchangeRateLog}\n\`\`\``
                },
                {
                    "tag": "markdown",
                    "content": `**🌐 前端防投毒 (Frontend Integrity)**\n\`\`\`\n${frontendLog}\n\`\`\``
                }
            ]
        }
    };

    try {
        await axios.post(WEBHOOK_URL, cardContent);
        console.log("\n✅ 汇总大报告卡片已成功推送到飞书群！");
    } catch (e) {
        console.error("\n❌ 飞书卡片发送失败:", e.message);
        if (e.response && e.response.data) {
            console.error("飞书接口返回错误信息:", e.response.data);
        }
    }
}

// ==========================================
// 主执行流
// ==========================================
async function generateWeeklyReport() {
    console.log("🔍 开始现场拉起各大模块监控脚本 (启用 3 次重试机制)...");

    const today = new Date();
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startDateStr = lastWeek.toISOString().split('T')[0];

    const oracleLog = runScriptAndCaptureOutputWithRetry('oracle-liveness.js', '预言机存活');
    const liquidityLog = runScriptAndCaptureOutputWithRetry('liquidity-monitor.js', '流动性防挤兑');
    const bridgeLog = runScriptAndCaptureOutputWithRetry('bridge-peg-monitor.js', '跨链桥对账');
    const exchangeRateLog = runScriptAndCaptureOutputWithRetry('rate-monitor.js', '汇率防跌断言');
    const frontendLog = runScriptAndCaptureOutputWithRetry('frontend-monitor.js', '前端防投毒');

    // 假设这些是动态计算的数据 (此处写死用于演示)
    const passCount = 28;
    const failCount = 4;
    const cancelCount = 22;
    const totalCount = passCount + failCount + cancelCount;
    const healthScore = ((passCount / totalCount) * 100).toFixed(1);

    // 发送富文本卡片
    await sendToFeishuCard(
        passCount,
        failCount,
        cancelCount,
        healthScore,
        startDateStr,
        oracleLog,
        liquidityLog,
        bridgeLog,
        exchangeRateLog,
        frontendLog
    );
}

generateWeeklyReport();