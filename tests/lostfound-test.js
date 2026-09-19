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
  page.on('dialog', d => {
    info('dialog', d.message());
    if (d.type() === 'prompt') d.accept('山田太郎');
    else d.accept();
  });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    // アプリ全体がPINログインで保護されている。これらのテストはPIN導入前に
    // 書かれたもので、ログインしないとPIN画面が全クリックを遮る
    window.__mockUsers = {
      'staff@mock.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@mock.local', displayName: null } },
      // オーナー設定は管理者の個人アカウントでのログインが要るようになった
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
    };
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.print = () => { window.__printCalled = (window.__printCalled || 0) + 1; };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ adminEmails: ['owner@test.example.com'], stores: ['渋谷店'] });
  });
  await page.waitForTimeout(200);

  await page.click(`.grid-card[onclick="openView('lostfound')"]`);
  await page.waitForTimeout(150);

  // ===== owner settings: fill store info =====
  await page.click('[data-view="lostfound"] .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  await page.waitForTimeout(150);
  await page.click('#ownerDrawer details summary:has-text("忘れ物・警察届出設定")');
  await page.waitForTimeout(100);
  await page.fill('#lostStoreNameInput', 'テスト商店 渋谷店');
  await page.fill('#lostStoreAddressInput', '東京都渋谷区1-2-3');
  await page.fill('#lostStorePhoneInput', '03-1111-2222');
  await page.fill('#lostOccupantCodeInput', 'OCC-999');
  await page.click('button[onclick="saveLostFoundSettings()"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'lf01-owner-settings.png') });
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // ===== register a valuable item (found today) =====
  await page.click('[data-view="lostfound"] details summary');
  await page.waitForTimeout(100);
  await page.fill('#lostTitleInput', '黒い財布');
  await page.fill('#lostDescInput', '中に現金と診察券');
  await page.fill('#lostLocationInput', 'レジ横');
  const today = new Date().toISOString().slice(0, 10);
  await page.fill('#lostDateInput', today);
  await page.check('#lostValuableTagGroup input[value="財布"]');
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(300);

  // ===== register a normal item with foundDate 4 months ago (for 3-month reminder) =====
  const fourMonthsAgo = new Date();
  fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
  const oldDate = fourMonthsAgo.toISOString().slice(0, 10);
  await page.fill('#lostTitleInput', '古い傘');
  await page.fill('#lostDescInput', '黒い折りたたみ傘');
  await page.fill('#lostLocationInput', '入口');
  await page.fill('#lostDateInput', oldDate);
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'lf02-list-with-reminders.png') });

  // 画面内のリマインドカード（#lostReminders）と、それをタップして一覧を絞る機能は
  // 廃止され、自動投稿のリマインドに置き換わった（reminders-test.js が後継）。
  // ここでは一覧に2件とも出ていることだけ確かめる
  check('list shows both items', 2, await page.locator('#lostList .card').count());

  // ===== print memo for the wallet =====
  await page.evaluate(() => { window.__printCalled = 0; });
  const walletCard = page.locator('#lostList .card', { hasText: '黒い財布' });
  await walletCard.locator('button', { hasText: 'メモを印刷' }).click();
  await page.waitForTimeout(150);
  const printCalledMemo = await page.evaluate(() => window.__printCalled);
  const printAreaMemoHtml = await page.locator('#printArea').innerHTML();
  info('print called for memo', printCalledMemo);
  info('print area contains title', printAreaMemoHtml.includes('黒い財布'));
  info('print area contains store name', printAreaMemoHtml.includes('テスト商店'));

  // ===== mark wallet returned with signature =====
  await walletCard.locator('button', { hasText: '返却済みにする' }).click();
  await page.waitForTimeout(200);
  // signature pad should be open now; draw a stroke
  const canvas = page.locator('#sigCanvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60);
  await page.mouse.up();
  await page.click('button[onclick="confirmSignature()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'lf04-after-return-signed.png') });
  const returnedMeta = await page.locator('#lostList .card', { hasText: '黒い財布' }).locator('.entry-meta', { hasText: '引き渡し先' }).innerText();
  info('returned meta', returnedMeta);

  // ===== police form composer =====
  await page.click('button[onclick="openPoliceFormComposer()"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'lf05-police-composer.png') });
  const composerRowCount = await page.locator('#policeFormItemList .police-form-item-row').count();
  check('返却済みを除いた届出候補は1件', 1, composerRowCount);

  // check the row (unchecked by default since umbrella has no valuable tags), fill item code/points and print
  await page.locator('#policeFormItemList .police-form-item-row input[type="checkbox"]').check();
  await page.locator('#policeFormItemList .police-form-item-row input[placeholder="物品コード"]').fill('A123');
  await page.locator('#policeFormItemList .police-form-item-row input[placeholder="点数"]').fill('5');
  await page.evaluate(() => { window.__printCalled = 0; });
  await page.click('button[onclick="printPoliceForm()"]');
  await page.waitForTimeout(300);
  const printCalledForm = await page.evaluate(() => window.__printCalled);
  const printAreaFormHtml = await page.locator('#printArea').innerHTML();
  info('print called for police form', printCalledForm);
  info('print area contains form title', printAreaFormHtml.includes('占有者拾得物届出書'));
  info('print area contains store address', printAreaFormHtml.includes('東京都渋谷区'));
  info('print area contains occupant code', printAreaFormHtml.includes('OCC-999'));
  info('print area contains item code A123', printAreaFormHtml.includes('A123'));

  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'lf06-after-police-print.png') });
  const reportedBadge = await page.locator('#lostList .card', { hasText: '古い傘' }).locator('.valuable-badge', { hasText: '届出済み' }).count();
  check('umbrella marked as reported', 1, reportedBadge);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
