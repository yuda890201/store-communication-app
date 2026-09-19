const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    // アプリ全体がPINログインで保護されている。これらのテストはPIN導入前に
    // 書かれたもので、ログインしないとPIN画面が全クリックを遮る
    window.__mockUsers = {
      'staff@mock.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@mock.local', displayName: null } }
    };
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['本店'] });
  });
  await page.waitForTimeout(800);
  const modalOpen = await page.locator('#storePickerOverlay').evaluate(el => el.classList.contains('open'));
  const headerText = await page.locator('#storeSwitchBtn').innerText();
  check('modal open with single store', false, modalOpen);
  check('1店舗なら自動で選ばれて見出しに出る', '📍 本店 ▾', headerText);
  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
