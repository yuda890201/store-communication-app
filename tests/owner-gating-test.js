const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => { info('dialog', d.message()); d.accept(); });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      'owner@example.com': { password: 'ownerpass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@example.com', displayName: null } },
      'staff2@example.com': { password: 'staffpass1', user: { uid: 'staff2-uid', isAnonymous: false, email: 'staff2@example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      adminEmails: ['owner@example.com']
    }, { merge: true });
  });
  await page.waitForTimeout(300);

  // ===== 共通PINログインのみ (owner未ログイン) で🔒オーナー設定を開こうとする =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  check('未ログインではオーナー設定を開けない', false, await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));
  check('ownerLoginPrompt visible', true, await page.locator('#ownerLoginPrompt').isVisible());

  // ===== 管理者未登録の個人アカウントでログイン試行 -> 拒否される =====
  await page.fill('#ownerLoginEmail', 'staff2@example.com');
  await page.fill('#ownerLoginPassword', 'staffpass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(300);
  check('after non-admin login attempt, ownerDrawer open', false, await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));
  checkIncludes('管理者以外は拒否される', await page.locator('#ownerLoginStatus').innerText(), '登録されていません');

  // ===== 正しいオーナーアカウントでログイン -> 開ける =====
  await page.fill('#ownerLoginEmail', 'owner@example.com');
  await page.fill('#ownerLoginPassword', 'ownerpass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  check('after admin login, ownerDrawer open', true, await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));
  check('ownerLoginPrompt hidden', true, !(await page.locator('#ownerLoginPrompt').isVisible()));
  check('isAdminUser', true, await page.evaluate(() => isAdminUser));

  // 引継ぎ項目のシード操作が管理者としてなお機能すること
  await page.click('button[onclick="seedDefaultHandoverItems()"]');
  await page.waitForTimeout(400);
  const itemCount = await page.locator('#handoverItemList .task-row-label').count();
  check('handoverItems seeded while admin', 10, itemCount);

  // ===== 一度閉じて再度開くと、既にadminなのでプロンプトなしで直接開く =====
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  check('re-open as already-admin, ownerDrawer open directly', true, await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
