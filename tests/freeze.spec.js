const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const { authenticator } = require('otplib');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const DISCORD_2FA = process.env.DISCORD_2FA || '';

const TIMEOUT = 120000;

// 🛡️ 尝试关闭广告
async function tryCloseAds(page) {
    const adCloseSelectors = ['button[aria-label="Close"]', '.close-button', 'div[class*="ad"] button[class*="close"]'];
    for (const selector of adCloseSelectors) {
        try {
            const closeBtn = page.locator(selector).first();
            if (await closeBtn.isVisible({ timeout: 500 })) {
                await closeBtn.click();
                await page.waitForTimeout(500);
            }
        } catch { }
    }
}

// 📨 发送合并的 TG 消息 (加入了金币变量)
function sendTG(resultText, coinBalance) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        
        // 按照你的要求排版：结果 -> 金币 -> 官网
        const msg = `🎮 FreezeHost 续期报告\n\n${resultText}\n\n💰 账户余额：${coinBalance} 金币\n\n官网地址：https://free.freezehost.pro/`;

        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, (res) => resolve());

        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.write(JSON.stringify({ chat_id: TG_CHAT_ID, text: msg }));
        req.end();
    });
}

test('FreezeHost 多服务器自动续期', async () => {
    test.setTimeout(TIMEOUT); 
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) throw new Error('缺少 DISCORD_ACCOUNT');

    let proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    
    let reportLines = []; 
    let coinBalance = "未知"; // 初始化金币变量

    try {
        console.log('🔑 访问并登录 FreezeHost...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
        await page.click('span.text-lg:has-text("Login with Discord")');
        await page.locator('button#confirm-login').waitFor({ state: 'visible' });
        await page.click('button#confirm-login');

        await page.waitForURL(/discord\.com\/login/, { timeout: 30000 });
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);
        await page.click('button[type="submit"]');

        const twoFaInput = page.locator('input[autocomplete="one-time-code"], input[placeholder*="6"]');
        if (await twoFaInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('🔐 自动填写 2FA...');
            const token = authenticator.generate(DISCORD_2FA.replace(/\s/g, ''));
            await twoFaInput.fill(token);
            await page.click('button[type="submit"]');
        }

        await page.waitForTimeout(5000);
        const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")');
        if (await authBtn.isVisible().catch(() => false)) await authBtn.click();

        await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
        console.log('✅ 登录成功，开始获取账户数据...');

        await page.waitForTimeout(4000);

        // 🚀 新增功能：智能提取金币余额
        try {
            console.log('🔍 正在抓取金币余额...');
            coinBalance = await page.evaluate(() => {
                // 暴力检索整个网页的纯文本寻找余额特征
                const bodyText = document.body.innerText;
                const match1 = bodyText.match(/AVAILABLE BALANCE\s*([\d,]+)/i);
                const match2 = bodyText.match(/([\d,]+)\s*GLOBAL CURRENCY/i);
                
                if (match1) return match1[1];
                if (match2) return match2[1];
                return "未知";
            });
            console.log(`💰 当前金币余额：${coinBalance}`);
        } catch (e) {
            console.log('⚠️ 获取金币失败:', e.message);
        }

        // 🚀 提取服务器名称
        const servers = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="server-console"]'));
            return links.map((link, idx) => {
                let el = link;
                let cardText = '';
                while (el && el.tagName !== 'BODY') {
                    if (el.innerText && (el.innerText.includes('ID:') || el.innerText.includes('Node:'))) {
                        cardText = el.innerText;
                        break;
                    }
                    el = el.parentElement;
                }

                let name = `服务器-${idx + 1}`;
                if (cardText) {
                    const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    if (lines.length > 0) name = lines[0];
                }
                return { name: name.toUpperCase(), url: link.href };
            });
        });

        if (servers.length === 0) throw new Error('未发现任何服务器链接');
        console.log(`✅ 共找到 ${servers.length} 台服务器，准备依次处理`);

        for (const srv of servers) {
            console.log(`\n▶️ 开始处理: [${srv.name}]`);
            await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);

            const renewalStatusText = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim());
            let remainingText = "获取失败";
            let needRenew = true;

            if (renewalStatusText) {
                const daysMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
                const hoursMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*hour/i);
                
                const days = daysMatch ? parseInt(daysMatch[1]) : 0;
                const hoursRaw = hoursMatch ? parseFloat(hoursMatch[1]) : 0;
                
                const hours = Math.floor(hoursRaw);
                const minutes = Math.round((hoursRaw - hours) * 60);
                
                remainingText = `${days}天 ${hours}小时 ${minutes}分钟`;

                if (days > 7) {
                    needRenew = false;
                    reportLines.push(`${srv.name} : ⏳ 未到期 (剩余: ${remainingText})`);
                    console.log(`  ⏰ 剩余 ${remainingText}，无需操作`);
                }
            }

            if (!needRenew) continue;

            console.log(`  ✅ 准备续费 [${srv.name}] ...`);
            await tryCloseAds(page);

            const visibleParent = page.locator('i.fa-external-link-alt').locator('xpath=..').filter({ state: 'visible' }).first();
            await visibleParent.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
            
            if (await visibleParent.count() > 0) {
                await visibleParent.hover();
                await page.waitForTimeout(1000);
                await visibleParent.locator('i.fa-external-link-alt').click({ force: true });
                await page.waitForTimeout(2000);
                await tryCloseAds(page);

                const renewBtn = page.locator('#renew-link-modal');
                await renewBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

                if (await renewBtn.isVisible()) {
                    const btnText = (await renewBtn.innerText()).trim();
                    if (btnText.toLowerCase().includes('renew instance')) {
                        const renewUrl = await renewBtn.getAttribute('href');
                        await page.goto(new URL(renewUrl, page.url()).href, { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(5000);

                        if (page.url().includes('success=RENEWED')) {
                            reportLines.push(`${srv.name} : ✅ 成功续期`);
                        } else if (page.url().includes('err=CANNOTAFFORDRENEWAL')) {
                            reportLines.push(`${srv.name} : ❌ 余额不足`);
                        } else if (page.url().includes('err=TOOEARLY')) {
                            reportLines.push(`${srv.name} : ⏳ 未到期 (剩余: ${remainingText})`);
                        } else {
                            reportLines.push(`${srv.name} : ⚠️ 状态未知`);
                        }
                    } else {
                        reportLines.push(`${srv.name} : ⏳ 未到期 (按钮: ${btnText})`);
                    }
                } else {
                    reportLines.push(`${srv.name} : ⚠️ 弹窗未显示`);
                }
            } else {
                reportLines.push(`${srv.name} : ⚠️ 未找到续期图标`);
            }
        }

    } catch (e) {
        console.error(`❌ 致命错误: ${e.message}`);
        reportLines.push(`❌ 脚本运行异常: ${e.message}`);
    } finally {
        if (reportLines.length > 0) {
            // 在发送函数中传入提取到的金币变量
            await sendTG(reportLines.join('\n'), coinBalance);
        }
        await browser.close();
    }
});
