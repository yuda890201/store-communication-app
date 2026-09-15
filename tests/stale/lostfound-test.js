const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => {
    console.log('dialog:', d.message());
    if (d.type() === 'prompt') d.accept('山田太郎');
    else d.accept();
  });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.print = () => { window.__printCalled = (window.__printCalled || 0) + 1; };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店'] });
  });
  await page.waitForTimeout(200);

  await page.click(`.grid-card[onclick="openView('lostfound')"]`);
  await page.waitForTimeout(150);

  // ===== owner settings: fill store info =====
  await page.click('[data-view="lostfound"] .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
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

  const reminderCount = await page.locator('#lostReminders .lost-reminder-card').count();
  console.log('reminder cards shown:', reminderCount);
  const reminderTexts = await page.locator('#lostReminders .lost-reminder-title').allInnerTexts();
  console.log('reminder titles:', reminderTexts);

  // click the police-report reminder -> filter to valuables
  const policeCard = page.locator('#lostReminders .lost-reminder-card', { hasText: '警察届出' });
  await policeCard.click();
  await page.waitForTimeout(150);
  console.log('filtered card count (expect 1, the wallet):', await page.locator('#lostList .card').count());
  await page.screenshot({ path: path.join(__dirname, 'lf03-filtered-police.png') });

  // clear filter
  await page.click('#lostFilterBanner button');
  await page.waitForTimeout(150);
  console.log('unfiltered card count (expect 2):', await page.locator('#lostList .card').count());

  // click 3-month reminder
  const overdueCard = page.locator('#lostReminders .lost-reminder-card', { hasText: '保管期限' });
  await overdueCard.click();
  await page.waitForTimeout(150);
  console.log('filtered card count for overdue3m (expect 1, the umbrella):', await page.locator('#lostList .card').count());
  await page.click('#lostFilterBanner button');
  await page.waitForTimeout(150);

  // ===== print memo for the wallet =====
  await page.evaluate(() => { window.__printCalled = 0; });
  const walletCard = page.locator('#lostList .card', { hasText: '黒い財布' });
  await walletCard.locator('button', { hasText: 'メモを印刷' }).click();
  await page.waitForTimeout(150);
  const printCalledMemo = await page.evaluate(() => window.__printCalled);
  const printAreaMemoHtml = await page.locator('#printArea').innerHTML();
  console.log('print called for memo:', printCalledMemo);
  console.log('print area contains title:', printAreaMemoHtml.includes('黒い財布'));
  console.log('print area contains store name:', printAreaMemoHtml.includes('テスト商店'));

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
  console.log('returned meta:', returnedMeta);

  // ===== police form composer =====
  await page.click('button[onclick="openPoliceFormComposer()"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'lf05-police-composer.png') });
  const composerRowCount = await page.locator('#policeFormItemList .police-form-item-row').count();
  console.log('police form composer candidate rows (expect 1, umbrella - wallet already returned):', composerRowCount);

  // check the row (unchecked by default since umbrella has no valuable tags), fill item code/points and print
  await page.locator('#policeFormItemList .police-form-item-row input[type="checkbox"]').check();
  await page.locator('#policeFormItemList .police-form-item-row input[placeholder="物品コード"]').fill('A123');
  await page.locator('#policeFormItemList .police-form-item-row input[placeholder="点数"]').fill('5');
  await page.evaluate(() => { window.__printCalled = 0; });
  await page.click('button[onclick="printPoliceForm()"]');
  await page.waitForTimeout(300);
  const printCalledForm = await page.evaluate(() => window.__printCalled);
  const printAreaFormHtml = await page.locator('#printArea').innerHTML();
  console.log('print called for police form:', printCalledForm);
  console.log('print area contains form title:', printAreaFormHtml.includes('占有者拾得物届出書'));
  console.log('print area contains store address:', printAreaFormHtml.includes('東京都渋谷区'));
  console.log('print area contains occupant code:', printAreaFormHtml.includes('OCC-999'));
  console.log('print area contains item code A123:', printAreaFormHtml.includes('A123'));

  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'lf06-after-police-print.png') });
  const reportedBadge = await page.locator('#lostList .card', { hasText: '古い傘' }).locator('.valuable-badge', { hasText: '届出済み' }).count();
  console.log('umbrella marked as reported (expect 1):', reportedBadge);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
