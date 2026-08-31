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

// ==========================================
// 1.1 【新增】合约地址 / 关键链接完整性基准
// ==========================================
// ⚠️ 请把下面的值换成你们「官方确认无误」的真实数据（例如来自你们自己的
// 合约部署记录、GitHub 仓库、审计报告等可信源，绝不要从页面本身反推）。
//
// EXPECTED_CONTRACTS: 页面上应该出现的、且地址必须完全匹配的合约地址。
// 支持 EVM 风格地址（0x 开头 40 位十六进制），大小写不敏感比对。
const EXPECTED_CONTRACTS = {
    "mETH Token L1": "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa",
    "mETH Token L2": "0xcDA86A272531e8640cD7F1a92c01839911B90bb0",
    "mETH L1 Adapter": "0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d",
    "mETH L2 Adapter": "0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d",
    "cmETH L1": "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA",
    "cmETH L1 Adapter": "0x4aFA9620D0B79137383A7A9AB3477837d475e948",
    "cmETH L2": "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA",
    "COOK L1": "0x9F0C013016E8656bC256f948CD4B79ab25c7b94D",
    "COOK L1 Adapter": "0xC14459931cF666DCcAd582D63288AefB9f0bDca9",
    "COOK L2": "0x9F0C013016E8656bC256f948CD4B79ab25c7b94D",
    "Staking": "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f",
    "UnstakeRequestsManager": "0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9",
    "Oracle": "0x8735049F496727f824Cc0f2B174d826f5c408192",
    "OracleQuorumManager": "0x92e56d2146D54d5AEcB25CA36c89D027a6ea0D90",
    "ReturnsAggregator": "0x1766be66fBb0a1883d41B4cfB0a533c5249D3b82",
    "ConsensusLayerReceiver": "0xD4e11C28E04c0c2bf370b7a9989498B7eA02493f",
    "ExecutionLayerReceiver": "0xD6E4aA932147A3FE5311dA1b67D9e73da06F9cEf",
    "Pauser": "0x29Ab878aEd032e2e2c86FF4A9a9B05e3276cf1f8",
    "ProxyAdmin (Timelock)": "0xc26016f1166bE7b6c5611AAB104122E0f6c2aCE2",
    "EigenLayer Claim": "0x7A3c0C5fADde89185947639f256A3AC3D162CEbB",
    "COOK Address Mapping": "0x7298d8995eb7A932b36A77FcC44dC0cFdCe74De8",
    "BoringVault": "0x33272D40b247c4cd9C646582C9bbAD44e85D4fE4",
    "PositionManagerKarak": "0x52EA8E95378d01B0aaD3B034Ca0656b0F0cc21A2",
    "PositionManagerSymbiotic": "0x919531146f9a25dfc161d5ab23b117feae2c1d36",
    "PositionManagerSymbioticV2": "0x5bb8e5e8602b71b182e0Efe256896a931489A135",
    "PositionManagerEigen1": "0x021180A06Aa65A7B5fF891b5C146FbDaFC06e2DA",
    "PositionManagerEigenP2PV2": "0x0b5d15445b715bf117ba0482b7a9f772af46d93a",
    "PositionManagerEigen2": "0x6DfbE3A1a0e835C125EEBb7712Fffc36c4D93b25",
    "PositionManagerEigenA41V2": "0xCaC15044a1F67238D761Aa4C7650DaB59cEF849D",
    "DelayedWithdraw": "0x12Be34bE067Ebd201f6eAf78a861D90b2a66B113",
    "RestakingPoolKarak": "0x7c22725d1e0871f0043397c9761ad99a86ffd498",
    "RestakingPoolSymbioticRestakingPool": "0x475d3eb031d250070b63fa145f0fcfc5d97c304a",
    "RestakingPoolSymbioticRestakingPoolV2": "0xbA60b6969fAA9b927A0acc750Ea8EEAdcEd644B7",
    "RestakingPoolEigen": "0x298aFB19A105D59E74658C4C334Ff360BadE6dd2",
    "Karak mETH": "0x7C22725d1E0871f0043397c9761AD99A86ffD498",
    "LiquidityBuffer": "0x006FaD88c35D973A87E451CF8D000c7e83Dad409",
    "PortfolioDistrabutor": "0x8c555854b53F254cfe8B8b0D037139856585ed4e",
};

// EXPECTED_LINKS: 页面上关键跳转链接（比如"连接钱包""去 Uniswap 交易"等）
// 应该指向的域名白名单。只要 <a>/<button data-href> 等出现的目标域名
// 不在这个白名单内，就视为可疑跳转（可能是钓鱼链接替换）。
const EXPECTED_LINK_DOMAINS = [
    "docs.mantle.xyz",
    "www.mantle.xyz",
    "www.methprotocol.xyz",
    "app.mantle.xyz",
    "etherscan.io",
    "mantlescan.xyz",
    "explorer.mantle.xyz",
    "beaconcha.in",
];

