const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());

  await page.addInitScript(fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8'));
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '博多住吉通り');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      'owner@example.com': { password: 'owner-pass1', user: { uid: 'owner', isAnonymous: false, email: 'owner@example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);

  // 実際の並び（1行目=博多住吉通り）で登録する
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['博多住吉通り', '清川二丁目'], adminEmails: ['owner@example.com']
    });
  });
  await page.waitForTimeout(400);

  // 店舗が2つ以上あると起動時に店舗選択モーダルが開き、クリックを遮る
  if (await page.locator('.store-option-btn:has-text("博多住吉通り")').isVisible().catch(() => false)) {
    await page.click('.store-option-btn:has-text("博多住吉通り")');
    await page.waitForTimeout(200);
  }
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(200);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(500);

  // ===== 保存済みの並びがそのまま対応表になること =====
  check('rows shown', 2, await page.locator('#storePinMap .store-pin-map-row').count());
  const row1 = await page.locator('#storePinMap .store-pin-map-row').nth(0).innerText();
  const row2 = await page.locator('#storePinMap .store-pin-map-row').nth(1).innerText();
  info('row1', JSON.stringify(row1.replace(/\s+/g, ' ')));
  info('row2', JSON.stringify(row2.replace(/\s+/g, ' ')));
  check('row1 maps to staff01', true, row1.includes('博多住吉通り') && row1.includes('staff01@'));
  check('row2 maps to staff02', true, row2.includes('清川二丁目') && row2.includes('staff02@'));
  check('no overflow warning for 2 stores', 0, await page.locator('#storePinMap .store-pin-map-note').count());

  // ===== 並べ替えると対応表もその場で変わること =====
  await page.fill('#storesInput', '清川二丁目\n博多住吉通り');
  await page.waitForTimeout(200);
  const swapped1 = await page.locator('#storePinMap .store-pin-map-row').nth(0).innerText();
  check('after reorder, staff01 follows the new 1st row', true, swapped1.includes('清川二丁目') && swapped1.includes('staff01@'));

  // ===== 6行目以降は店舗別PINが無いと警告すること =====
  await page.fill('#storesInput', ['A店','B店','C店','D店','E店','F店'].join('\n'));
  await page.waitForTimeout(200);
  check('rows shown for 6 stores', 6, await page.locator('#storePinMap .store-pin-map-row').count());
  const sixth = await page.locator('#storePinMap .store-pin-map-row').nth(5).innerText();
  check('6th row says it has no store PIN', true, sixth.includes('店舗別PINなし'));
  check('overflow warning shown', 1, await page.locator('#storePinMap .store-pin-map-note').count());
  const note = await page.locator('#storePinMap .store-pin-map-note').innerText();
  check('warning names the real limit', true, note.includes('staff06@') && note.includes('staff05@'));
  // 5行目までは従来どおり出ること
  const fifth = await page.locator('#storePinMap .store-pin-map-row').nth(4).innerText();
  check('5th row still has a PIN', true, fifth.includes('staff05@'));

  // ===== 空にしたら何も出さないこと =====
  await page.fill('#storesInput', '');
  await page.waitForTimeout(200);
  check('nothing shown when empty', 0, await page.locator('#storePinMap .store-pin-map-row').count());

  // ===== 実際のログインと表示が食い違わないこと =====
  // 表示は staff01→1行目。実際に staff01 でログインして同じ店舗が選ばれるか確かめる
  await page.evaluate(() => {
    window.__mockUsers['staff01@my-store-1234.local'] = { password: 'store01pin', user: { uid: 's01', isAnonymous: false, email: 'staff01@my-store-1234.local', displayName: null } };
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['博多住吉通り', '清川二丁目'] }, { merge: true });
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { localStorage.removeItem('cached_shared_login_email'); });
  await page.evaluate(() => firebase.auth().signOut());
  await page.waitForTimeout(400);
  await page.fill('#pinLoginInput', 'store01pin');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(700);
  const active = await page.evaluate(() => window.localStorage.getItem('active_store'));
  check('staff01のPINで実際に1行目の店舗が選ばれる', '博多住吉通り', active);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
