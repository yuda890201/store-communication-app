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

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };

    // signInWithEmailAndPassword の呼び出し回数を数える
    window.__signInAttempts = [];
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);

  // 呼び出し回数を計測できるようラップする
  await page.evaluate(() => {
    const app = window.firebase.app();
    const originalAuth = app.auth.bind(app);
    app.auth = () => {
      const authInstance = originalAuth();
      const originalSignIn = authInstance.signInWithEmailAndPassword.bind(authInstance);
      authInstance.signInWithEmailAndPassword = (email, password) => {
        window.__signInAttempts.push(email);
        return originalSignIn(email, password);
      };
      return authInstance;
    };
  });

  // ===== 初回ログイン (キャッシュなし・正しいPIN) =====
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);
  info('first login succeeded (pin overlay closed)', !(await page.locator('#pinLoginOverlay').evaluate(el => el.classList.contains('open'))));
  check('初回ログインは staff@ の1回で済む', 1, await page.evaluate(() => window.__signInAttempts.length));
  info('cached email saved', await page.evaluate(() => localStorage.getItem('cached_shared_login_email')));

  // ===== ログアウトして再ログイン (キャッシュされたメールが最初に試される) =====
  await page.evaluate(async () => { await firebase.auth().signOut(); window.__signInAttempts = []; });
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(400);
  const attemptsSecond = await page.evaluate(() => window.__signInAttempts);
  check('キャッシュ後の再ログインも1回だけ', '["staff@my-store-1234.local"]', JSON.stringify(attemptsSecond));

  // ===== 間違ったPINでは「PINコードが違います」が出ること =====
  await page.evaluate(async () => { await firebase.auth().signOut(); window.__signInAttempts = []; });
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'totallywrong');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(1500);
  checkIncludes('違うPINのときの文言', await page.locator('#pinLoginStatus').innerText(), 'PINコードが違います');
  const attemptsWrong = await page.evaluate(() => window.__signInAttempts.length);
  check('違うPINでも試行はキャッシュ+staff@+staff01〜05の範囲（7回以下）', true, attemptsWrong <= 7, `実際 ${attemptsWrong}回`);

  // ===== too-many-requests エラーで即座に中断し、専用メッセージが出ること =====
  await page.evaluate(() => {
    const app = window.firebase.app();
    const authInstance = app.auth();
    authInstance.signInWithEmailAndPassword = async (email, password) => {
      window.__signInAttempts.push(email);
      const err = new Error('Too many unsuccessful login attempts');
      err.code = 'auth/too-many-requests';
      throw err;
    };
    app.auth = () => authInstance;
    window.__signInAttempts = [];
  });
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);
  check('rate-limit message shown', true, (await page.locator('#pinLoginStatus').innerText()).includes('一時的に制限'));
  check('レート制限が出たら以降は試さない', 1, await page.evaluate(() => window.__signInAttempts.length));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
