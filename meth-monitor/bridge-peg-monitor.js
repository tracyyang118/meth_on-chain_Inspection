import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const PROD_BASE_URL = 'https://app.methprotocol.xyz';
const SANDBOX_BASE_URL = 'https://lsp-frontend-sandbox-git-fix-replace-cms-mantle-sandbox.vercel.app';
const TARGET_PATH = '/explore';

const OLD_DOMAIN = 'cms.mantle.xyz';
const NEW_DOMAIN = 'cms.infra.methprotocol.xyz';

test.setTimeout(300000);

/**
 * 核心修复：突破 Next.js / Tailwind 局部 overflow 限制，抓取 100% 完整长图
 */
async function captureFullPageScreenshot(page, savePath) {
  // 1. 模拟平滑滚动，确保所有懒加载图片（Dapp Logos）加载完成
  await page.evaluate(async () => {
    const container = document.querySelector('main') || document.scrollingElement || document.body;
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = container.scrollHeight;
        container.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          container.scrollTo(0, 0);
          resolve();
        }
      }, 50);
    });
  });

  await page.waitForTimeout(1500);

  // 2. 解锁 CSS 高度限制，并计算出右侧 main 区域的真实总高度
  const realFullHeight = await page.evaluate(() => {
    const main = document.querySelector('main');

    // 强制把 main 和 body 的 overflow 设为 visible，解除 h-screen 封印
    if (main) {
      main.style.overflow = 'visible';
      main.style.height = 'auto';
      main.style.maxHeight = 'none';
    }
    document.body.style.overflow = 'visible';
    document.body.style.height = 'auto';
    document.documentElement.style.overflow = 'visible';
    document.documentElement.style.height = 'auto';

    // 取 main 内容高度和 body 高度的最大值
    const mainHeight = main ? main.scrollHeight : 0;
    const bodyHeight = document.body.scrollHeight;
    return Math.max(mainHeight, bodyHeight, 1000);
  });

  // 3. 将 Playwright 的窗口直接拉伸至网页的“实际真实高度”
  await page.setViewportSize({ width: 1440, height: Math.ceil(realFullHeight) });
  await page.waitForTimeout(500);

  // 4. 截图（视口已与长网页同高，不再被截断）
  await page.screenshot({ path: savePath });

  // 5. 还原视口默认尺寸，防止影响后续测试
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('跨环境视觉与网络比对：全景无截断长图对比', async ({ page }, testInfo) => {
  let interceptedImagesCount = 0;

  // 1. 网络请求拦截
  await page.route('**/_next/image*', async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.includes(OLD_DOMAIN) || requestUrl.includes(encodeURIComponent(OLD_DOMAIN))) {
      const modifiedUrl = requestUrl
        .replace(OLD_DOMAIN, NEW_DOMAIN)
        .replace(encodeURIComponent(OLD_DOMAIN), encodeURIComponent(NEW_DOMAIN));
      interceptedImagesCount++;
      await route.continue({ url: modifiedUrl });
    } else {
      await route.continue();
    }
  });

  const snapshotDir = testInfo.snapshotDir;
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }

  // ===================================================
  // 阶段一：PROD 环境 - 抓取 100% 全景基准图
  // ===================================================
  console.log('正在访问 PROD 环境并生成真实全景长图...');
  await page.goto(`${PROD_BASE_URL}${TARGET_PATH}`, { waitUntil: 'networkidle' });

  const prodMainPath = path.join(snapshotDir, 'explore-main-compare.png');
  await captureFullPageScreenshot(page, prodMainPath);

  await testInfo.attach('线上 PROD 100%全景长图', {
    path: prodMainPath,
    contentType: 'image/png'
  });

  // ===================================================
  // 阶段二：SANDBOX 环境 - 生成全景长图并对比
  // ===================================================
  console.log('正在访问 SANDBOX 环境进行全景比对...');
  await page.goto(`${SANDBOX_BASE_URL}${TARGET_PATH}`, { waitUntil: 'networkidle' });

  const sandboxMainPath = path.join(snapshotDir, 'sandbox-main-actual.png');
  await captureFullPageScreenshot(page, sandboxMainPath);

  await testInfo.attach('测试 SANDBOX 100%全景长图', {
    path: sandboxMainPath,
    contentType: 'image/png'
  });

  // 像素级全景图像比对
  await expect(page).toHaveScreenshot('explore-main-compare.png', {
    maxDiffPixelRatio: 0.05,
  });

  expect(interceptedImagesCount).toBeGreaterThan(0);
});