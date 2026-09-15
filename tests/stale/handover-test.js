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

  // seed 1 store (auto-selected, no modal) + seed default handover items via owner drawer flow directly
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['本店'] });
  });
  await page.waitForTimeout(200);

  await page.click(`.grid-card[onclick="openView('notebook')"]`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(__dirname, 'ho01-notebook-empty.png') });

  // try starting wizard with 0 items -> should alert
  page.once('dialog', d => { console.log('dialog on empty items:', d.message()); d.accept(); });
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(150);

  // go add items via owner settings
  await page.click('[data-view="notebook"] .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(150);
  await page.click('button[onclick="seedDefaultHandoverItems()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ho02-owner-items-seeded.png') });
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // start wizard now
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'ho03-wizard-q1.png') });

  // Q1: answer yes with detail
  await page.click('#handoverYesBtn');
  await page.waitForTimeout(100);
  await page.fill('#handoverDetailInput', '3000円不足していた');
  await page.screenshot({ path: path.join(__dirname, 'ho04-wizard-q1-yes-detail.png') });
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(150);

  // Q2..Q6: answer no
  for (let i = 0; i < 5; i++) {
    await page.click('#handoverNoBtn');
    await page.waitForTimeout(80);
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(120);
  }

  await page.screenshot({ path: path.join(__dirname, 'ho05-preview.png') });
  const previewText = await page.locator('#handoverPreviewText').inputValue();
  console.log('composed preview text:\n' + previewText);

  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ho06-after-submit.png') });

  const latestHandoverText = await page.locator('#latestHandoverContent').innerText();
  console.log('latest handover card shows:\n' + latestHandoverText);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
