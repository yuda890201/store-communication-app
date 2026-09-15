const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => { console.log('dialog:', d.message()); d.accept(); });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    // pre-seed the shared PIN account, as if created via Firebase Console
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  // ===== PIN login flow =====
  const loginOverlayVisible = await page.locator('#pinLoginOverlay.open').count();
  console.log('PIN login overlay shown on load:', loginOverlayVisible === 1);

  await page.fill('#pinLoginInput', 'wrongpin');
  await page.click('#pinLoginForm button[type=submit], #pinLoginForm button');
  await page.waitForTimeout(300);
  console.log('status after wrong pin:', await page.locator('#pinLoginStatus').innerText());

  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button[type=submit], #pinLoginForm button');
  await page.waitForTimeout(300);
  console.log('PIN login overlay closed after correct pin:', (await page.locator('#pinLoginOverlay.open').count()) === 0);

  // ===== PIN change flow =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(150);
  await page.click('#ownerDrawer details summary:has-text("店舗共通PINコードの変更")');
  await page.waitForTimeout(100);

  // wrong current pin
  await page.fill('#pinChangeCurrentInput', 'wrongcurrent');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'newpin99');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(300);
  console.log('status after wrong current pin:', await page.locator('#pinChangeStatus').innerText());

  // mismatched confirm
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'different');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(200);
  console.log('status after mismatched confirm:', await page.locator('#pinChangeStatus').innerText());

  // too short new pin
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'ab1');
  await page.fill('#pinChangeConfirmInput', 'ab1');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(200);
  console.log('status after too-short new pin:', await page.locator('#pinChangeStatus').innerText());

  // successful change
  await page.fill('#pinChangeCurrentInput', 'pin1234');
  await page.fill('#pinChangeNewInput', 'newpin99');
  await page.fill('#pinChangeConfirmInput', 'newpin99');
  await page.click('button[onclick="changeSharedPin()"]');
  await page.waitForTimeout(300);
  console.log('status after successful change:', await page.locator('#pinChangeStatus').innerText());

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
  console.log('old pin still works (expect false):', signInResults.oldPinWorked);
  console.log('new pin works (expect true):', signInResults.newPinWorked);

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
  console.log('compression test results:', JSON.stringify(compressionResults, null, 2));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
