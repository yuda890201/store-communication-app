const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    // 店舗共通PINアカウントは存在するが、オーナーはPINを知らない状況を再現
    window.__mockUsers = {
      'staff01@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff01@my-store-1234.local', displayName: null } },
      'owner@example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  console.log('PIN overlay shown on load (expect true):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));

  // ===== PINが分からない状態を再現 =====
  await page.fill('#pinLoginInput', 'wrongpin');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(1200);
  console.log('wrong pin message (expect PINコードが違います):', await page.locator('#pinLoginStatus').innerText());
  console.log('still locked out on PIN screen (expect true):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));

  // ===== オーナーとしてログインできること =====
  console.log('owner login box hidden by default (expect false):', await page.locator('#pinOwnerLoginBox').isVisible());
  await page.click('button[onclick="togglePinOwnerLogin()"]');
  await page.waitForTimeout(150);
  console.log('owner login box revealed (expect true):', await page.locator('#pinOwnerLoginBox').isVisible());

  // 間違ったパスワードではエラーが出ること
  await page.fill('#pinOwnerEmail', 'owner@example.com');
  await page.fill('#pinOwnerPassword', 'wrong-pass');
  await page.click('button[onclick="doPinOwnerLogin()"]');
  await page.waitForTimeout(400);
  console.log('owner wrong password shows error (expect true):', (await page.locator('#pinOwnerLoginStatus').innerText()).includes('ログインに失敗'));
  console.log('still locked out after wrong owner password (expect true):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));

  // 正しいオーナー認証情報でログインできること
  await page.fill('#pinOwnerEmail', 'owner@example.com');
  await page.fill('#pinOwnerPassword', 'owner-pass1');
  await page.click('button[onclick="doPinOwnerLogin()"]');
  await page.waitForTimeout(600);
  console.log('PIN overlay closed after owner login (expect false):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));
  console.log('db connected (expect ✅ 接続済み):', await page.locator('#dbStatusHome').innerText());

  // ログイン後に⚙️設定が開けること
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(250);
  console.log('settings drawer reachable after owner login (expect true):', await page.evaluate(() => document.getElementById('sideDrawer').classList.contains('open')));

  // 通常のPINログインが壊れていないことも確認
  await page.evaluate(async () => { await firebase.auth().signOut(); });
  await page.waitForTimeout(400);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(600);
  console.log('normal PIN login still works (expect false = overlay closed):', await page.evaluate(() => document.getElementById('pinLoginOverlay').classList.contains('open')));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
