const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
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
    // アプリ全体がPINログインで保護されている。これらのテストはPIN導入前に
    // 書かれたもので、ログインしないとPIN画面が全クリックを遮る
    window.__mockUsers = {
      'staff@mock.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@mock.local', displayName: null } }
    };
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    localStorage.setItem('my_name', 'テスト太郎');
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(300);
  // 店舗が2つ以上あると起動時に店舗選択モーダルが開き、以降のクリックを遮る
  if (await page.locator('.store-option-btn:has-text("渋谷店")').isVisible().catch(() => false)) {
    await page.click('.store-option-btn:has-text("渋谷店")');
    await page.waitForTimeout(200);
  }
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
  check('training steps visible filtered to 新宿店', 1, countShinjuku);

  await page.selectOption('#trainingFilterStore', '渋谷店');
  await page.waitForTimeout(150);
  const countShibuya = await page.locator('#trainingStepList .step-row').count();
  check('training steps visible filtered to 渋谷店', 2, countShibuya);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
