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
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['本店'] });
  });
  await page.waitForTimeout(300);
  const modalOpen = await page.locator('#storePickerOverlay').evaluate(el => el.classList.contains('open'));
  const headerText = await page.locator('#storeSwitchBtn').innerText();
  console.log('modal open with single store (expect false):', modalOpen);
  console.log('header text (expect 📍 本店 ▾):', headerText);
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
