const { chromium } = require('playwright');
const { check, checkIncludes, info, report } = require('./assert');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;

const sharedDocs = {}; // path -> data (or absent = deleted)
let pages = [];

async function broadcast(path, data) {
  for (const p of pages) {
    try {
      await p.evaluate(({ path, data }) => window.__mockApplyRemoteWrite(path, data), { path, data: data === undefined ? null : data });
    } catch (e) { /* page may be closed */ }
  }
}

async function setupPageMock(page, label) {
  await page.exposeFunction('__sharedWrite', async (path, data, merge) => {
    const merged = merge && sharedDocs[path] ? { ...sharedDocs[path], ...data } : { ...data };
    sharedDocs[path] = merged;
    await broadcast(path, merged);
    return merged;
  });
  await page.exposeFunction('__sharedRead', async (path) => sharedDocs[path] || null);
  await page.exposeFunction('__sharedReadCollection', async (colPath) => {
    const prefix = colPath + '/';
    return Object.keys(sharedDocs)
      .filter(k => k.startsWith(prefix) && k.slice(prefix.length).split('/').length === 1)
      .map(k => ({ id: k.slice(prefix.length), data: sharedDocs[k] }));
  });
  await page.exposeFunction('__sharedReadCollectionGroup', async (colName) => {
    return Object.keys(sharedDocs)
      .filter(k => k.split('/').slice(-2, -1)[0] === colName)
      .map(k => ({ id: k.split('/').pop(), path: k, data: sharedDocs[k] }));
  });
  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock-shared.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    // アプリ全体がPINログインで保護されている。このテストはPIN導入前に書かれたもの
    window.__mockUsers = {
      'staff@mock.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@mock.local', displayName: null } }
    };
  });
  page.on('pageerror', err => console.log(`[${label} pageerror]`, err.message));
  page.on('console', msg => console.log(`[${label} console:${msg.type()}]`, msg.text()));
  pages.push(page);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-web-security'
    ]
  });

  const staffCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  const adminCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera', 'microphone'] });
  const staffPage = await staffCtx.newPage();
  const adminPage = await adminCtx.newPage();

  await setupPageMock(staffPage, 'staff');
  await setupPageMock(adminPage, 'admin');

  await staffPage.goto(`http://localhost:${PORT}/index.html`);
  await adminPage.goto(`http://localhost:${PORT}/index.html`);
  await staffPage.waitForTimeout(400);
  await adminPage.waitForTimeout(400);

  // 2端末ともPINでログインする
  for (const p of [staffPage, adminPage]) {
    await p.fill('#pinLoginInput', 'pin1234');
    await p.click('#pinLoginForm button');
    await p.waitForTimeout(400);
  }

  // seed settings directly through the shared store
  sharedDocs['appSettings/general'] = { staffInviteCode: 'test123', adminEmails: ['admin@example.com'] };
  await broadcast('appSettings/general', sharedDocs['appSettings/general']);
  await staffPage.waitForTimeout(150);
  await adminPage.waitForTimeout(150);

  // register staff
  await staffPage.click(`.grid-card[onclick="openView('adminchat')"]`);
  await staffPage.click('#authTabRegisterBtn');
  await staffPage.fill('#registerName', '佐藤');
  await staffPage.fill('#registerEmail', 'sato@example.com');
  await staffPage.fill('#registerPassword', 'password123');
  await staffPage.fill('#registerInviteCode', 'test123');
  await staffPage.click('button[onclick="doRegister()"]');
  await staffPage.waitForTimeout(400);

  // register admin
  await adminPage.click(`.grid-card[onclick="openView('adminchat')"]`);
  await adminPage.click('#authTabRegisterBtn');
  await adminPage.fill('#registerName', '店長');
  await adminPage.fill('#registerEmail', 'admin@example.com');
  await adminPage.fill('#registerPassword', 'password123');
  await adminPage.fill('#registerInviteCode', 'test123');
  await adminPage.click('button[onclick="doRegister()"]');
  await adminPage.waitForTimeout(400);

  await staffPage.screenshot({ path: path.join(__dirname, 'call01-staff-thread.png') });
  await adminPage.screenshot({ path: path.join(__dirname, 'call02-admin-inbox.png') });

  // staff places a call to admin
  await staffPage.click('button[onclick="startCallFromThread()"]');
  await staffPage.waitForTimeout(800);
  await staffPage.screenshot({ path: path.join(__dirname, 'call03-staff-calling.png') });
  info('callStartStatus text', await staffPage.locator('#callStartStatus').innerText());
  info('shared store keys', Object.keys(sharedDocs));
  // 中身の全文（SDPを含む）は長すぎて読めないため出さない。
  // 追う必要があるときは window.__mockDebug = true にしてください

  // admin should see incoming call banner
  await adminPage.waitForTimeout(500);
  await adminPage.screenshot({ path: path.join(__dirname, 'call04-admin-incoming.png') });
  const bannerVisible = await adminPage.locator('#incomingCallOverlay').evaluate(el => el.classList.contains('open'));
  check('管理者に着信が出る', true, bannerVisible);
  const callerNameText = await adminPage.locator('#incomingCallFrom').innerText();
  checkIncludes('着信に発信者の名前が出る', callerNameText, '佐藤');

  if (!bannerVisible) {
    console.log('ABORTING further steps: banner never appeared');
    await browser.close();
    return;
  }

  // admin accepts
  await adminPage.click('button[onclick="acceptIncomingCall()"]');
  await adminPage.waitForTimeout(1200);
  await adminPage.screenshot({ path: path.join(__dirname, 'call05-admin-in-call.png') });
  await staffPage.waitForTimeout(500);
  await staffPage.screenshot({ path: path.join(__dirname, 'call06-staff-in-call.png') });

  const staffCallStatus = await staffPage.locator('#callStatusText').innerText();
  const adminCallStatus = await adminPage.locator('#callStatusText').innerText();
  checkIncludes('発信側が通話中になる', staffCallStatus, '通話中');
  checkIncludes('着信側も通話中になる', adminCallStatus, '通話中');

  const staffRemoteHasStream = await staffPage.locator('#remoteVideo').evaluate(el => !!el.srcObject);
  const adminRemoteHasStream = await adminPage.locator('#remoteVideo').evaluate(el => !!el.srcObject);
  const staffLocalHasStream = await staffPage.locator('#localVideo').evaluate(el => !!el.srcObject);
  const adminLocalHasStream = await adminPage.locator('#localVideo').evaluate(el => !!el.srcObject);
  check('発信側に相手の映像が届く', true, staffRemoteHasStream);
  check('発信側に自分の映像が出る', true, staffLocalHasStream);
  check('着信側に相手の映像が届く', true, adminRemoteHasStream);
  check('着信側に自分の映像が出る', true, adminLocalHasStream);

  // admin hangs up
  await adminPage.click('button[onclick="hangUpCall()"]');
  await adminPage.waitForTimeout(800);
  await staffPage.waitForTimeout(500);
  await staffPage.screenshot({ path: path.join(__dirname, 'call07-staff-after-hangup.png') });
  await adminPage.screenshot({ path: path.join(__dirname, 'call08-admin-after-hangup.png') });

  const staffOverlayOpenAfterHangup = await staffPage.locator('#callOverlay').evaluate(el => el.classList.contains('open'));
  const adminOverlayOpenAfterHangup = await adminPage.locator('#callOverlay').evaluate(el => el.classList.contains('open'));
  check('相手が切ると発信側の通話画面も閉じる', false, staffOverlayOpenAfterHangup);
  check('自分で切ると通話画面が閉じる', false, adminOverlayOpenAfterHangup);

  report();
  await browser.close();
})();
