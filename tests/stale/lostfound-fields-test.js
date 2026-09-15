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
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    localStorage.setItem('my_name', 'テスト太郎');
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店'] });
  });
  await page.waitForTimeout(200);
  await page.click('.grid-card[onclick="openView(\'lostfound\')"]');
  await page.waitForTimeout(150);
  await page.click('[data-view="lostfound"] details summary');
  await page.waitForTimeout(100);

  // check time select is populated with 15-min increments and defaulted near now
  const timeOptionCount = await page.locator('#lostTimeInput option').count();
  console.log('time select option count (expect 96):', timeOptionCount);
  const timeValue = await page.locator('#lostTimeInput').inputValue();
  console.log('default time value (HH:MM, minute should be multiple of 15):', timeValue);

  // register first item with a brand-new title/location + color/pattern tags
  await page.fill('#lostTitleInput', '黒い折りたたみ傘');
  await page.check('#lostColorTagGroup input[value="黒"]');
  await page.check('#lostPatternTagGroup input[value="無地"]');
  await page.fill('#lostDescInput', '持ち手に赤いテープ');
  await page.fill('#lostLocationInput', 'レジ横の椅子');
  await page.selectOption('#lostTimeInput', '14:30');
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(300);

  // verify the name/location got added to the shared list (appSettings)
  const settingsAfterFirst = await page.evaluate(async () => {
    const doc = await window.firebase.firestore().collection('appSettings').doc('general').get();
    return doc.data();
  });
  console.log('lostItemNames after first add:', settingsAfterFirst.lostItemNames);
  console.log('lostLocationNames after first add:', settingsAfterFirst.lostLocationNames);

  // datalist should now contain the new name
  const datalistOptions = await page.locator('#lostTitleList option').evaluateAll(els => els.map(e => e.value));
  console.log('datalist options after first add:', datalistOptions);

  await page.screenshot({ path: path.join(__dirname, 'lff01-registration-form.png') });

  // register a second item reusing the same title from the list (simulate picking from datalist)
  await page.fill('#lostTitleInput', '黒い折りたたみ傘');
  await page.fill('#lostLocationInput', 'レジ横の椅子');
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(300);
  const settingsAfterSecond = await page.evaluate(async () => {
    const doc = await window.firebase.firestore().collection('appSettings').doc('general').get();
    return doc.data();
  });
  console.log('lostItemNames after reusing same title (should still have only 1 entry, no dup):', settingsAfterSecond.lostItemNames);

  // verify list rendering shows color/pattern tags and combined date+time
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'lff02-list-with-features.png') });
  const firstCardText = await page.locator('#lostList .card').first().innerText();
  console.log('first card text:\n', firstCardText);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
