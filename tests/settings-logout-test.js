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
  page.on('dialog', d => d.accept());

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    // 店舗別PIN: staff01=1行目の店舗, staff02=2行目の店舗。PINはそれぞれ別のものにする
    window.__mockUsers = {
      'staff01@my-store-1234.local': { password: 'pin0001', user: { uid: 'u1', isAnonymous: false, email: 'staff01@my-store-1234.local', displayName: null } },
      'staff02@my-store-1234.local': { password: 'pin0002', user: { uid: 'u2', isAnonymous: false, email: 'staff02@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  // ===== 店舗1のPINでログイン =====
  await page.fill('#pinLoginInput', 'pin0001');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', 'みなと店'] });
  });
  await page.waitForTimeout(600);
  checkIncludes('staff01では1店舗目が自動選択される', await page.locator('#storeSwitchBtn').innerText(), '渋谷店');

  // ===== ⚙️設定からログアウトできること =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(250);
  check('logout button visible while signed in', true, await page.locator('#settingsLogoutBtn').isVisible());
  await page.click('#settingsLogoutBtn');
  await page.waitForTimeout(600);
  check('PIN overlay shown after logout', true, await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));
  check('side drawer closed after logout', false, await page.evaluate(() => document.getElementById('sideDrawer').classList.contains('open')));
  check('cached login email cleared', null, await page.evaluate(() => localStorage.getItem('cached_shared_login_email')));

  // ===== 店舗2のPINに切り替えられること (今回の目的) =====
  await page.fill('#pinLoginInput', 'pin0002');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(800);
  check('logged in as staff02', false, await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));
  checkIncludes('staff02に切り替えると2店舗目になる', await page.locator('#storeSwitchBtn').innerText(), 'みなと店');

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
