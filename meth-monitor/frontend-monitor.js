require('dotenv').config();
const puppeteer = require('puppeteer');
const axios = require('axios');

// ==========================================
// 1. 核心配置
// ==========================================
const TARGET_URL = "https://app.methprotocol.xyz/stats/meth/contracts";

// 🛡️ 完整官方安全白名单 (共包含页面上展示的 33 个独立官方地址)
const CORE_OFFICIAL_WHITELIST = [
    "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa", // mETH Token L1
    "0xcDA86A272531e8640cD7F1a92c01839911B90bb0", // mETH Token L2
    "0x4f24535e67EbBDB274a1a7AA3E33339E05F0E46d", // mETH L1/L2 Adapter
    "0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA", // cmETH L1/L2
    "0x4aFA9620D0B79137383A7A9AB3477837d475e948", // cmETH L1 Adapter
    "0x9F0C013016E8656bC256f948CD4B79ab25c7b94D", // COOK L1/L2
    "0xC14459931cF666DCcAd582D63288AefB9f0bDca9", // COOK L1 Adapter
    "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f", // Staking
    "0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9", // UnstakeRequestsManager
    "0x8735049F496727f824Cc0f2B174d826f5c408192", // Oracle
    "0x92e56d2146D54d5AEcB25CA36c89D027a6ea0D90", // OracleQuorumManager
    "0x1766be66fBb0a1883d41B4cfB0a533c5249D3b82", // ReturnsAggregator
    "0xD4e11C28E04c0c2bf370b7a9989498B7eA02493f", // ConsensusLayerReceiver
    "0xD6E4aA932147A3FE5311dA1b67D9e73da06F9cEf", // ExecutionLayerReceiver
    "0x29Ab878aEd032e2e2c86FF4A9a9B05e3276cf1f8", // Pauser
    "0xc26016f1166bE7b6c5611AAB104122E0f6c2aCE2", // ProxyAdmin (Timelock)
    "0x7A3c0C5fADde89185947639f256A3AC3D162CEbB", // EigenLayer Claim
    "0x7298d8995eb7A932b36A77FcC44dC0cFdCe74De8", // COOK Address Mapping
    "0x33272D40b247c4cd9C646582C9bbAD44e85D4fE4", // BoringVault
    "0x52EA8E95378d01B0aaD3B034Ca0656b0F0cc21A2", // PositionManagerKarak
    "0x919531146f9a25dfc161d5ab23b117feae2c1d36", // PositionManagerSymbiotic
    "0x5bb8e5e8602b71b182e0Efe256896a931489A135", // PositionManagerSymbioticV2
    "0x021180A06Aa65A7B5fF891b5C146FbDaFC06e2DA", // PositionManagerEigen1
    "0x0b5d15445b715bf117ba0482b7a9f772af46d93a", // PositionManagerEigenP2PV2
    "0x6DfbE3A1a0e835C125EEBb7712Fffc36c4D93b25", // PositionManagerEigen2
    "0xCaC15044a1F67238D761Aa4C7650DaB59cEF849D", // PositionManagerEigenA41V2
    "0x12Be34bE067Ebd201f6eAf78a861D90b2a66B113", // DelayedWithdraw
    "0x7c22725d1e0871f0043397c9761ad99a86ffd498", // RestakingPoolKarak & Karak mETH
    "0x475d3eb031d250070b63fa145f0fcfc5d97c304a", // RestakingPoolSymbioticRestakingPool
    "0xbA60b6969fAA9b927A0acc750Ea8EEAdcEd644B7", // RestakingPoolSymbioticRestakingPoolV2
    "0x298aFB19A105D59E74658C4C334Ff360BadE6dd2", // RestakingPoolEigen
    "0x006FaD88c35D973A87E451CF8D000c7e83Dad409", // LiquidityBuffer
    "0x8c555854b53F254cfe8B8b0D037139856585ed4e"  // PortfolioDistrabutor
];

// 飞书告警 Webhook 发送模块
async function triggerAlert(message) {
    const WEBHOOK_URL = process.env.FEISHU_WEBHOOK;
    if (!WEBHOOK_URL) return;
    await axios.post(WEBHOOK_URL, {
        msg_type: "text",
        content: { text: message }
    }).catch(e => console.error("告警发送失败:", e.message));
}

// ==========================================
// 2. 核心逻辑：Puppeteer 无头抓取与全量断言
// ==========================================
async function checkFrontendIntegrity() {
    console.log(`\n[${new Date().toISOString()}] 🔍 正在启动无头浏览器抓取前端页面...`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log(`   ├─ 正在访问官网: ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // 获取页面所有纯文本内容
        const pageText = await page.evaluate(() => document.body.innerText);

        // 提取所有的 Ethereum 地址并全部转为小写
        const ethAddressRegex = /0x[a-fA-F0-9]{40}/gi;
        const matchedAddresses = pageText.match(ethAddressRegex) || [];

        // 使用 Set 去重
        const pageAddressesSet = new Set(matchedAddresses.map(addr => addr.toLowerCase()));

        // 对白名单去重（预防配置时手抖写重复）
        const uniqueWhitelistSet = new Set(CORE_OFFICIAL_WHITELIST.map(addr => addr.toLowerCase()));

        console.log(`📊 防篡改核对单:`);
        console.log(`   ├─ 页面共抓取到 : ${pageAddressesSet.size} 个独立地址`);
        console.log(`   └─ 核心白名单要求 : ${uniqueWhitelistSet.size} 个独立官方合约地址必须全部存活`);

        // -----------------------------------------------------------
        // 🚨 核心断言：【所有】白名单内的地址，必须无一漏网地出现在网页上
        // (注：该逻辑自动包容了页面右上角用户连接的个人钱包地址，防止误报)
        // -----------------------------------------------------------
        const missingAddresses = [];

        uniqueWhitelistSet.forEach(officialAddr => {
            if (!pageAddressesSet.has(officialAddr)) {
                missingAddresses.push(officialAddr);
            }
        });

        if (missingAddresses.length > 0) {
            const errorMsg =
                `🚨 [P0 致命告警] 官网前端核心地址被篡改/丢失！\n` +
                `黑客可能已经替换了关键交互地址，导致以下官方合约在页面上消失：\n\n` +
                `❌ 丢失/被篡改的地址:\n${missingAddresses.join('\n')}\n\n` +
                `请立即下线前端，检查代码托管平台是否被投毒！`;

            console.error(errorMsg);
            await triggerAlert(errorMsg);
        } else {
            console.log(`✅ 校验通过：所有 ${uniqueWhitelistSet.size} 个官方合约地址均在页面上正常渲染，未发现钓鱼篡改。`);
        }

    } catch (error) {
        console.error(`⚠️ [P1 告警] 无头浏览器访问失败: ${error.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

// 立即执行一次
checkFrontendIntegrity();

// ==========================================
// 3. 设置执行频率：每 3 分钟循环执行一次
// ==========================================
//const THREE_MINUTES = 3 * 60 * 1000;
//setInterval(checkFrontendIntegrity, THREE_MINUTES);
console.log(`🎧 前端防投毒监控探针 (全量覆盖版) 已启动...`);