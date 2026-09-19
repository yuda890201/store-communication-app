// 店舗共通PINの変更が、管理者としてログイン中でも実行できることの確認。
//
// オーナー設定は管理者の個人アカウントでないと開けず、PIN変更は共通アカウントで
// ないと実行できない。以前はこの2つを同時に満たせず、アプリが案内するログアウトも
// オーナー設定を閉じないと押せなかったため、通常のUI操作でPINを変更できなかった。
const { chromium } = require('playwright');
const { check, checkIncludes, info, report } = require('./assert');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => d.accept());

  await page.addInitScript(fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8'));
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.firebase.firestore().collection('appSettings').doc('general')
    .set({ adminEmails: ['owner@test.example.com'] }, { merge: true }));
  await page.waitForTimeout(400);

  // ===== 管理者としてログインしてオーナー設定を開く（実運用と同じ順序） =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(500);
  check('オーナー設定が開く', true, await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));
  check('このとき管理者としてログインしている', 'owner@test.example.com',
    await page.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.email));

  await page.click('#ownerDrawer details summary:has-text("PINコードの変更")');
  await page.waitForTimeout(200);

  // ===== 管理者のままPINを変更できること =====
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'newpin99');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(600);
  checkIncludes('管理者としてログイン中でもPINを変更できる',
    await page.locator('#pinChangeStatus').innerText(), 'PINコードを変更しました');

  // ===== 管理者のセッションが壊れていないこと =====
  check('変更後も管理者としてログインしたまま', 'owner@test.example.com',
    await page.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.email));
  check('変更後も isAdminUser', true, await page.evaluate(() => isAdminUser));
  await page.evaluate(() => closeOwnerDrawer());
  await page.waitForTimeout(150);
  await page.evaluate(() => openOwnerDrawer());
  await page.waitForTimeout(300);
  check('閉じたあともオーナー設定を開き直せる', true,
    await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));

  // ===== 実際にPINが入れ替わっていること =====
  const signIn = await page.evaluate(async () => {
    const app = window.firebase.apps.find(a => a.name === 'probeApp')
      || window.firebase.initializeApp({ apiKey: 'mock', projectId: 'my-store-1234' }, 'probeApp');
    const out = {};
    try { await app.auth().signInWithEmailAndPassword('staff@my-store-1234.local', 'pin1234'); out.old = true; }
    catch (e) { out.old = false; }
    try { await app.auth().signInWithEmailAndPassword('staff@my-store-1234.local', 'newpin99'); out.next = true; }
    catch (e) { out.next = false; }
    return out;
  });
  check('古いPINでは入れなくなる', false, signIn.old);
  check('新しいPINで入れる', true, signIn.next);

  // ===== 間違った現在PINでは変更できないこと =====
  await page.fill('#pinChangeCurrentInput', 'wrongpin');
  await page.fill('#pinChangeNewInput', 'another99');
  await page.fill('#pinChangeConfirmInput', 'another99');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(600);
  checkIncludes('現在のPINが違えば変更できない',
    await page.locator('#pinChangeStatus').innerText(), '正しくない');
  check('失敗しても管理者のセッションは壊れない', 'owner@test.example.com',
    await page.evaluate(() => firebase.auth().currentUser && firebase.auth().currentUser.email));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
