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
      'staff@mock.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@mock.local', displayName: null } },
      // オーナー設定は管理者の個人アカウントでのログインが要るようになった
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
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

  // seed 1 store (auto-selected, no modal) + seed default handover items via owner drawer flow directly
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ adminEmails: ['owner@test.example.com'], stores: ['本店'] });
  });
  await page.waitForTimeout(200);

  await page.click(`.grid-card[onclick="openView('notebook')"]`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(__dirname, 'ho01-notebook-empty.png') });

  // try starting wizard with 0 items -> should alert
  page.once('dialog', d => { info('dialog on empty items', d.message()); d.accept(); });
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(150);

  // go add items via owner settings
  await page.click('[data-view="notebook"] .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  await page.waitForTimeout(150);
  await page.click('button[onclick="seedDefaultHandoverItems()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ho02-owner-items-seeded.png') });
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // start wizard now
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(__dirname, 'ho03-wizard-q1.png') });

  // Q1: answer yes with detail
  await page.click('#handoverYesBtn');
  await page.waitForTimeout(100);
  // あり／なしの質問には詳細欄が出なくなった（引継ぎのテンポを落とさないため）。
  // 出ているときだけ入力する
  if (await page.locator('#handoverDetailWrap').isVisible().catch(() => false)) {
    await page.fill('#handoverDetailInput', '3000円不足していた');
  }
  await page.screenshot({ path: path.join(__dirname, 'ho04-wizard-q1-yes-detail.png') });
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(150);

  // 残りの質問に答える。サンプル項目は「あり／なし」だけでなく件数・写真・選択式を
  // 含む構成に変わったため、出ている回答欄に合わせて答える
  for (let i = 0; i < 12; i++) {
    if (!(await page.locator('#handoverPreviewText').isVisible().catch(() => false))) {
      if (await page.locator('#handoverNoBtn').isVisible().catch(() => false)) {
        await page.click('#handoverNoBtn');
      } else if (await page.locator('#handoverCountGrid').isVisible().catch(() => false)) {
        await page.click('#handoverCountGrid button:text-is("0")');
      }
      await page.waitForTimeout(80);
    }
    if (await page.locator('#handoverNextBtn').isVisible().catch(() => false)) {
      await page.click('#handoverNextBtn');
      await page.waitForTimeout(120);
    } else {
      break;
    }
    if (await page.locator('#handoverPreviewText').isVisible().catch(() => false)) break;
  }

  await page.screenshot({ path: path.join(__dirname, 'ho05-preview.png') });
  const previewText = await page.locator('#handoverPreviewText').inputValue();
  console.log('composed preview text:\n' + previewText);

  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'ho06-after-submit.png') });

  const latestHandoverText = await page.locator('#latestHandoverContent').innerText();
  console.log('latest handover card shows:\n' + latestHandoverText);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
