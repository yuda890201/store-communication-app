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
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  // ===== デフォルト(日本語)確認 =====
  info('default notebook label', await page.locator('.grid-card[onclick="openView(\'notebook\')"] .grid-label').innerText());

  // ===== 英語に切り替え =====
  await page.click('.active-view .settings-btn:has-text("🌐")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="setLang(\'en\')"]');
  await page.waitForTimeout(200);
  check('EN 連絡ノートのラベル', 'Notebook', await page.locator('.grid-card[onclick="openView(\'notebook\')"] .grid-label').innerText());
  check('EN 掲示板の説明', 'Announcements', await page.locator('.grid-card[onclick="openView(\'bulletin\')"] .grid-desc').innerText());
  check('EN 忘れ物のラベル', 'Lost & Found', await page.locator('.grid-card[onclick="openView(\'lostfound\')"] .grid-label').innerText());
  info('lang persisted in localStorage', await page.evaluate(() => localStorage.getItem('app_lang')));

  // Notebook screen labels
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  info('EN notebook view title', await page.locator('[data-view="notebook"] .view-title').innerText());
  info('EN create handover btn', await page.locator('button[onclick="startHandoverWizard()"]').innerText());
  info('EN notebook search placeholder', await page.locator('#notebookSearchInput').getAttribute('placeholder'));
  check('EN 連絡ノートの空状態', 'No notebook entries yet', await page.locator('#notebookList .empty-state').innerText());

  // ウィザード開始前に引継ぎ項目を1件シード（未登録だとalertでブロックされる）
  await page.evaluate(() => {
    window.firebase.firestore().collection('handoverItems').add({
      question: 'Test question?', yesTemplate: 'Test yes', answerType: 'yesno', important: false,
      createdAt: new Date()
    });
  });
  await page.waitForTimeout(300);

  // Start wizard, check EN labels
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);
  info('EN virtual manager label', await page.locator('.chat-sender-label').innerText());
  checkIncludes('EN 進捗ラベル', await page.locator('#handoverProgressLabel').innerText(), 'Question');
  info('EN yes btn', await page.locator('#handoverYesBtn').innerText());
  info('EN next btn', await page.locator('#handoverNextBtn').innerText());
  await page.click('button[onclick="cancelHandoverWizard()"]');
  await page.waitForTimeout(150);

  // Bulletin screen
  await page.click('[data-view="notebook"] .back-btn');
  await page.waitForTimeout(150);
  await page.click('.grid-card[onclick="openView(\'bulletin\')"]');
  await page.waitForTimeout(150);
  info('EN bulletin title label', await page.locator('label[for="bulletinTitleInput"]').innerText());
  info('EN bulletin post btn', await page.locator('button[onclick="addBulletinPost()"]').innerText());
  info('EN bulletin filter all option', await page.locator('#bulletinFilterStore option[value=""]').innerText());
  info('EN bulletin empty state', await page.locator('#bulletinList .empty-state').innerText());

  // Lost & found screen
  await page.click('[data-view="bulletin"] .back-btn');
  await page.waitForTimeout(150);
  await page.click('.grid-card[onclick="openView(\'lostfound\')"]');
  await page.waitForTimeout(150);
  info('EN lostfound register btn (textContent, details closed)', await page.locator('button[onclick="addLostItem()"]').evaluate(el => el.textContent));
  info('EN lostfound empty state', await page.locator('#lostList .empty-state').innerText());

  // ===== ネパール語に切り替え =====
  await page.click('[data-view="lostfound"] .back-btn');
  await page.waitForTimeout(150);
  await page.click('.active-view .settings-btn:has-text("🌐")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="setLang(\'ne\')"]');
  await page.waitForTimeout(200);
  info('NE notebook label', await page.locator('.grid-card[onclick="openView(\'notebook\')"] .grid-label').innerText());
  info('NE chat label', await page.locator('.grid-card[onclick="openView(\'chat\')"] .grid-label').innerText());

  // ===== 日本語に戻す =====
  await page.click('.active-view .settings-btn:has-text("🌐")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="setLang(\'ja\')"]');
  await page.waitForTimeout(200);
  check('日本語に戻したときのラベル', '連絡ノート', await page.locator('.grid-card[onclick="openView(\'notebook\')"] .grid-label').innerText());

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
