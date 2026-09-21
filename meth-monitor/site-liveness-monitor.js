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
    "https://app.methprotocol.xyz/stake",
    "https://app.methprotocol.xyz/unstake"
];

const MAX_DEPTH = 3;
const MAX_TOTAL_PAGES = 100;

// 🎯 区分两个巨鲸地址：一个兜里有 ETH（用于 Stake），一个兜里有 mETH（用于 Unstake）
const STAKE_WHALE_ADDRESS = '0x86eAD908FB5d6F900ff109C9e26f79300f99271A'.toLowerCase();
const UNSTAKE_WHALE_ADDRESS = '0x4aC943804e2492BeE7dBE5267dBfbd850287D6cB'.toLowerCase();

// 全局白名单字典
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

const OFFICIAL_STAKING_ADDRESS = EXPECTED_CONTRACTS["Staking"].toLowerCase();
const OFFICIAL_UNSTAKE_MANAGER_ADDRESS = EXPECTED_CONTRACTS["UnstakeRequestsManager"].toLowerCase();

// 提取全量白名单地址数组
const WHITELIST_ADDRESSES = Object.values(EXPECTED_CONTRACTS).map(addr => addr.toLowerCase());

const EXPECTED_LINK_DOMAINS = [
    "docs.mantle.xyz", "www.mantle.xyz", "www.methprotocol.xyz", "app.mantle.xyz",
    "etherscan.io", "mantlescan.xyz", "explorer.mantle.xyz", "beaconcha.in",
];
const INTEGRITY_CHECK_PATHS = ["/", "/stake", "/unstake", "/claim", "/bridge", "/restake", "/restake-claim", "/unrestake", "/portfolio"];
const CONTRACT_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if (!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, { msg_type: "text", content: { text: message } }).catch(() => {});
}

// ==========================================
// 2. Stake 专用探针 (基于 demo.js)
// ==========================================
async function runStakeSniffer(targetUrl) {
    console.log(`\n🔍 [Stake 探针] 启动交易防劫持嗅探: ${targetUrl}`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
        await page.evaluateOnNewDocument((whaleAddr) => {
            window.ethereum = {
                isMetaMask: true,
                request: async ({ method, params }) => {
                    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [whaleAddr];
                    if (method === 'eth_chainId') return '0x1';
                    if (method === 'net_version') return '1';
                    if (method === 'eth_estimateGas') return '0x186a0';
                    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
                    if (method === 'personal_sign' || (method && method.startsWith('eth_sign'))) return '0x' + '0'.repeat(130);

                    if (method === 'eth_sendTransaction') {
                        window.__INTERCEPTED_TX__ = params[0];
                        return '0x' + '0'.repeat(64);
                    }
                    try {
                        const res = await fetch('https://eth.llamarpc.com', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
                        });
                        return (await res.json()).result;
                    } catch (e) { return null; }
                }
            };
        }, STAKE_WHALE_ADDRESS);

        await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const connectBtn = btns.find(b => b.innerText.includes('Connect Wallet'));
            if (connectBtn) connectBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.trim() === 'MetaMask') {
                    let target = node.parentElement;
                    for (let i = 0; i < 3 && target; i++) {
                        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        target.click(); target = target.parentElement;
                    } break;
                }
            }
        });
        await new Promise(r => setTimeout(r, 3500));
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        const inputHandle = await page.$('input');
        if (inputHandle) {
            await inputHandle.click();
            await page.keyboard.type('0.1', { delay: 100 });
        }
        await new Promise(r => setTimeout(r, 2000));

        console.log("   ├─ 点击主页面 Stake 唤起 Confirm 弹窗...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const stakeBtn = btns.reverse().find(b => (b.innerText.trim().toLowerCase() === 'stake' || b.innerText.toLowerCase().includes('submit')) && !b.disabled);
            if (stakeBtn) stakeBtn.click();
        });
        await new Promise(r => setTimeout(r, 2500));

        const uiAddress = await page.evaluate((whale) => {
            const allText = document.body.innerHTML + ' ' + Array.from(document.querySelectorAll('a')).map(a => a.href).join(' ');
            const matches = allText.match(/0x[a-fA-F0-9]{40}/gi) || [];
            const filtered = Array.from(new Set(matches.map(a => a.toLowerCase()))).filter(a => a !== whale.toLowerCase());
            return filtered.length > 0 ? filtered[0] : null;
        }, STAKE_WHALE_ADDRESS);

        if (uiAddress && uiAddress === OFFICIAL_STAKING_ADDRESS) {
            console.log(`   └─ ✅ 命中 UI Confirm 快速通道，防劫持校验通过。`);
            return null;
        }

        console.log("   ├─ 点击 Confirm Modal 内部二次确认 Stake 按钮...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const confirmBtn = btns.reverse().find(b => b.innerText.trim() === 'Stake' && !b.disabled);
            if (confirmBtn) confirmBtn.click();
        });

        console.log("⏳ 等待拦截 RPC 交易 Payload (最多等10秒)...");
        const txPayload = await page.waitForFunction(() => window.__INTERCEPTED_TX__, { timeout: 10000 });
        const interceptedAddr = (await txPayload.evaluate(tx => tx.to)).toLowerCase();

        if (interceptedAddr !== OFFICIAL_STAKING_ADDRESS) {
            return `🚨 [Stake] 交易被劫持！\n预期: ${OFFICIAL_STAKING_ADDRESS}\n实际: ${interceptedAddr}`;
        }
        console.log("   └─ ✅ RPC 底层交易校验通过，指向官方地址。");
        return null;

    } catch (e) {
        return `Stake 交互崩溃: ${e.message}`;
    } finally {
        await browser.close();
    }
}

