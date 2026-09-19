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

  // seed stores list
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

  // 店舗の切替は、設定内の <select> からホームの「📍 店舗名 ▾」ボタン＋モーダルに変わった
  const activeStoreValue = await page.evaluate(() => activeStore);
  info('default active store', activeStoreValue);

  // post to notebook while active store = 渋谷店
  await page.click(`.grid-card[onclick="openView('notebook')"]`);
  await page.click('button[onclick="toggleFreeNoteForm()"]');
  await page.waitForTimeout(150);
  await page.fill('#notebookInput', '渋谷店からの連絡');
  await page.click('button[onclick="addNotebookEntry()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ms02-notebook-shibuya.png') });

  // 新宿店に切り替える（ホームに戻ってから店舗切替ボタン → モーダルで選ぶ）
  await page.click('[data-view="notebook"] .back-btn');
  await page.waitForTimeout(150);
  await page.click('#storeSwitchBtn');
  await page.waitForTimeout(200);
  await page.click('.store-option-btn:has-text("新宿店")');
  await page.waitForTimeout(250);
  await page.click(`.grid-card[onclick="openView('notebook')"]`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'ms03-notebook-shinjuku-empty.png') });

  await page.click('button[onclick="toggleFreeNoteForm()"]');
  await page.waitForTimeout(150);
  await page.fill('#notebookInput', '新宿店からの連絡');
  await page.click('button[onclick="addNotebookEntry()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ms04-notebook-shinjuku-posted.png') });

  const notebookCountShinjuku = await page.locator('#notebookList .card').count();
  info('notebook cards visible while filtered to 新宿店', notebookCountShinjuku);

  // enable show all stores
  await page.click('[data-view="notebook"] .settings-btn:has-text("⚙️")');
  await page.check('#showAllStoresCheckbox');
  await page.waitForTimeout(150);
  await page.click('.side-drawer-close-btn');
  await page.waitForTimeout(150);
  const notebookCountAll = await page.locator('#notebookList .card').count();
  info('notebook cards visible with show-all enabled', notebookCountAll);
  await page.screenshot({ path: path.join(__dirname, 'ms05-notebook-showall.png') });

  // bulletin: post with store tag 渋谷店, and post with no tag (common)
  await page.click('[data-view="notebook"] .back-btn');
  await page.waitForTimeout(150);
  await page.click(`.grid-card[onclick="openView('bulletin')"]`);
  await page.waitForTimeout(150);
  await page.fill('#bulletinTitleInput', '渋谷店限定のお知らせ');
  await page.fill('#bulletinBodyInput', '渋谷店だけの内容');
  await page.selectOption('#bulletinStoreTags', ['渋谷店']);
  await page.click('button[onclick="addBulletinPost()"]');
  await page.waitForTimeout(200);

  await page.fill('#bulletinTitleInput', '全店共通のお知らせ');
  await page.fill('#bulletinBodyInput', 'どの店舗でも見える内容');
  await page.click('button[onclick="addBulletinPost()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ms06-bulletin-all.png') });

  await page.selectOption('#bulletinFilterStore', '新宿店');
  await page.waitForTimeout(150);
  const bulletinCountShinjukuFilter = await page.locator('#bulletinList .card').count();
  info('bulletin cards visible filtered to 新宿店 (should be 1, the common one)', bulletinCountShinjukuFilter);
  await page.screenshot({ path: path.join(__dirname, 'ms07-bulletin-filtered-shinjuku.png') });

  await page.selectOption('#bulletinFilterStore', '渋谷店');
  await page.waitForTimeout(150);
  const bulletinCountShibuyaFilter = await page.locator('#bulletinList .card').count();
  info('bulletin cards visible filtered to 渋谷店 (should be 2)', bulletinCountShibuyaFilter);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
