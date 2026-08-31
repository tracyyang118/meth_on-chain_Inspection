require('dotenv').config();
const puppeteer = require('puppeteer');
const axios = require('axios');

// ==========================================
// 1. 核心配置与安全限制
// ==========================================
const BASE_URL = "https://app.methprotocol.xyz";

const ENTRY_POINTS = [
    "https://app.methprotocol.xyz",
    "https://app.methprotocol.xyz/campaigns",
    "https://app.methprotocol.xyz/stats",
    "https://app.methprotocol.xyz/stake"
];

const MAX_DEPTH = 3;
const MAX_TOTAL_PAGES = 100;

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if (!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("告警发送失败:", e.message));
}

// ==========================================
// 2. 核心逻辑
// ==========================================
async function deepCheckSiteLiveness() {
    console.log(`\n[${new Date().toISOString()}] 🌐 启动全站多起点深度巡检...`);

    let browser;
    const visited = new Set();
    const brokenLinks = [];
    const queue = ENTRY_POINTS.map(url => ({ url, depth: 0, parent: 'Root Seed' }));

    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        let pagesChecked = 0;

        while (queue.length > 0 && pagesChecked < MAX_TOTAL_PAGES) {
            const currentItem = queue.shift();
            const currentUrl = currentItem.url;
            const currentDepth = currentItem.depth;

            if (visited.has(currentUrl)) continue;
            visited.add(currentUrl);
            pagesChecked++;

            console.log(`   ├─ [层级 ${currentDepth}] 正在检测: ${currentUrl}`);

            let page;
            try {
                page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');

                const response = await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 15000 });

                if (response && !response.ok()) {
                    brokenLinks.push({ url: currentUrl, reason: `HTTP ${response.status()}`, parent: currentItem.parent });
                    continue;
                }

                // 🌟 优化后的 SPA 假存活探针：只检查 Title 和 H1/H2 标签，防止误伤数据表格
                const hasSPAError = await page.evaluate(() => {
                    const title = document.title.toLowerCase();
                    const headings = Array.from(document.querySelectorAll('h1, h2')).map(h => h.innerText.toLowerCase().trim());

                    if (title.includes('404') || title.includes('page not found')) return true;

                    for (const text of headings) {
                        if (text === '404' || text.includes('404 not found') || text === 'page not found') {
                            return true;
                        }
                    }
                    return false;
                });

                if (hasSPAError) {
                    brokenLinks.push({ url: currentUrl, reason: `前端抛出 404 (Title 或大标题显示丢失)`, parent: currentItem.parent });
                    continue;
                }

                if (currentDepth < MAX_DEPTH) {
                    const hrefs = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll('a')).map(a => a.href);
                    });

                    hrefs.forEach(link => {
                        try {
                            const urlObj = new URL(link);
                            if (urlObj.origin === BASE_URL && !link.includes('#')) {
                                const cleanUrl = link.replace(/\/$/, "");
                                if (!visited.has(cleanUrl)) {
                                    queue.push({ url: cleanUrl, depth: currentDepth + 1, parent: currentUrl });
                                }
                            }
                        } catch (e) {}
                    });
                }

            } catch (error) {
                if (error.message.includes('ERR_ABORTED') || error.message.includes('Execution context was destroyed')) {
                    console.log(`   │    💡 [SPA 容错] 页面发生拦截或重定向跳转，已安全忽略。`);
                } else {
                    brokenLinks.push({ url: currentUrl, reason: `访问超时或异常: ${error.message}`, parent: currentItem.parent });
                }
            } finally {
                if (page) await page.close().catch(() => {});
            }
        }

        console.log(`\n📊 遍历统计: 共检查了 ${pagesChecked} 个独立页面。`);

        if (brokenLinks.length > 0) {
            let errorDetails = brokenLinks.map(b => `❌ 坏链: ${b.url}\n   └─ 报错: ${b.reason}\n   └─ 来源页: ${b.parent}`).join('\n\n');
            const alertMsg = `🚨 [P1 前端告警] 发现深度子页面无法访问！\n\n${errorDetails}`;
            console.error(`\n${alertMsg}`);
            await triggerAlert(alertMsg);
        } else {
            console.log(`✅ 深度巡检通过：${pagesChecked} 个节点路由健康，未发现任何死链。`);
        }

    } catch (error) {
        console.error("❌ 深度爬虫引擎崩溃:", error);
    } finally {
        if (browser) await browser.close();
    }
}
deepCheckSiteLiveness();