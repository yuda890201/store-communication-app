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
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  console.log('connected (expect ✅ 接続済み):', await page.locator('#dbStatusHome').innerText());

  await page.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({ type: 'note', text: 'basic mock check', author: 'テスト', store: '', createdAt: new Date() });
  });
  await page.waitForTimeout(300);
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  console.log('notebook entry visible:', (await page.locator('#notebookList').innerText()).includes('basic mock check'));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
