const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => d.accept());

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '清川二丁目');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);

  // 4種類の回答タイプを1本ずつ用意する
  await page.evaluate(() => {
    const db = window.firebase.firestore();
    db.collection('appSettings').doc('general').set({
      stores: ['清川二丁目'], kinkoAppUrl: 'https://example.com/kinko/'
    });
    db.collection('handoverItems').add({ question: '店頭受取の荷物は何件ありますか？', answerType: 'count', yesTemplate: '店頭受取荷物: {n}件', important: false, createdAt: new Date() });
    db.collection('handoverItems').add({ question: 'バックカウンターの状態を撮影してください', answerType: 'photo', yesTemplate: 'バックカウンターの写真', important: false, createdAt: new Date() });
    db.collection('handoverItems').add({
      question: 'クレーム・トラブル対応はありましたか？', answerType: 'presets', yesTemplate: 'クレーム・トラブルあり', important: true,
      presetOptions: ['接客クレーム', '商品の不良・異物', '会計トラブル（誤精算・返金）'], createdAt: new Date()
    });
  });
  await page.waitForTimeout(600);

  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(300);
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(400);

  // ===== 1問目: 件数は選択式 =====
  console.log('count uses buttons not a number input (expect 0):', await page.locator('#handoverCountRow input[type=number]').count());
  console.log('count buttons 0-10 + 11件以上 (expect 12):', await page.locator('#handoverCountGrid button').count());
  console.log('over-limit button label (expect 11件以上):', await page.locator('#handoverCountGrid button.wide').innerText());
  console.log('next disabled before choosing (expect true):', await page.locator('#handoverNextBtn').isDisabled());
  console.log('detail field hidden on count (expect false):', await page.locator('#handoverDetailWrap').isVisible());
  await page.locator('#handoverCountGrid button').nth(3).click();
  await page.waitForTimeout(200);
  console.log('next enabled after choosing (expect false):', await page.locator('#handoverNextBtn').isDisabled());
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(300);

  // ===== 2問目: 写真は必須 =====
  console.log('photo row shown (expect true):', await page.locator('#handoverPhotoRow').isVisible());
  console.log('yes/no hidden for photo type (expect false):', await page.locator('#handoverYesNoRow').isVisible());
  console.log('next blocked until photo taken (expect true):', await page.locator('#handoverNextBtn').isDisabled());
  await page.setInputFiles('#handoverPhotoInput', { name: 'counter.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') });
  await page.waitForTimeout(700);
  // モックのgetDownloadURLは読み込めないURLを返すため、画像は描画されずisVisibleが使えない。
  // display と src が設定されたかで判定する
  const photoPreview = await page.evaluate(() => {
    const el = document.getElementById('handoverPhotoPreview');
    return { display: el.style.display, hasSrc: !!el.getAttribute('src') };
  });
  console.log('preview displayed after upload (expect block / true):', photoPreview.display, '/', photoPreview.hasSrc);
  console.log('next enabled after photo (expect false):', await page.locator('#handoverNextBtn').isDisabled());
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(300);

  // ===== 3問目: あり/なし＋プリセット複数選択＋詳細＋写真 =====
  console.log('presets hidden before choosing あり (expect false):', await page.locator('#handoverPresetWrap').isVisible());
  await page.click('#handoverYesBtn');
  await page.waitForTimeout(250);
  console.log('presets shown after あり (expect true):', await page.locator('#handoverPresetWrap').isVisible());
  console.log('preset option count (expect 3):', await page.locator('#handoverPresetList button').count());
  console.log('detail shown for presets (expect true):', await page.locator('#handoverDetailWrap').isVisible());
  console.log('photo optional row shown for presets (expect true):', await page.locator('#handoverPhotoRow').isVisible());
  await page.locator('#handoverPresetList button').nth(0).click();
  await page.waitForTimeout(200);
  await page.locator('#handoverPresetList button').nth(2).click();
  await page.waitForTimeout(200);
  const selectedCount = await page.locator('#handoverPresetList button.selected').count();
  console.log('multi-select works (expect 2):', selectedCount);
  await page.fill('#handoverDetailInput', 'レジ2番でお釣り違い。返金対応済み。');
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(400);

  // ===== プレビュー本文 =====
  const preview = await page.locator('#handoverPreviewText').inputValue();
  console.log('preview has count line (expect true):', preview.includes('店頭受取荷物: 3件'));
  console.log('preview has photo line (expect true):', preview.includes('写真あり'));
  console.log('preview has both presets (expect true):', preview.includes('接客クレーム') && preview.includes('会計トラブル（誤精算・返金）'));
  console.log('preview has detail (expect true):', preview.includes('返金対応済み'));

  // ===== 投稿後に金庫アプリのQRが出ること =====
  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(700);
  console.log('done card shown (expect true):', await page.locator('#handoverDoneCard').isVisible());
  console.log('open-safe-app button visible (expect true):', await page.locator('#handoverKinkoLink').isVisible());
  console.log('button points at the configured url (expect https://example.com/kinko/):', await page.locator('#handoverKinkoLink').getAttribute('href'));
  console.log('progress label hidden after posting (expect false):', await page.locator('#handoverProgressLabel').isVisible());
  console.log('cancel button hidden after posting (expect false):', await page.locator('#handoverCancelBtn').isVisible());
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(300);
  console.log('wizard closed, list visible again (expect true):', await page.locator('#notebookMainPanel').isVisible());

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
