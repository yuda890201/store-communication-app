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

  // ===== マニュアル テキストインポート =====
  await page.click(`.grid-card[onclick="openView('manual')"]`);
  await page.waitForTimeout(150);
  const manualDetails = await page.$$('[data-view="manual"] details');
  await manualDetails[1].click();
  await page.waitForTimeout(100);

  const manualText = [
    'カテゴリ: レジ操作',
    'タイトル: 開店準備の手順',
    '本文:',
    '1. レジを開ける',
    '2. 釣銭を確認する',
    '',
    '---',
    '',
    'カテゴリ: レジ操作',
    'タイトル: 閉店処理の手順',
    '本文:',
    '1. 売上を集計する',
    '',
    '---',
    '',
    'タイトルの行がない不正な項目',
    '本文:',
    'これは無視されるはず'
  ].join('\n');

  await page.fill('#manualImportText', manualText);
  await page.click('button[onclick="previewManualImport()"]');
  await page.waitForTimeout(200);
  console.log('manual import status (after preview):', await page.locator('#manualImportStatus').innerText());
  await page.screenshot({ path: path.join(__dirname, 'imt01-manual-preview.png') });

  const previewRowCount = await page.locator('#manualImportPreviewList .import-preview-row').count();
  console.log('manual preview rows:', previewRowCount);

  // uncheck the 2nd item
  await page.locator('#manualImportPreviewList .import-preview-row').nth(1).locator('input[type=checkbox]').uncheck();
  await page.click('button[onclick="confirmManualImport()"]');
  await page.waitForTimeout(300);
  console.log('manual import status (after confirm):', await page.locator('#manualImportStatus').innerText());
  await page.screenshot({ path: path.join(__dirname, 'imt02-manual-after-confirm.png') });

  const manualCount = await page.locator('#manualList details').count();
  console.log('manual entries visible after import (expect 1, since 1 unchecked):', manualCount);

  // ===== トレーニング テキストインポート =====
  await page.click('[data-view="manual"] .back-btn');
  await page.waitForTimeout(150);
  await page.click(`.grid-card[onclick="openView('training')"]`);
  await page.waitForTimeout(150);
  const trainingDetails = await page.$$('[data-view="training"] details');
  await trainingDetails[1].click();
  await page.waitForTimeout(100);

  const trainingText = [
    'タイトル: レジ操作の基本',
    '対象店舗: 渋谷店',
    '',
    '---',
    '',
    'タイトル: 接客マナー',
    '',
    '---',
    '',
    'タイトル: 存在しない店舗タグ',
    '対象店舗: 大阪店、渋谷店',
  ].join('\n');

  await page.fill('#trainingImportText', trainingText);
  await page.click('button[onclick="previewTrainingImport()"]');
  await page.waitForTimeout(200);
  console.log('training import status (after preview):', await page.locator('#trainingImportStatus').innerText());
  await page.screenshot({ path: path.join(__dirname, 'imt03-training-preview.png') });

  await page.click('button[onclick="confirmTrainingImport()"]');
  await page.waitForTimeout(300);
  console.log('training import status (after confirm):', await page.locator('#trainingImportStatus').innerText());
  await page.screenshot({ path: path.join(__dirname, 'imt04-training-after-confirm.png') });

  const stepCount = await page.locator('#trainingStepList .step-row').count();
  console.log('training steps visible after import (expect 3):', stepCount);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
