const puppeteer = require('puppeteer');

const OFFICIAL_UNSTAKE_MANAGER_ADDRESS = '0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9'.toLowerCase();
const WHALE_ADDRESS = '0x4aC943804e2492BeE7dBE5267dBfbd850287D6cB'.toLowerCase();

async function checkUnstakeHijack() {
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

    console.log("💉 正在注入【EIP-2612 Permit 签名嗅探型】虚拟钱包...");

    await page.evaluateOnNewDocument((whaleAddr) => {
        window.__INTERCEPTED_PERMIT__ = null;
        window.__INTERCEPTED_TX__ = null;

        window.ethereum = {
            isMetaMask: true,
            request: async (args) => {
                const { method, params } = args;

                if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [whaleAddr];
                if (method === 'eth_chainId') return '0x1';
                if (method === 'net_version') return '1';
                if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
                if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;

                // 🎯 核心拦截 1：捕获 EIP-2612 Permit 签名请求
                if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
                    try {
                        const typedData = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];

                        // 检查是不是 Permit 授权
                        if (typedData.primaryType === 'Permit' && typedData.message && typedData.message.spender) {
                             window.__INTERCEPTED_PERMIT__ = typedData.message.spender;
                        }
                    } catch (e) {
                        console.error("解析 TypedData 失败", e);
                    }

                    // 返回一个合法的假签名骗过前端
                    return '0x9924534a6e5585098ffb44bc6055d7a8d50bf23e59092490b411516a2b8e390c588040dbbb14cc590938f36c5df5359a0f5a7e584f295b9c037dae6b91cbb1591c';
                }

                // 🎯 核心拦截 2：兜底捕获直接发起的交易（如果巨鲸已经有授权）
                if (method === 'eth_sendTransaction') {
                    if (params && params[0] && params[0].to) {
                        window.__INTERCEPTED_TX__ = params[0].to;
                    }
                    return '0x' + 'f'.repeat(64);
                }

                // 代理底层查询
                try {
                    const res = await fetch('https://rpc.ankr.com/eth', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
                    });
                    const json = await res.json();
                    if (json.error) return (method === 'eth_call' || method === 'eth_estimateGas') ? '0x' : null;
                    return json.result;
                } catch (e) {
                    return (method === 'eth_call' || method === 'eth_estimateGas') ? '0x' : null;
                }
            }
        };
    }, WHALE_ADDRESS);

    console.log("🌐 访问 Unstake 页面...");
    await page.goto("https://app.methprotocol.xyz/unstake", { waitUntil: 'networkidle2' });

    try {
        console.log("🖱️ 执行交互...");
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
                        target.click();
                        target = target.parentElement;
                    }
                    break;
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

        // 轮询检查是否有结果
        const targetAddress = await page.evaluate(async () => {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (window.__INTERCEPTED_PERMIT__) {
                        clearInterval(check);
                        resolve({ type: 'Permit Signature', address: window.__INTERCEPTED_PERMIT__ });
                    } else if (window.__INTERCEPTED_TX__) {
                        clearInterval(check);
                        resolve({ type: 'Send Transaction', address: window.__INTERCEPTED_TX__ });
                    }
                }, 500);

                // 10秒超时
                setTimeout(() => {
                    clearInterval(check);
                    resolve(null);
                }, 10000);
            });
        });

        if (!targetAddress) {
            throw new Error("未截获到 Permit 签名或发包请求，前端可能未响应。");
        }

        const interceptedAddr = targetAddress.address.toLowerCase();

        console.log(`\n📊 成功捕获到前端意图 [类型: ${targetAddress.type}]`);
        console.log(`   └─ 授权/交互目标: ${interceptedAddr}`);

        if (interceptedAddr !== OFFICIAL_UNSTAKE_MANAGER_ADDRESS) {
            console.error(`🚨 [P0 致命告警] 业务链路被劫持！\n预期目标: ${OFFICIAL_UNSTAKE_MANAGER_ADDRESS}\n实际目标: ${interceptedAddr}`);
            process.exit(1);
        } else {
            console.log("✅ 防劫持校验通过，Permit 授权目标正确指向官方 UnstakeRequestsManager！");
            process.exit(0);
        }

    } catch (error) {
        console.log(`\n⚠️ 自动化交互执行异常: ${error.message}`);
        await page.screenshot({ path: 'debug_unstake_permit_fail.png', fullPage: true });
        process.exit(1);
    } finally {
        await browser.close();
    }
}

checkUnstakeHijack();