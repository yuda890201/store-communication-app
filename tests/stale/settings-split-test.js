const { chromium } = require('playwright');
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
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    localStorage.setItem('my_name', 'テスト太郎');
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ss01-home-nostores.png') });

  // seed 2 stores -> should auto-pop the picker modal
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(300);
  const modalOpenAuto = await page.locator('#storePickerOverlay').evaluate(el => el.classList.contains('open'));
  console.log('store picker modal auto-opened with 2 stores:', modalOpenAuto);
  await page.screenshot({ path: path.join(__dirname, 'ss02-picker-modal-auto.png') });

  // pick 渋谷店
  await page.click('.store-option-btn >> text=渋谷店');
  await page.waitForTimeout(150);
  const modalClosedAfterPick = await page.locator('#storePickerOverlay').evaluate(el => !el.classList.contains('open'));
  const headerBtnText = await page.locator('#storeSwitchBtn').innerText();
  console.log('modal closed after pick:', modalClosedAfterPick, '| header button text:', headerBtnText);
  await page.screenshot({ path: path.join(__dirname, 'ss03-home-after-pick.png') });

  // reopen via header button, switch to 新宿店
  await page.click('#storeSwitchBtn');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(__dirname, 'ss04-picker-reopen.png') });
  await page.click('.store-option-btn >> text=新宿店');
  await page.waitForTimeout(150);
  const headerBtnText2 = await page.locator('#storeSwitchBtn').innerText();
  console.log('header button after switching to 新宿店:', headerBtnText2);

  // settings drawer split check
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'ss05-staff-settings.png') });
  const hasStoreListInStaffDrawer = await page.locator('#sideDrawer #storesInput').count();
  const hasFirebaseInStaffDrawer = await page.locator('#sideDrawer #firebaseConfig').count();
  console.log('storesInput present in staff drawer (expect 0):', hasStoreListInStaffDrawer);
  console.log('firebaseConfig present in staff drawer (expect 0):', hasFirebaseInStaffDrawer);

  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'ss06-owner-settings.png') });
  const hasStoreListInOwnerDrawer = await page.locator('#ownerDrawer #storesInput').count();
  console.log('storesInput present in owner drawer (expect 1):', hasStoreListInOwnerDrawer);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
