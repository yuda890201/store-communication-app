const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(200);
  await page.click('.store-option-btn');
  await page.waitForTimeout(150);

  // ===== マニュアル インポート =====
  await page.click(`.grid-card[onclick="openView('manual')"]`);
  await page.waitForTimeout(150);
  await page.click('[data-view="manual"] details summary'); // open ➕追加 details (first)
  await page.waitForTimeout(100);
  // open the import details (second one)
  const manualDetails = await page.$$('[data-view="manual"] details');
  await manualDetails[1].click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(__dirname, 'imp01-manual-import-open.png') });

  const manualJson = JSON.stringify([
    { category: 'レジ操作', title: '開店準備の手順', body: '1. レジを開ける\n2. 釣銭を確認する' },
    { category: 'レジ操作', title: '閉店処理の手順', body: '1. 売上を集計する' },
    { title: 'タイトルなし', body: 'skip me' }, // missing title-like check: actually has no title field -> should be skipped since title empty
    { category: '接客', title: '', body: 'empty title skip' }
  ]);
  await page.fill('#manualImportText', manualJson);
  await page.click('button[onclick*="importManualsFromJson"]');
  await page.waitForTimeout(400);
  const manualImportStatus = await page.locator('#manualImportStatus').innerText();
  console.log('manual import status:', manualImportStatus);
  await page.screenshot({ path: path.join(__dirname, 'imp02-manual-import-done.png') });

  const manualCount = await page.locator('#manualList details').count();
  console.log('manual entries visible after import:', manualCount);

  // invalid JSON test
  await manualDetails[1].click(); // reopen if closed? actually still open
  await page.fill('#manualImportText', 'not json{{{');
  await page.click('button[onclick*="importManualsFromJson"]');
  await page.waitForTimeout(200);
  console.log('manual import invalid json status:', await page.locator('#manualImportStatus').innerText());

  // ===== トレーニング インポート =====
  await page.click('[data-view="manual"] .back-btn');
  await page.waitForTimeout(150);
  await page.click(`.grid-card[onclick="openView('training')"]`);
  await page.waitForTimeout(150);
  const trainingDetails = await page.$$('[data-view="training"] details');
  await trainingDetails[1].click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(__dirname, 'imp03-training-import-open.png') });

  const trainingJson = JSON.stringify({
    steps: [
      { title: 'レジ操作の基本', storeTags: ['渋谷店'] },
      { title: '接客マナー' },
      { title: '存在しない店舗タグ', storeTags: ['大阪店'] },
      { title: '' }
    ]
  });
  await page.fill('#trainingImportText', trainingJson);
  await page.click('button[onclick*="importTrainingStepsFromJson"]');
  await page.waitForTimeout(400);
  const trainingImportStatus = await page.locator('#trainingImportStatus').innerText();
  console.log('training import status:', trainingImportStatus);
  await page.screenshot({ path: path.join(__dirname, 'imp04-training-import-done.png') });

  const stepCount = await page.locator('#trainingStepList .step-row').count();
  console.log('training steps visible after import:', stepCount);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