// LINK_CHECK_EXCLUDED_PATHS 已废弃并替换为下面的 INTEGRITY_CHECK_PATHS。
// 原因：这个网站几乎每个非核心页面（/campaigns/*、/stats/meth/oracle、
// /explore 等）本来就会大量引用第三方协议地址、第三方跳转链接（合作方
// 资金池、区块浏览器、活动集成方等），这是网站的正常业务内容，不是
// 入侵痕迹。逐个排除这些页面永远打不完补丁，只会越来越多地误报。
//
// 正确做法反过来：只对少数几个跟"用户资金直接操作"相关的核心页面
// 做合约地址 / 外部链接完整性校验，其余页面一律跳过这项检查（死链检测
// 不受影响，所有页面依然会做死链探活）。
const INTEGRITY_CHECK_PATHS = [
    "/",
    "/stake",
    "/unstake",
    "/claim",
    "/bridge",
    "/restake",
    "/restake-claim",
    "/unrestake",
    "/portfolio",
];

// CONTRACT_ADDRESS_REGEX: 用来从页面文本/DOM 属性中提取"看起来像合约地址"的字符串
const CONTRACT_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

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

// 【新增】单页扫描：只负责"提取"当前页面出现的地址 / 外部链接，
// 以及检测"不在白名单内的可疑地址/链接"。
// 注意：不在这里判断"预期地址是否缺失"——因为大多数页面本来就不会
// 展示全部 37 个合约地址（只有 /stats/meth/contracts 这类专门页面才会），
// 逐页判断"缺失"必然导致每个页面都刷屏误报。
// "缺失"检测被移到 deepCheckSiteLiveness() 里，在整站爬取完成后，
// 用全站汇总到的地址集合统一比对一次。
async function scanPageForIntegrity(page, currentUrl) {
    const suspiciousIssues = [];
    const foundAddresses = new Set();

    const hasContractBaseline = Object.keys(EXPECTED_CONTRACTS).length > 0;
    const hasLinkBaseline = EXPECTED_LINK_DOMAINS.length > 0;
    if (!hasContractBaseline && !hasLinkBaseline) {
        return { suspiciousIssues, foundAddresses };
    }

    // 白名单准入：只有 INTEGRITY_CHECK_PATHS 里列出的核心资金页面才做
    // "可疑地址/可疑链接"检测；其余页面（活动页、统计页、生态目录页等）
    // 天然会包含大量第三方地址和链接，不在检测范围内。
    // 注意：这个函数仍然会被每个页面调用，用来采集页面上出现的地址
    // （foundAddresses 用于后续全站层面判断"预期地址是否缺失"），
    // 只是"发现可疑内容"这一判断只在核心页面上做。
    const currentPath = (() => {
        try { return new URL(currentUrl).pathname; } catch (e) { return ''; }
    })();
    const isCorePage = INTEGRITY_CHECK_PATHS.some(p => currentPath === p || currentPath === p + '/');

    const pageData = await page.evaluate(() => {
        return {
            // innerText 在地址被拆成多个 <span> 展示时容易被空格/换行打断，
            // 这里连同 textContent 一起采集，后面会统一去除空白再匹配。
            bodyText: document.body ? (document.body.innerText + ' ' + document.body.textContent) : '',
            attrValues: Array.from(document.querySelectorAll('[data-address],[data-contract],[href]'))
                .map(el => el.getAttribute('data-address') || el.getAttribute('data-contract') || el.getAttribute('href') || '')
                .filter(Boolean),
            links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
        };
    });

    // 关键修复：把 body 文本中的所有空白字符去掉之后再匹配地址。
    // 原因：很多前端组件会把一个地址拆成多个 <span>（比如 "0xd5F..." /
    // "...ADfa" 分两段展示做省略/复制效果），innerText 计算时这些片段
    // 之间会被插入空格或换行，导致连续 40 位十六进制的正则完全匹配不上，
    // 进而把"页面上明明有的地址"误判成"缺失"。
    // 去空白后再匹配，配合 href/data-* 属性（这些本来就是完整地址不会被拆）
    // 双重来源，基本可以还原出真实展示的地址。
    const normalizedBodyText = pageData.bodyText.replace(/\s+/g, '');

    [
        ...(normalizedBodyText.match(CONTRACT_ADDRESS_REGEX) || []),
        ...pageData.attrValues.flatMap(v => v.match(CONTRACT_ADDRESS_REGEX) || [])
    ].forEach(a => foundAddresses.add(a.toLowerCase()));

    // 非核心页面：只采集地址供后续全站汇总使用，不做"可疑内容"判断，直接返回
    if (!isCorePage) {
        return { suspiciousIssues, foundAddresses };
    }

    if (hasContractBaseline) {
        const expectedSet = new Set(
            Object.values(EXPECTED_CONTRACTS).map(a => a.toLowerCase())
        );
        for (const addr of foundAddresses) {
            if (!expectedSet.has(addr)) {
                suspiciousIssues.push(`发现未知/可疑合约地址: ${addr}（不在基准白名单中，需人工复核是否被篡改）`);
            }
        }
    }

    if (hasLinkBaseline) {
        for (const link of pageData.links) {
            try {
                const u = new URL(link);
                // 只关注跳出本站的外部链接（内部路由不受此规则约束）
                if (u.origin === BASE_URL) continue;
                const domainOk = EXPECTED_LINK_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
                if (!domainOk) {
                    // 精简消息：只报域名本身，不在每条告警里重复打印整份白名单，
                    // 避免消息过长被下游（飞书 webhook 等）截断导致内容乱码。
                    suspiciousIssues.push(`发现可疑外部跳转链接: ${link}（域名 "${u.hostname}" 不在白名单内）`);
                }
            } catch (e) {
                // 非法 URL 忽略
            }
        }
    }

    return {
        suspiciousIssues: suspiciousIssues.map(msg => ({ url: currentUrl, reason: msg })),
        foundAddresses
    };
}

