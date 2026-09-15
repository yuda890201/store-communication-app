const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => { console.log('dialog:', d.message()); d.accept(); });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店'] }); });
  await page.waitForTimeout(300);

  // ===== seed default handover items via owner drawer =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(150);
  await page.click('button[onclick="seedDefaultHandoverItems()"]');
  await page.waitForTimeout(400);
  const itemLabels = await page.locator('#handoverItemList .task-row-label').allInnerTexts();
  console.log('seeded item count (expect 10):', itemLabels.length);
  console.log('seeded labels:', itemLabels);
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // ===== open notebook, start wizard =====
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);

  console.log('chat sender label present:', (await page.locator('#handoverQuestionCard .chat-sender-label').innerText()).includes('バーチャル店長'));

  // Q1: 忘れ物はありませんか？ -> yesno, answer "あり" with detail
  console.log('Q1 text:', await page.locator('#handoverQuestionText').innerText());
  await page.click('#handoverYesBtn');
  await page.fill('#handoverDetailInput', '傘を発見');
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(150);

  // Q2: 店頭受取の荷物は何件ありますか？ -> count type
  console.log('Q2 text:', await page.locator('#handoverQuestionText').innerText());
  console.log('Q2 count row visible:', await page.locator('#handoverCountRow').isVisible());
  console.log('Q2 yesno row hidden:', !(await page.locator('#handoverYesNoRow').isVisible()));
  console.log('next button disabled before entering count:', await page.locator('#handoverNextBtn').isDisabled());
  await page.fill('#handoverCountInput', '3');
  console.log('next button enabled after entering count:', !(await page.locator('#handoverNextBtn').isDisabled()));
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(150);

  // Q3..Q10: answer なし except one important item (レジ過不足) -> あり
  for (let i = 0; i < 8; i++) {
    const qText = await page.locator('#handoverQuestionText').innerText();
    if (qText.includes('レジの過不足')) {
      await page.click('#handoverYesBtn');
      await page.fill('#handoverDetailInput', '1000円不足');
    } else {
      await page.click('#handoverNoBtn');
    }
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(100);
  }

  await page.waitForTimeout(200);
  const previewText1 = await page.locator('#handoverPreviewText').inputValue();
  console.log('composed preview (1st handover):\n' + previewText1);

  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(300);

  // ===== confirmation sign =====
  const confirmBtnVisible1 = await page.locator('#latestHandoverConfirmBtn').isVisible();
  console.log('confirm button visible for テスト太郎 (creator, expect true since only entryId-based, not creator-based):', confirmBtnVisible1);
  await page.click('#latestHandoverConfirmBtn');
  await page.waitForTimeout(200);
  const canvas = page.locator('#sigCanvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60);
  await page.mouse.up();
  await page.click('button[onclick="confirmSignature()"]');
  await page.waitForTimeout(300);
  console.log('confirm button hidden after signing:', !(await page.locator('#latestHandoverConfirmBtn').isVisible()));
  const confirmChips = await page.locator('#latestHandoverConfirmList .signer-chip').allInnerTexts();
  console.log('confirm chips:', confirmChips);

  // switch staff name -> confirm button should reappear for the new person
  await page.evaluate(() => { localStorage.setItem('my_name', '次郎'); });
  await page.click('[data-view="notebook"] .back-btn');
  await page.waitForTimeout(100);
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  console.log('confirm button visible for a different staff (次郎):', await page.locator('#latestHandoverConfirmBtn').isVisible());
  await page.evaluate(() => { localStorage.setItem('my_name', 'テスト太郎'); });

  // ===== carry-over: start a new wizard, expect carry-over questions first (2 expected: 忘れ物 + レジ過不足) =====
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);

  let carryOverCount = 0;
  while ((await page.locator('#handoverQuestionText').innerText()).startsWith('🔁')) {
    console.log(`carry-over question #${carryOverCount + 1}:`, await page.locator('#handoverQuestionText').innerText());
    await page.click('#handoverYesBtn'); // still unresolved
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(120);
    carryOverCount++;
  }
  console.log('total carry-over questions asked (expect 2):', carryOverCount);

  // walk through remaining 10 configured items quickly, all "なし" except count item gets 0
  for (let i = 0; i < 10; i++) {
    const isCount = await page.locator('#handoverCountRow').isVisible();
    if (isCount) {
      await page.fill('#handoverCountInput', '0');
    } else {
      await page.click('#handoverNoBtn');
    }
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(200);
  const previewText2 = await page.locator('#handoverPreviewText').inputValue();
  console.log('composed preview (2nd handover, carry-over still unresolved):\n' + previewText2);
  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(300);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
