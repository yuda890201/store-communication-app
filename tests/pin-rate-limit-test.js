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
  console.log('first login succeeded (pin overlay closed):', !(await page.locator('#pinLoginOverlay').evaluate(el => el.classList.contains('open'))));
  console.log('attempts on first login (expect 1, staff@ is tried first):', await page.evaluate(() => window.__signInAttempts.length));
  console.log('cached email saved:', await page.evaluate(() => localStorage.getItem('cached_shared_login_email')));

  // ===== ログアウトして再ログイン (キャッシュされたメールが最初に試される) =====
  await page.evaluate(async () => { await firebase.auth().signOut(); window.__signInAttempts = []; });
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(400);
  const attemptsSecond = await page.evaluate(() => window.__signInAttempts);
  console.log('attempts on cached re-login (expect exactly 1 = ["staff@my-store-1234.local"]):', JSON.stringify(attemptsSecond));

  // ===== 間違ったPINでは「PINコードが違います」が出ること =====
  await page.evaluate(async () => { await firebase.auth().signOut(); window.__signInAttempts = []; });
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'totallywrong');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(1500);
  console.log('wrong pin message (expect PINコードが違います):', await page.locator('#pinLoginStatus').innerText());
  console.log('attempts on wrong pin (expect <= 7, cached+staff@+5 numbered, deduped):', await page.evaluate(() => window.__signInAttempts.length));

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
  console.log('rate-limit message shown (expect true):', (await page.locator('#pinLoginStatus').innerText()).includes('一時的に制限'));
  console.log('stopped after first too-many-requests (expect 1 attempt):', await page.evaluate(() => window.__signInAttempts.length));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
