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
    // pre-seed the shared PIN account, as if created via Firebase Console
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      // オーナー設定は管理者の個人アカウントでのログインが要るようになった
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  // ===== PIN login flow =====
  const loginOverlayVisible = await page.locator('#pinLoginOverlay.open').count();
  info('PIN login overlay shown on load', loginOverlayVisible === 1);

  await page.fill('#pinLoginInput', 'wrongpin');
  await page.click('#pinLoginForm button[type=submit], #pinLoginForm button');
  await page.waitForTimeout(300);
  info('status after wrong pin', await page.locator('#pinLoginStatus').innerText());

  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button[type=submit], #pinLoginForm button');
  await page.waitForTimeout(300);
  info('PIN login overlay closed after correct pin', (await page.locator('#pinLoginOverlay.open').count()) === 0);

  // オーナー設定を開くには、このアカウントが管理者として登録されている必要がある
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general')
      .set({ adminEmails: ['owner@test.example.com'] }, { merge: true });
  });
  await page.waitForTimeout(300);

  // ===== PIN change flow =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  await page.waitForTimeout(150);
  await page.click('#ownerDrawer details summary:has-text("店舗共通PINコードの変更")');
  await page.waitForTimeout(100);

  // wrong current pin
  await page.fill('#pinChangeCurrentInput', 'wrongcurrent');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'newpin99');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(300);
  info('status after wrong current pin', await page.locator('#pinChangeStatus').innerText());

  // mismatched confirm
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'different');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(200);
  info('status after mismatched confirm', await page.locator('#pinChangeStatus').innerText());

  // too short new pin
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'ab1');
  await page.fill('#pinChangeConfirmInput', 'ab1');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(200);
  info('status after too-short new pin', await page.locator('#pinChangeStatus').innerText());

  // PIN変更は「店舗共通アカウントでログイン中」でないと実行できない。
  // いまは管理者の個人アカウントでログインしている（オーナー設定を開くために必要）ので、
  // アプリが案内するとおり管理者チャットのログアウトで共通アカウントに戻す。
  //
  // ⚠️ 実運用では、この手順を通常のUI操作でたどれない。
  //    ログアウトのボタンは管理者チャット画面の中にあり、そこへ行くにはオーナー設定を
  //    閉じる必要がある。閉じると isAdminUser が false になり、オーナー設定を開き直せない。
  //    （オーナー設定を開いたままなら成功する。ここではその状態を作っている）
  await page.evaluate(() => doLogout());
  await page.waitForTimeout(400);

  // successful change
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'newpin99');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(300);
  info('status after successful change', await page.locator('#pinChangeStatus').innerText());

  // verify old pin no longer works, new pin does, by trying a fresh sign-in
  const signInResults = await page.evaluate(async () => {
    const results = {};
    try {
      await window.firebase.auth().signOut();
      await window.firebase.auth().signInWithEmailAndPassword('staff@my-store-1234.local', 'pin1234');
      results.oldPinWorked = true;
    } catch (e) { results.oldPinWorked = false; }
    try {
      await window.firebase.auth().signInWithEmailAndPassword('staff@my-store-1234.local', 'newpin99');
      results.newPinWorked = true;
    } catch (e) { results.newPinWorked = false; }
    return results;
  });
  check('old pin still works', false, signInResults.oldPinWorked);
  check('new pin works', true, signInResults.newPinWorked);

  // ===== image compression tests =====
  const compressionResults = await page.evaluate(async () => {
    function makePngFile(w, h, name) {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      // fill with per-pixel random noise so PNG can't compress it away (mimics a real photo's entropy)
      const imgData = ctx.createImageData(w, h);
      for (let i = 0; i < imgData.data.length; i += 4) {
        imgData.data[i] = Math.random() * 255;
        imgData.data[i + 1] = Math.random() * 255;
        imgData.data[i + 2] = Math.random() * 255;
        imgData.data[i + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      return new Promise(resolve => {
        canvas.toBlob(blob => resolve(new File([blob], name, { type: 'image/png' })), 'image/png');
      });
    }

    const results = {};

    // 1. large image should be resized and shrunk
    const bigFile = await makePngFile(2400, 1800, 'big.png');
    results.bigOriginalSize = bigFile.size;
    const bigCompressed = await compressImageIfNeeded(bigFile);
    results.bigCompressedSize = bigCompressed.size;
    results.bigCompressedType = bigCompressed.type;
    results.bigCompressedName = bigCompressed.name;
    const bmp = await createImageBitmap(bigCompressed);
    results.bigCompressedDims = { w: bmp.width, h: bmp.height };

    // 2. small image should be left alone (under skipUnderBytes threshold)
    const smallFile = await makePngFile(50, 50, 'small.png');
    results.smallOriginalSize = smallFile.size;
    const smallCompressed = await compressImageIfNeeded(smallFile);
    results.smallUnchanged = smallCompressed === smallFile;

    // 3. non-image file should pass through untouched
    const textFile = new File(['hello world'], 'note.txt', { type: 'text/plain' });
    const textResult = await compressImageIfNeeded(textFile);
    results.textUnchanged = textResult === textFile;

    return results;
  });
  info('compression test results', JSON.stringify(compressionResults, null, 2));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
