const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
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
  check('count uses buttons not a number input', 0, await page.locator('#handoverCountRow input[type=number]').count());
  check('count buttons 0-10 + 11件以上', 12, await page.locator('#handoverCountGrid button').count());
  check('上限超えのボタン文言', '11件以上', await page.locator('#handoverCountGrid button.wide').innerText());
  check('next disabled before choosing', true, await page.locator('#handoverNextBtn').isDisabled());
  check('detail field hidden on count', false, await page.locator('#handoverDetailWrap').isVisible());
  await page.locator('#handoverCountGrid button').nth(3).click();
  await page.waitForTimeout(200);
  check('next enabled after choosing', false, await page.locator('#handoverNextBtn').isDisabled());
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(300);

  // ===== 2問目: 写真は必須 =====
  check('photo row shown', true, await page.locator('#handoverPhotoRow').isVisible());
  check('yes/no hidden for photo type', false, await page.locator('#handoverYesNoRow').isVisible());
  check('next blocked until photo taken', true, await page.locator('#handoverNextBtn').isDisabled());
  await page.setInputFiles('#handoverPhotoInput', { name: 'counter.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') });
  await page.waitForTimeout(700);
  // モックのgetDownloadURLは読み込めないURLを返すため、画像は描画されずisVisibleが使えない。
  // display と src が設定されたかで判定する
  const photoPreview = await page.evaluate(() => {
    const el = document.getElementById('handoverPhotoPreview');
    return { display: el.style.display, hasSrc: !!el.getAttribute('src') };
  });
  check('アップロード後にプレビューが出る', 'block', photoPreview.display);
  check('プレビューに画像が入る', true, photoPreview.hasSrc);
  check('next enabled after photo', false, await page.locator('#handoverNextBtn').isDisabled());
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(300);

  // ===== 3問目: あり/なし＋プリセット複数選択＋詳細＋写真 =====
  check('presets hidden before choosing あり', false, await page.locator('#handoverPresetWrap').isVisible());
  await page.click('#handoverYesBtn');
  await page.waitForTimeout(250);
  check('presets shown after あり', true, await page.locator('#handoverPresetWrap').isVisible());
  check('preset option count', 3, await page.locator('#handoverPresetList button').count());
  check('detail shown for presets', true, await page.locator('#handoverDetailWrap').isVisible());
  check('photo optional row shown for presets', true, await page.locator('#handoverPhotoRow').isVisible());
  await page.locator('#handoverPresetList button').nth(0).click();
  await page.waitForTimeout(200);
  await page.locator('#handoverPresetList button').nth(2).click();
  await page.waitForTimeout(200);
  const selectedCount = await page.locator('#handoverPresetList button.selected').count();
  check('multi-select works', 2, selectedCount);
  await page.fill('#handoverDetailInput', 'レジ2番でお釣り違い。返金対応済み。');
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(400);

  // ===== プレビュー本文 =====
  const preview = await page.locator('#handoverPreviewText').inputValue();
  check('preview has count line', true, preview.includes('店頭受取荷物: 3件'));
  check('preview has photo line', true, preview.includes('写真あり'));
  check('preview has both presets', true, preview.includes('接客クレーム') && preview.includes('会計トラブル（誤精算・返金）'));
  check('preview has detail', true, preview.includes('返金対応済み'));

  // ===== 投稿後に金庫アプリのQRが出ること =====
  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(700);
  check('done card shown', true, await page.locator('#handoverDoneCard').isVisible());
  check('open-safe-app button visible', true, await page.locator('#handoverKinkoLink').isVisible());
  checkIncludes('設定した金庫アプリのURLを指す', await page.locator('#handoverKinkoLink').getAttribute('href'), 'https://example.com/kinko/');
  check('progress label hidden after posting', false, await page.locator('#handoverProgressLabel').isVisible());
  check('cancel button hidden after posting', false, await page.locator('#handoverCancelBtn').isVisible());
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(300);
  check('wizard closed, list visible again', true, await page.locator('#notebookMainPanel').isVisible());

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