async function deepCheckSiteLiveness() {
    console.log(`\n[${new Date().toISOString()}] 🌐 启动全站多起点深度巡检...`);

    let browser;
    const visited = new Set();
    const brokenLinks = [];
    const integrityIssues = []; // 【新增】收集"可疑地址/可疑链接"类问题（逐页判断，随时命中随时记录）
    const siteWideFoundAddresses = new Set(); // 【新增】全站范围内出现过的所有合约地址（去空白匹配后小写），用于最后统一比对"是否缺失"
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

                // 【新增】执行合约地址 / 关键链接完整性扫描（逐页：只找"可疑"，不判断"缺失"）
                try {
                    const { suspiciousIssues, foundAddresses } = await scanPageForIntegrity(page, currentUrl);
                    if (suspiciousIssues.length > 0) {
                        integrityIssues.push(...suspiciousIssues);
                    }
                    foundAddresses.forEach(addr => siteWideFoundAddresses.add(addr));
                } catch (integrityErr) {
                    console.log(`   │    ⚠️ 完整性校验执行异常（不影响主流程）: ${integrityErr.message}`);
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

        // 【新增】全站汇总后，统一比对一次"预期地址是否完全没有在任何页面出现过"。
        // 放在这里（而不是逐页判断）是因为大部分页面本来就不会展示全部 37 个地址，
        // 只有 /stats/meth/contracts 这类专门页面才会展示完整列表；只要地址在
        // 整个爬取范围内的"任意一个"页面出现过，就不算缺失。
        if (Object.keys(EXPECTED_CONTRACTS).length > 0) {
            for (const [label, addr] of Object.entries(EXPECTED_CONTRACTS)) {
                if (!siteWideFoundAddresses.has(addr.toLowerCase())) {
                    integrityIssues.push({
                        url: '(全站范围)',
                        reason: `预期合约地址缺失 [${label}]: 本次爬取到的所有页面中均未展示地址 ${addr}`
                    });
                }
            }
        }

        // 原有的死链告警
        if (brokenLinks.length > 0) {
            let errorDetails = brokenLinks.map(b => `❌ 坏链: ${b.url}\n   └─ 报错: ${b.reason}\n   └─ 来源页: ${b.parent}`).join('\n\n');
            const alertMsg = `🚨 [P1 前端告警] 发现深度子页面无法访问！\n\n${errorDetails}`;
            console.error(`\n${alertMsg}`);
            await triggerAlert(alertMsg);
        } else {
            console.log(`✅ 深度巡检通过：${pagesChecked} 个节点路由健康，未发现任何死链。`);
        }

        // 【新增】完整性校验告警（单独触发，级别更高：涉及资金安全）
        if (integrityIssues.length > 0) {
            let integrityDetails = integrityIssues
                .map(b => `⚠️ 页面: ${b.url}\n   └─ 问题: ${b.reason}`)
                .join('\n\n');
            const integrityAlertMsg = `🚨🚨 [P0 安全告警] 检测到合约地址/关键链接可能被篡改！请立即人工核实！\n\n${integrityDetails}`;
            console.error(`\n${integrityAlertMsg}`);
            await triggerAlert(integrityAlertMsg);
        } else if (Object.keys(EXPECTED_CONTRACTS).length > 0 || EXPECTED_LINK_DOMAINS.length > 0) {
            console.log(`✅ 完整性校验通过：未发现合约地址或关键链接被篡改。`);
        } else {
            console.log(`ℹ️ 未配置 EXPECTED_CONTRACTS / EXPECTED_LINK_DOMAINS 基准，已跳过完整性校验。`);
        }

    } catch (error) {
        console.error("❌ 深度爬虫引擎崩溃:", error);
    } finally {
        if (browser) await browser.close();
    }
}
deepCheckSiteLiveness();