// ==========================================
// 3. Unstake 专用探针 (基于 demo2.js)
// ==========================================
async function runUnstakeSniffer(targetUrl) {
    console.log(`\n🔍 [Unstake 探针] 启动 Permit 授权嗅探: ${targetUrl}`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
        await page.evaluateOnNewDocument((whaleAddr) => {
            window.__INTERCEPTED_PERMIT__ = null;
            window.__INTERCEPTED_TX__ = null;

            window.ethereum = {
                isMetaMask: true,
                request: async ({ method, params }) => {
                    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [whaleAddr];
                    if (method === 'eth_chainId') return '0x1';
                    if (method === 'net_version') return '1';
                    if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
                    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;

                    if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
                        try {
                            const typedData = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
                            if (typedData.primaryType === 'Permit' && typedData.message && typedData.message.spender) {
                                 window.__INTERCEPTED_PERMIT__ = typedData.message.spender;
                            }
                        } catch (e) {}
                        return '0x9924534a6e5585098ffb44bc6055d7a8d50bf23e59092490b411516a2b8e390c588040dbbb14cc590938f36c5df5359a0f5a7e584f295b9c037dae6b91cbb1591c';
                    }
                    if (method === 'eth_sendTransaction') {
                        if (params && params[0] && params[0].to) window.__INTERCEPTED_TX__ = params[0].to;
                        return '0x' + 'f'.repeat(64);
                    }
                    try {
                        const res = await fetch('https://rpc.ankr.com/eth', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
                        });
                        const json = await res.json();
                        if (json.error) return (method === 'eth_call' || method === 'eth_estimateGas') ? '0x' : null;
                        return json.result;
                    } catch (e) { return (method === 'eth_call' || method === 'eth_estimateGas') ? '0x' : null; }
                }
            };
        }, UNSTAKE_WHALE_ADDRESS);

        await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const connectBtn = btns.find(b => b.innerText.includes('Connect Wallet'));
            if (connectBtn) connectBtn.click();
        });
        await new Promise(r => setTimeout(r, 1500));

        await page.evaluate(() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeValue.trim() === 'MetaMask') {
                    let target = node.parentElement;
                    for (let i = 0; i < 3 && target; i++) {
                        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        target.click(); target = target.parentElement;
                    } break;
                }
            }
        });
        await new Promise(r => setTimeout(r, 3500));
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        console.log("   ├─ 模拟敲击解押金额 0.1...");
        const inputHandle = await page.$('input');
        if (inputHandle) {
            await inputHandle.click();
            await page.keyboard.type('0.1', { delay: 100 });
        }
        await new Promise(r => setTimeout(r, 2000));

        console.log("   ├─ 智能点击页面主操作按钮...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            let maxArea = 0, targetBtn = null;
            for(let b of btns) {
                const text = b.innerText.trim().toLowerCase();
                if((text === 'approve meth' || text === 'unstake') && !b.disabled) {
                    const rect = b.getBoundingClientRect();
                    const area = rect.width * rect.height;
                    if(area > maxArea) { maxArea = area; targetBtn = b; }
                }
            }
            if (targetBtn) targetBtn.click();
        });

        console.log("⏳ 等待拦截无 Gas 签名授权 (Permit) 或真实交易 Payload...");
        const targetAddress = await page.evaluate(async () => {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (window.__INTERCEPTED_PERMIT__) {
                        clearInterval(check); resolve({ type: 'Permit', address: window.__INTERCEPTED_PERMIT__ });
                    } else if (window.__INTERCEPTED_TX__) {
                        clearInterval(check); resolve({ type: 'Tx', address: window.__INTERCEPTED_TX__ });
                    }
                }, 500);
                setTimeout(() => { clearInterval(check); resolve(null); }, 10000);
            });
        });

        if (!targetAddress) return "未截获到 Permit 签名或发包请求，前端可能未响应。";

        const interceptedAddr = targetAddress.address.toLowerCase();
        if (interceptedAddr !== OFFICIAL_STAKING_ADDRESS) {
            return `🚨 [Unstake] 业务链路被劫持！\n预期目标: ${OFFICIAL_STAKING_ADDRESS}\n实际目标: ${interceptedAddr}`;
        }
        console.log("   └─ ✅ Permit 授权目标正确指向官方 STAKING！");
        return null;

    } catch (e) {
        return `Unstake 交互崩溃: ${e.message}`;
    } finally {
        await browser.close();
    }
}

