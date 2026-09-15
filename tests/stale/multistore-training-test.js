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
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(200);

  await page.click(`.grid-card[onclick="openView('training')"]`);
  await page.waitForTimeout(150);
  await page.click('#trainingView details summary, [data-view="training"] details summary');
  await page.fill('#trainingStepInput', '渋谷店専用ステップ');
  await page.selectOption('#trainingStoreTags', ['渋谷店']);
  await page.click('button[onclick="addTrainingStep()"]');
  await page.waitForTimeout(200);

  await page.fill('#trainingStepInput', '全店共通ステップ');
  await page.click('button[onclick="addTrainingStep()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ms08-training-all.png') });

  await page.selectOption('#trainingFilterStore', '新宿店');
  await page.waitForTimeout(150);
  const countShinjuku = await page.locator('#trainingStepList .step-row').count();
  console.log('training steps visible filtered to 新宿店 (expect 1):', countShinjuku);

  await page.selectOption('#trainingFilterStore', '渋谷店');
  await page.waitForTimeout(150);
  const countShibuya = await page.locator('#trainingStepList .step-row').count();
  console.log('training steps visible filtered to 渋谷店 (expect 2):', countShibuya);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
