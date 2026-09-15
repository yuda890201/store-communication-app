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

  // seed stores list
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(200);

  // open settings drawer, check active store select populated & defaulted
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  const activeStoreValue = await page.locator('#activeStoreSelect').inputValue();
  console.log('default active store:', activeStoreValue);
  await page.screenshot({ path: path.join(__dirname, 'ms01-settings.png') });
  await page.click('.side-drawer-close-btn');

  // post to notebook while active store = 渋谷店
  await page.click(`.grid-card[onclick="openView('notebook')"]`);
  await page.fill('#notebookInput', '渋谷店からの連絡');
  await page.click('button[onclick="addNotebookEntry()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ms02-notebook-shibuya.png') });

  // switch active store to 新宿店 via settings
  await page.click('[data-view="notebook"] .settings-btn:has-text("⚙️")');
  await page.selectOption('#activeStoreSelect', '新宿店');
  await page.waitForTimeout(150);
  await page.click('.side-drawer-close-btn');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(__dirname, 'ms03-notebook-shinjuku-empty.png') });

  await page.fill('#notebookInput', '新宿店からの連絡');
  await page.click('button[onclick="addNotebookEntry()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ms04-notebook-shinjuku-posted.png') });

  const notebookCountShinjuku = await page.locator('#notebookList .card').count();
  console.log('notebook cards visible while filtered to 新宿店:', notebookCountShinjuku);

  // enable show all stores
  await page.click('[data-view="notebook"] .settings-btn:has-text("⚙️")');
  await page.check('#showAllStoresCheckbox');
  await page.waitForTimeout(150);
  await page.click('.side-drawer-close-btn');
  await page.waitForTimeout(150);
  const notebookCountAll = await page.locator('#notebookList .card').count();
  console.log('notebook cards visible with show-all enabled:', notebookCountAll);
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
  console.log('bulletin cards visible filtered to 新宿店 (should be 1, the common one):', bulletinCountShinjukuFilter);
  await page.screenshot({ path: path.join(__dirname, 'ms07-bulletin-filtered-shinjuku.png') });

  await page.selectOption('#bulletinFilterStore', '渋谷店');
  await page.waitForTimeout(150);
  const bulletinCountShibuyaFilter = await page.locator('#bulletinList .card').count();
  console.log('bulletin cards visible filtered to 渋谷店 (should be 2):', bulletinCountShibuyaFilter);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
