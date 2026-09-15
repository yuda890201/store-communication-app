const { chromium } = require('playwright');
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
  console.log('store auto-selected for staff01 (expect 渋谷店):', await page.locator('#storeSwitchBtn').innerText());

  // ===== ⚙️設定からログアウトできること =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(250);
  console.log('logout button visible while signed in (expect true):', await page.locator('#settingsLogoutBtn').isVisible());
  await page.click('#settingsLogoutBtn');
  await page.waitForTimeout(600);
  console.log('PIN overlay shown after logout (expect true):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));
  console.log('side drawer closed after logout (expect false):', await page.evaluate(() => document.getElementById('sideDrawer').classList.contains('open')));
  console.log('cached login email cleared (expect null):', await page.evaluate(() => localStorage.getItem('cached_shared_login_email')));

  // ===== 店舗2のPINに切り替えられること (今回の目的) =====
  await page.fill('#pinLoginInput', 'pin0002');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(800);
  console.log('logged in as staff02 (expect false = overlay closed):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));
  console.log('store switched to staff02 store (expect みなと店):', await page.locator('#storeSwitchBtn').innerText());

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
