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
      'staff01@my-store-1234.local': { password: 'pinA111', user: { uid: 'shared-uid-1', isAnonymous: false, email: 'staff01@my-store-1234.local', displayName: null } },
      'staff02@my-store-1234.local': { password: 'pinB222', user: { uid: 'shared-uid-2', isAnonymous: false, email: 'staff02@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  // ===== staff02のPINでログイン -> 2店舗目が自動選択されることを期待 =====
  await page.fill('#pinLoginInput', 'pinB222');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  // ログイン後、appSettingsに店舗一覧を設定 (渋谷店=1行目=staff01, 新宿店=2行目=staff02)
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(400);

  const activeStoreAfterStaff02 = await page.evaluate(() => activeStore);
  check('staff02のPINで2店舗目が選ばれる', '新宿店', activeStoreAfterStaff02);
  const storeBtnText = await page.locator('#storeSwitchBtn').innerText();
  checkIncludes('店舗切替ボタンの表示', storeBtnText, '新宿店');

  // ===== ログアウトしてstaff01のPINで再ログイン -> 1店舗目が自動選択されることを期待 =====
  // (実運用では毎回ページを新規に開いてログインするため appSettings の onSnapshot が
  //  ログイン直後に必ず一度発火するが、このテストは同一ページ内でログインし直すため
  //  onSnapshot を明示的に再発火させて、実運用と同じ状況を再現する)
  await page.evaluate(async () => { await firebase.auth().signOut(); });
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pinA111');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] }, { merge: true });
  });
  await page.waitForTimeout(400);
  const activeStoreAfterStaff01 = await page.evaluate(() => activeStore);
  check('staff01のPINで1店舗目が選ばれる', '渋谷店', activeStoreAfterStaff01);

  // ===== 間違ったPINではログイン失敗すること =====
  await page.evaluate(async () => { await firebase.auth().signOut(); });
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'wrongpin');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(1500);
  checkIncludes('違うPINのときの文言', await page.locator('#pinLoginStatus').innerText(), 'PINコードが違います');
  check('pin overlay still open after wrong pin', true, await page.locator('#pinLoginOverlay').evaluate(el => el.classList.contains('open')));

  // ===== 正しいPINで再度ログインし直せること =====
  await page.fill('#pinLoginInput', 'pinA111');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);
  check('pin overlay closed after correct retry', false, await page.locator('#pinLoginOverlay').evaluate(el => el.classList.contains('open')));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
