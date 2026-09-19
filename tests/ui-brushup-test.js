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

  // PWA meta/manifest checks
  info('manifest link present', await page.locator('link[rel="manifest"]').count() === 1);
  info('theme-color meta', await page.locator('meta[name="theme-color"]').getAttribute('content'));

  // log in via PIN
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ adminEmails: ['owner@test.example.com'], stores: ['渋谷店'] });
  });
  await page.waitForTimeout(300);
  // single store auto-selects silently (no picker modal shown)

  // ===== version display =====
  info('version display text', await page.locator('#appVersionInfo').innerText());

  // ===== default tag options render correctly =====
  await page.click('.grid-card[onclick="openView(\'lostfound\')"]');
  await page.waitForTimeout(150);
  await page.click('[data-view="lostfound"] details summary');
  await page.waitForTimeout(100);
  check('default valuable tag checkboxes count', 6, await page.locator('#lostValuableTagGroup input[type=checkbox]').count());
  check('default color tag checkboxes count', 14, await page.locator('#lostColorTagGroup input[type=checkbox]').count());
  check('default pattern tag checkboxes count', 8, await page.locator('#lostPatternTagGroup input[type=checkbox]').count());

  // register a lost item -> home badge for lostfound should become 1
  await page.fill('#lostTitleInput', '黒い傘');
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(300);
  await page.click('[data-view="lostfound"] .back-btn');
  await page.waitForTimeout(200);
  const lostBadge = await page.locator('#badge-lostfound').evaluate(el => ({ text: el.textContent, visible: getComputedStyle(el).display !== 'none' }));
  info('lostfound badge after registering 1 item', lostBadge);

  // ===== notebook badge: missing today handover =====
  const notebookBadgeBefore = await page.locator('#badge-notebook').evaluate(el => ({ text: el.textContent, visible: getComputedStyle(el).display !== 'none' }));
  check('引継ぎ前は連絡ノートにバッジが出る', true, notebookBadgeBefore.visible);
  check('バッジの件数', '1', notebookBadgeBefore.text);

  // seed a handover item and complete the wizard quickly via direct firestore write (simpler than full wizard walk)
  await page.evaluate(() => {
    return window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', text: 'テスト引継ぎ', author: 'テスト太郎', store: '渋谷店',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
  await page.waitForTimeout(300);
  const notebookBadgeAfter = await page.locator('#badge-notebook').evaluate(el => ({ text: el.textContent, visible: getComputedStyle(el).display !== 'none' }));
  check('本日の引継ぎを作るとバッジが消える', false, notebookBadgeAfter.visible);

  // ===== bulletin badge: unsigned required-ack post =====
  await page.click('.grid-card[onclick="openView(\'bulletin\')"]');
  await page.waitForTimeout(150);
  await page.fill('#bulletinTitleInput', '重要なお知らせ');
  await page.fill('#bulletinBodyInput', '必ず確認してください');
  await page.check('#bulletinRequiresAck');
  await page.click('button[onclick="addBulletinPost()"]');
  await page.waitForTimeout(300);
  await page.click('[data-view="bulletin"] .back-btn');
  await page.waitForTimeout(200);
  const bulletinBadgeBefore = await page.locator('#badge-bulletin').evaluate(el => ({ text: el.textContent, visible: getComputedStyle(el).display !== 'none' }));
  check('未サインの要確認投稿があると掲示板にバッジが出る', true, bulletinBadgeBefore.visible);
  check('掲示板バッジの件数', '1', bulletinBadgeBefore.text);

  // sign it, then badge should clear
  await page.click('.grid-card[onclick="openView(\'bulletin\')"]');
  await page.waitForTimeout(150);
  await page.click('button:has-text("サインする")');
  await page.waitForTimeout(150);
  const canvas = page.locator('#sigCanvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60);
  await page.mouse.up();
  await page.click('button[onclick="confirmSignature()"]');
  await page.waitForTimeout(300);
  await page.click('[data-view="bulletin"] .back-btn');
  await page.waitForTimeout(200);
  const bulletinBadgeAfter = await page.locator('#badge-bulletin').evaluate(el => ({ text: el.textContent, visible: getComputedStyle(el).display !== 'none' }));
  check('サインするとバッジが消える', false, bulletinBadgeAfter.visible);

  // ===== search: bulletin =====
  await page.click('.grid-card[onclick="openView(\'bulletin\')"]');
  await page.waitForTimeout(150);
  await page.fill('#bulletinTitleInput', '別件のお知らせ');
  await page.fill('#bulletinBodyInput', '内容です');
  await page.click('button[onclick="addBulletinPost()"]');
  await page.waitForTimeout(300);
  await page.fill('#bulletinSearchInput', '重要');
  await page.waitForTimeout(150);
  check('bulletin search "重要" result count', 1, await page.locator('#bulletinList .card').count());
  await page.fill('#bulletinSearchInput', '存在しないキーワードxyz');
  await page.waitForTimeout(150);
  info('bulletin search no-match shows empty state', await page.locator('#bulletinList .empty-state').count() === 1);
  await page.fill('#bulletinSearchInput', '');
  await page.waitForTimeout(150);
  check('bulletin search cleared shows all', 2, await page.locator('#bulletinList .card').count());

  // ===== search: manual =====
  await page.click('[data-view="bulletin"] .back-btn');
  await page.waitForTimeout(150);
  await page.click('.grid-card[onclick="openView(\'manual\')"]');
  await page.waitForTimeout(150);
  await page.click('[data-view="manual"] details summary');
  await page.waitForTimeout(100);
  await page.fill('#manualCategoryInput', 'レジ操作');
  await page.fill('#manualTitleInput', '開店準備の手順');
  await page.fill('#manualBodyInput', 'レジを開ける');
  await page.click('button[onclick="addManual()"]');
  await page.waitForTimeout(300);
  await page.fill('#manualSearchInput', '開店');
  await page.waitForTimeout(150);
  info('manual search "開店" match found', (await page.locator('#manualList summary').allInnerTexts()));
  await page.fill('#manualSearchInput', 'nomatch12345');
  await page.waitForTimeout(150);
  info('manual search no-match shows empty state', await page.locator('#manualList .empty-state').count() === 1);

  // ===== owner: customize valuable tags, verify registration checkboxes update =====
  await page.click('[data-view="manual"] .back-btn');
  await page.waitForTimeout(150);
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  await page.waitForTimeout(150);
  await page.click('#ownerDrawer details summary:has-text("忘れ物・警察届出設定")');
  await page.waitForTimeout(100);
  await page.fill('#lostValuableTagOptionsInput', 'カスタムA\nカスタムB');
  await page.click('button[onclick="saveLostTagOptions()"]');
  await page.waitForTimeout(300);
  info('tag save status', await page.locator('#lostTagOptionsStatus').innerText());
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  await page.click('.grid-card[onclick="openView(\'lostfound\')"]');
  await page.waitForTimeout(150);
  await page.click('[data-view="lostfound"] details summary');
  await page.waitForTimeout(100);
  const customValuableLabels = await page.locator('#lostValuableTagGroup label').evaluateAll(els => els.map(e => e.textContent));
  info('custom valuable tag options rendered', customValuableLabels);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