// ==========================================
// 4. 静态扫描逻辑
// ==========================================
async function scanPageForIntegrity(page, currentUrl) {
    const suspiciousIssues = [];
    const foundAddresses = new Set();
    const currentPath = (() => { try { return new URL(currentUrl).pathname; } catch (e) { return ''; } })();
    const isCorePage = INTEGRITY_CHECK_PATHS.some(p => currentPath === p || currentPath === p + '/');

    const pageData = await page.evaluate(() => {
        return {
            bodyText: document.body ? (document.body.innerText + ' ' + document.body.textContent) : '',
            attrValues: Array.from(document.querySelectorAll('[data-address],[data-contract],[href]')).map(el => el.getAttribute('data-address') || el.getAttribute('data-contract') || el.getAttribute('href') || '').filter(Boolean),
            links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
        };
    });

    const normalizedBodyText = pageData.bodyText.replace(/\s+/g, '');
    [...(normalizedBodyText.match(CONTRACT_ADDRESS_REGEX) || []), ...pageData.attrValues.flatMap(v => v.match(CONTRACT_ADDRESS_REGEX) || [])].forEach(a => foundAddresses.add(a.toLowerCase()));

    if (!isCorePage) return { suspiciousIssues, foundAddresses };

    const expectedSet = new Set(WHITELIST_ADDRESSES);
    for (const addr of foundAddresses) {
        if (!expectedSet.has(addr)) suspiciousIssues.push(`发现未知/可疑合约地址: ${addr}（不在基准白名单中，需人工复核）`);
    }

    for (const link of pageData.links) {
        try {
            const u = new URL(link);
            if (u.origin === BASE_URL) continue;
            if (!EXPECTED_LINK_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) {
                suspiciousIssues.push(`发现可疑外部跳转链接: ${link}`);
            }
        } catch (e) {}
    }
    return { suspiciousIssues: suspiciousIssues.map(msg => ({ url: currentUrl, reason: msg })), foundAddresses };
}

async function safeNavigate(browser, url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let page;
        try {
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');
            const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            return { page, response, error: null };
        } catch (error) {
            if (page) await page.close().catch(() => {});
            if (error.message.includes('ERR_ABORTED') || error.message.includes('destroyed')) {
                return { page: null, response: null, error: { type: 'SPA_ABORTED', message: error.message } };
            }
            if (attempt === maxRetries) return { page: null, response: null, error };
            await new Promise(res => setTimeout(res, attempt * 2000));
        }
    }
}

