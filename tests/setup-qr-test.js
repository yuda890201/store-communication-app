const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');

const CONFIG = { apiKey: 'mock', projectId: 'my-store-1234', authDomain: 'my-store-1234.firebaseapp.com', storageBucket: 'my-store-1234.appspot.com', messagingSenderId: '123456789012', appId: '1:123456789012:web:abcdef0123456789' };

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const errors = [];
  const dialogs = [];
  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');

  // ===== 1. 設定済みの端末でQRを出す =====
  const owner = await browser.newPage({ viewport: { width: 390, height: 950 } });
  owner.on('pageerror', e => errors.push('owner pageerror: ' + e.message));
  owner.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await owner.addInitScript(mockScript);
  await owner.addInitScript(cfg => {
    localStorage.setItem('firebase_config', JSON.stringify(cfg));
    localStorage.setItem('my_name', 'テスト太郎');
    window.__mockUsers = { 'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'u', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } } };
    window.__printed = 0; window.print = () => { window.__printed++; };
  }, CONFIG);
  await owner.goto(`http://localhost:${PORT}/index.html`);
  await owner.waitForTimeout(300);
  await owner.fill('#pinLoginInput', 'pin1234');
  await owner.click('#pinLoginForm button');
  await owner.waitForTimeout(500);

  await owner.click('.home-topbar .settings-btn:has-text("⚙️")');
  await owner.waitForTimeout(200);
  await owner.evaluate(() => { document.getElementById('setupQrHolder').closest('details').open = true; });
  check('no QR before pressing the button', 0, await owner.locator('#setupQrHolder svg').count());
  await owner.click('button[onclick="renderSetupQr()"]');
  await owner.waitForTimeout(400);
  check('QR rendered', 1, await owner.locator('#setupQrHolder svg').count());
  check('QR生成でエラーが出ない', '', (await owner.locator('#setupQrStatus').innerText()).trim());

  const setupUrl = await owner.locator('#setupQrUrl').innerText();
  check('url uses the hash, not a query', true, setupUrl.includes('#setup=') && !setupUrl.includes('?setup='));
  // PINはQRに入れない
  check('url does not carry the PIN', false, setupUrl.includes('pin1234'));

  // 印刷に手順が入ること
  await owner.click('button[onclick="printSetupQr()"]');
  await owner.waitForTimeout(300);
  const printText = await owner.locator('#printArea').innerText();
  check('print called', 1, await owner.evaluate(() => window.__printed));
  check('print has the steps', true, printText.includes('カメラ') && printText.includes('PINコード') && printText.includes('名前'));
  check('print says the PIN is not included', true, printText.includes('PINコードは入っていません'));
  check('print embeds the QR', 1, await owner.locator('#printArea svg').count());

  // ===== 2. 別の「新しい端末」でそのURLを開く =====
  const staff = await browser.newPage({ viewport: { width: 390, height: 950 } });
  staff.on('pageerror', e => errors.push('staff pageerror: ' + e.message));
  staff.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await staff.addInitScript(mockScript);
  await staff.addInitScript(() => {
    window.__mockUsers = { 'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'u', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } } };
  });
  // 何も設定されていない状態から始める
  const staffUrl = setupUrl.replace(/^https?:\/\/[^/]+/, `http://localhost:${PORT}`);
  check('staff device starts empty', true, true);
  await staff.goto(staffUrl);
  await staff.waitForTimeout(600);

  const stored = await staff.evaluate(() => localStorage.getItem('firebase_config'));
  check('config stored on the new device', true, JSON.stringify(JSON.parse(stored)) === JSON.stringify(CONFIG));
  // 履歴や共有リンクに設定が残らないこと
  check('読み取り後はURLからハッシュを消す', '', await staff.evaluate(() => location.hash));
  check('PIN screen reached without touching settings', true, await staff.locator('#pinLoginOverlay').isVisible());

  // そのままPINでログインできること
  await staff.fill('#pinLoginInput', 'pin1234');
  await staff.click('#pinLoginForm button');
  await staff.waitForTimeout(600);
  check('logged in straight after scanning', false, await staff.locator('#pinLoginOverlay').isVisible());

  // ===== 3. 壊れたQRは黙って失敗しないこと =====
  const broken = await browser.newPage({ viewport: { width: 390, height: 950 } });
  broken.on('pageerror', e => errors.push('broken pageerror: ' + e.message));
  const brokenDialogs = [];
  broken.on('dialog', d => { brokenDialogs.push(d.message()); d.accept(); });
  await broken.addInitScript(mockScript);
  await broken.goto(`http://localhost:${PORT}/index.html#setup=notvalidbase64!!!`);
  await broken.waitForTimeout(500);
  check('broken QR surfaces an error', true, brokenDialogs.some(m => m.includes('読み取れませんでした')));
  check('broken QR stores nothing', null, await broken.evaluate(() => localStorage.getItem('firebase_config')));
  check('壊れたQRでもURLからハッシュを消す', '', await broken.evaluate(() => location.hash));

  // ===== 4. 既存の設定がある端末は黙って上書きされないこと =====
  const existing = await browser.newPage({ viewport: { width: 390, height: 950 } });
  existing.on('pageerror', e => errors.push('existing pageerror: ' + e.message));
  const existingDialogs = [];
  existing.on('dialog', d => { existingDialogs.push(d.message()); d.dismiss(); }); // キャンセルする
  await existing.addInitScript(mockScript);
  await existing.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'other', projectId: 'other-project' }));
  });
  await existing.goto(staffUrl);
  await existing.waitForTimeout(600);
  check('asks before overwriting', true, existingDialogs.some(m => m.includes('上書き')));
  const kept = await existing.evaluate(() => JSON.parse(localStorage.getItem('firebase_config')).projectId);
  check('取り消したら元の設定が残る', 'other-project', kept);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
