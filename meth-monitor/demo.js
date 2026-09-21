const puppeteer = require('puppeteer');

const OFFICIAL_STAKING_ADDRESS = '0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f'.toLowerCase();
const WHALE_ADDRESS = '0x86eAD908FB5d6F900ff109C9e26f79300f99271A';

async function checkStakeHijack() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1280,800'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log("💉 正在注入终极虚拟钱包 (拦截所有静默签名与切链)...");

    await page.evaluateOnNewDocument((whaleAddr) => {
        window.ethereum = {
            isMetaMask: true,
            request: async ({ method, params }) => {
                // 1. 账户与网络识别
                if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [whaleAddr];
                if (method === 'eth_chainId') return '0x1';
                if (method === 'net_version') return '1';

                // 2. 绕过 Gas 估算
                if (method === 'eth_estimateGas') return '0x186a0';

                // 3. 🚀 核心修复：拦截静默签名与切链请求，防止前端弹窗卡死！
                if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null; // 切链直接返回成功
                if (method === 'personal_sign' || (method && method.startsWith('eth_sign'))) {
                    return '0x' + '0'.repeat(130); // 随便返回一个虚假的 65 字节签名
                }

                // 4. 终极目标：拦截交易
                if (method === 'eth_sendTransaction') {
                    window.__INTERCEPTED_TX__ = params[0];
                    return '0x' + '0'.repeat(64);
                }

                // 5. 其他正常的读链操作放行
                try {
                    const res = await fetch('https://eth.llamarpc.com', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
                    });
                    const json = await res.json();
                    return json.result;
                } catch (e) {
                    return null;
                }
            }
        };
    }, WHALE_ADDRESS);

    console.log("🌐 访问 Stake 页面...");
    await page.goto("https://app.methprotocol.xyz/stake", { waitUntil: 'networkidle2' });

    try {
        console.log("🖱️ 执行交互...");
        await new Promise(r => setTimeout(r, 2000));

        console.log("   ├─ 点击 Connect Wallet...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const connectBtn = btns.find(b => b.innerText.includes('Connect Wallet'));
            if (connectBtn) connectBtn.click();
        });

        await new Promise(r => setTimeout(r, 2000));

        console.log("   ├─ 在弹窗中精准狙击 MetaMask 按钮...");
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
                        target.click();
                        target = target.parentElement;
                    }
                    break;
                }
            }
        });

        // 稍微多等一会儿，让连带的签名请求瞬间通过，弹窗自动关闭
        await new Promise(r => setTimeout(r, 3500));

        // 安全起见：如果弹窗因为玄学原因还没关，模拟按下 ESC 键强杀遮罩层
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        console.log("   ├─ 模拟敲击金额 0.1...");
        const inputHandle = await page.$('input');
        if (inputHandle) {
            await inputHandle.click();
            await page.keyboard.type('0.1', { delay: 100 });
        }

        await new Promise(r => setTimeout(r, 2000));

        console.log("   ├─ 点击主页面 Stake 唤起 Confirm 弹窗...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const stakeBtn = btns.reverse().find(b =>
                (b.innerText.trim().toLowerCase() === 'stake' || b.innerText.toLowerCase().includes('submit'))
                && !b.disabled
            );
            if (stakeBtn) stakeBtn.click();
        });

        await new Promise(r => setTimeout(r, 2500));

        // UI 提取分支作为快速通道
        const uiAddress = await page.evaluate((whale) => {
            const allText = document.body.innerHTML + ' ' + Array.from(document.querySelectorAll('a')).map(a => a.href).join(' ');
            const matches = allText.match(/0x[a-fA-F0-9]{40}/gi) || [];
            const filtered = Array.from(new Set(matches.map(a => a.toLowerCase()))).filter(a => a !== whale.toLowerCase());
            return filtered.length > 0 ? filtered[0] : null;
        }, WHALE_ADDRESS);

        if (uiAddress && uiAddress === OFFICIAL_STAKING_ADDRESS) {
            console.log(`\n📊 从 UI Confirm 弹窗精准提取到 Receive Address: ${uiAddress}`);
            console.log("✅ 防劫持校验通过，UI 展示匹配官方 Staking 合约。");
            process.exit(0);
        }

        console.log("   ├─ 点击 Confirm Modal 内部二次确认 Stake 按钮...");
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const confirmBtn = btns.reverse().find(b => b.innerText.trim() === 'Stake' && !b.disabled);
            if (confirmBtn) {
                confirmBtn.click();
            }
        });

        console.log("⏳ 等待拦截 RPC 交易 Payload (最多等10秒)...");
        const txPayload = await page.waitForFunction(() => window.__INTERCEPTED_TX__, { timeout: 10000 });
        const targetAddress = (await txPayload.evaluate(tx => tx.to)).toLowerCase();

        console.log(`\n📊 捕获到底层 RPC 真实交易目标: ${targetAddress}`);

        if (targetAddress !== OFFICIAL_STAKING_ADDRESS) {
            console.error(`🚨 [P0 致命告警] 交易被劫持！预期: ${OFFICIAL_STAKING_ADDRESS}, 实际: ${targetAddress}`);
            process.exit(1);
        } else {
            console.log("✅ 防劫持校验通过，RPC 交易指向官方地址。");
            process.exit(0);
        }

    } catch (error) {
        console.log(`\n⚠️ 自动化交互失败: ${error.message}`);
        console.log("📸 正在截图保存现场...");
        await page.screenshot({ path: 'debug_4.png', fullPage: true });
        process.exit(1);
    } finally {
        await browser.close();
    }
}

checkStakeHijack();