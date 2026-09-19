const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => { info('dialog', d.message()); d.accept(); });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      // オーナー設定は管理者の個人アカウントでのログインが要るようになった
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.firebase.firestore().collection('appSettings').doc('general').set({ adminEmails: ['owner@test.example.com'], stores: ['渋谷店'] }); });
  await page.waitForTimeout(300);

  // ===== seed default handover items via owner drawer =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  await page.waitForTimeout(150);
  await page.click('button[onclick="seedDefaultHandoverItems()"]');
  await page.waitForTimeout(400);
  const itemLabels = await page.locator('#handoverItemList .task-row-label').allInnerTexts();
  check('seeded item count', 10, itemLabels.length);
  info('seeded labels', itemLabels);
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // ===== open notebook, start wizard =====
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);

  info('chat sender label present', (await page.locator('#handoverQuestionCard .chat-sender-label').innerText()).includes('バーチャル店長'));

  // Q1: 忘れ物はありませんか？ -> yesno, answer "あり" with detail
  info('Q1 text', await page.locator('#handoverQuestionText').innerText());
  await page.click('#handoverYesBtn');
  // あり／なしの質問には詳細欄が出なくなった（引継ぎのテンポを落とさないため）。
  // 出ているときだけ入力する
  if (await page.locator('#handoverDetailWrap').isVisible().catch(() => false)) {
    await page.fill('#handoverDetailInput', '傘を発見');
  }
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(150);

  // Q2: 店頭受取の荷物は何件ありますか？ -> count type
  info('Q2 text', await page.locator('#handoverQuestionText').innerText());
  info('Q2 count row visible', await page.locator('#handoverCountRow').isVisible());
  info('Q2 yesno row hidden', !(await page.locator('#handoverYesNoRow').isVisible()));
  info('next button disabled before entering count', await page.locator('#handoverNextBtn').isDisabled());
  await page.click('#handoverCountGrid button:text-is("3")');  // 件数は入力欄からボタン選択に変わった
  info('next button enabled after entering count', !(await page.locator('#handoverNextBtn').isDisabled()));
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(150);

  // Q3..Q10: answer なし except one important item (レジ過不足) -> あり
  for (let i = 0; i < 8; i++) {
    const qText = await page.locator('#handoverQuestionText').innerText();
    if (qText.includes('レジの過不足')) {
      await page.click('#handoverYesBtn');
      // あり／なしの質問には詳細欄が出なくなった（引継ぎのテンポを落とさないため）。
  // 出ているときだけ入力する
  if (await page.locator('#handoverDetailWrap').isVisible().catch(() => false)) {
    await page.fill('#handoverDetailInput', '1000円不足');
  }
    } else {
      await page.click('#handoverNoBtn');
    }
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(100);
  }

  await page.waitForTimeout(200);
  const previewText1 = await page.locator('#handoverPreviewText').inputValue();
  console.log('composed preview (1st handover):\n' + previewText1);

  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(300);

  // ===== confirmation sign =====
  const confirmBtnVisible1 = await page.locator('#latestHandoverConfirmBtn').isVisible();
  info('confirm button visible for テスト太郎 (creator, expect true since only entryId-based, not creator-based)', confirmBtnVisible1);
  await page.click('#latestHandoverConfirmBtn');
  await page.waitForTimeout(200);
  const canvas = page.locator('#sigCanvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60);
  await page.mouse.up();
  await page.click('button[onclick="confirmSignature()"]');
  await page.waitForTimeout(300);
  info('confirm button hidden after signing', !(await page.locator('#latestHandoverConfirmBtn').isVisible()));
  const confirmChips = await page.locator('#latestHandoverConfirmList .signer-chip').allInnerTexts();
  info('confirm chips', confirmChips);

  // switch staff name -> confirm button should reappear for the new person
  await page.evaluate(() => {
    // getMyName() が読むのは入力欄。localStorage だけ書き換えても反映されない
    localStorage.setItem('my_name', '次郎');
    document.getElementById('myNameInput').value = '次郎';
    // 画面遷移だけでは一覧を描き直さない（描画はFirestoreの購読が起点）。
    // 実運用では別端末＝再読み込みなので、ここでは明示的に描き直す
    renderNotebookList();
  });
  await page.click('[data-view="notebook"] .back-btn');
  await page.waitForTimeout(100);
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  info('confirm button visible for a different staff (次郎)', await page.locator('#latestHandoverConfirmBtn').isVisible());
  await page.evaluate(() => {
    localStorage.setItem('my_name', 'テスト太郎');
    document.getElementById('myNameInput').value = 'テスト太郎';
  });

  // 「未解決の項目を次回に持ち越して質問する」機能は、その後アプリから削除された。
  // 毎回のシフトが自分で点検し直す設計に変わったため（現行の
  // handover-prev-answer-test.js が「持ち越し質問が出ないこと」を検証している）。
  // ここにあった持ち越しの検証は、廃止済みの挙動を期待値にしていたので外した。

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