// ==========================================
// 5. 主引擎 (带 Fast-Fail 熔断器)
// ==========================================
async function deepCheckSiteLiveness() {
    console.log(`\n[${new Date().toISOString()}] 🌐 启动全站存活性与业务防劫持混合巡检...`);
    let browser;
    let exitCode = 0;
    const visited = new Set();
    const brokenLinks = [];
    const integrityIssues = [];
    const siteWideFoundAddresses = new Set();
    const queue = ENTRY_POINTS.map(url => ({ url, depth: 0, parent: 'Root Seed' }));

    let stakeChecked = false;
    let unstakeChecked = false;

    try {
        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        let pagesChecked = 0;

        while (queue.length > 0 && pagesChecked < MAX_TOTAL_PAGES) {
            const currentItem = queue.shift();
            const { url: currentUrl, depth: currentDepth } = currentItem;

            const normalizedUrl = currentUrl.replace(/\/$/, "");
            if (visited.has(normalizedUrl)) continue;
            visited.add(normalizedUrl);
            pagesChecked++;
            console.log(`   ├─ [层级 ${currentDepth}] 正在检测: ${normalizedUrl}`);

            const navResult = await safeNavigate(browser, normalizedUrl);

            if (navResult.error) {
                if (navResult.error.type !== 'SPA_ABORTED') {
                    brokenLinks.push({ url: normalizedUrl, reason: `连续 3 次访问超时或异常: ${navResult.error.message}`, parent: currentItem.parent });
                }
                continue;
            }

            const { page, response } = navResult;

            try {
                if (response && !response.ok()) {
                    brokenLinks.push({ url: normalizedUrl, reason: `HTTP ${response.status()}`, parent: currentItem.parent });
                    continue;
                }

                try {
                    const { suspiciousIssues, foundAddresses } = await scanPageForIntegrity(page, normalizedUrl);
                    if (suspiciousIssues.length > 0) integrityIssues.push(...suspiciousIssues);
                    foundAddresses.forEach(addr => siteWideFoundAddresses.add(addr));
                } catch (e) {}

                if (currentDepth < MAX_DEPTH) {
                    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => a.href));
                    hrefs.forEach(link => {
                        try {
                            const urlObj = new URL(link);
                            if (urlObj.origin === BASE_URL && !link.includes('#')) {
                                const cleanUrl = link.replace(/\/$/, "");
                                if (!visited.has(cleanUrl)) queue.push({ url: cleanUrl, depth: currentDepth + 1, parent: normalizedUrl });
                            }
                        } catch (e) {}
                    });
                }
            } finally {
                if (page) await page.close().catch(() => {});
            }

            // 🎯 动态探针路由机制 (分离调用)
            let currentPath = '';
            try { currentPath = new URL(normalizedUrl).pathname; } catch(e){}

            if (currentPath === '/stake' && !stakeChecked) {
                stakeChecked = true;
                const hijackError = await runStakeSniffer(normalizedUrl);
                if (hijackError) {
                    integrityIssues.push({ url: normalizedUrl, reason: hijackError });
                    console.error(`🚨 [熔断机制触发] 检测到 Stake 高危异常！抛弃剩余探测任务，立即发起告警！`);
                    break;
                }
            }
            if (currentPath === '/unstake' && !unstakeChecked) {
                unstakeChecked = true;
                const hijackError = await runUnstakeSniffer(normalizedUrl);
                if (hijackError) {
                    integrityIssues.push({ url: normalizedUrl, reason: hijackError });
                    console.error(`🚨 [熔断机制触发] 检测到 Unstake 高危异常！抛弃剩余探测任务，立即发起告警！`);
                    break;
                }
            }
        }

        console.log(`\n📊 遍历与探测统计: 共检查了 ${pagesChecked} 个独立页面。`);

        if (brokenLinks.length > 0) {
            let errorDetails = brokenLinks.map(b => `❌ 坏链: ${b.url}\n   └─ 报错: ${b.reason}\n   └─ 来源页: ${b.parent}`).join('\n\n');
            const alertMsg = `🚨 [P1 前端告警] 发现深度子页面无法访问！\n\n${errorDetails}`;
            console.error(`\n${alertMsg}`);
            await triggerAlert(alertMsg);
            exitCode = 1;
        }

        if (integrityIssues.length > 0) {
            let integrityDetails = integrityIssues.map(b => `⚠️ 探针: ${b.url}\n   └─ 问题: ${b.reason}`).join('\n\n');
            const integrityAlertMsg = `🚨🚨 [P0 致命安全告警] 检测到合约篡改或业务被劫持风险！\n\n${integrityDetails}`;
            console.error(`\n${integrityAlertMsg}`);
            await triggerAlert(integrityAlertMsg);
            exitCode = 1;
        } else {
            console.log(`✅ 业务安全校验通过：UI 地址与 RPC 底层调用均指向官方智能合约字典，未发现劫持。`);
        }
    } catch (error) {
        console.error("❌ 引擎崩溃:", error);
        exitCode = 1;
    } finally {
        if (browser) await browser.close();
        process.exit(exitCode);
    }
}

deepCheckSiteLiveness();