const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());

  await page.addInitScript(fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8'));
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '博多住吉通り');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'u', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);

  // 対応付けあり: このアプリ「博多住吉通り」→ 金庫アプリ「博多住吉通り店」
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['博多住吉通り'], kinkoAppUrl: 'https://example.com/kinko/',
      kinkoStoreMap: { '博多住吉通り': '博多住吉通り店' }
    });
    window.firebase.firestore().collection('handoverItems').add({
      question: 'レジの過不足はありましたか？', answerType: 'yesno', yesTemplate: 'レジ過不足あり', important: false, createdAt: new Date()
    });
  });
  await page.waitForTimeout(600);

  async function postHandover() {
    await page.click('button[onclick="startHandoverWizard()"]');
    await page.waitForTimeout(400);
    await page.click('#handoverNoBtn');
    await page.waitForTimeout(150);
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(300);
    await page.click('button[onclick="submitHandover()"]');
    await page.waitForTimeout(700);
  }

  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(300);
  await postHandover();

  // ===== リンクに店舗が載っていること（金庫アプリ側が #store= を読む） =====
  const href = await page.locator('#handoverKinkoLink').getAttribute('href');
  console.log('link carries the store (expect true):', href.includes('#store='));
  console.log('store is URL-encoded (expect true):', href.includes(encodeURIComponent('博多住吉通り店')));
  // このアプリの名前ではなく、金庫アプリ側の名前を渡さないと一致しない
  console.log('sends the safe app store name, not ours (expect true):',
    decodeURIComponent(href.split('#store=')[1]) === '博多住吉通り店');
  console.log('base url is kept (expect true):', href.startsWith('https://example.com/kinko/'));

  // ===== 開く前に、どの店舗として開くかが出ていること =====
  console.log('store note shown before tapping (expect true):', await page.locator('#handoverKinkoStoreNote').isVisible());
  const note = await page.locator('#handoverKinkoStoreNote').innerText();
  console.log('note uses the safe app store name (expect true):', note.includes('博多住吉通り店'));
  console.log('note tells them what to do if it differs (expect true):', note.includes('保存せず'));
  console.log('store name is emphasised (expect 1):', await page.locator('#handoverKinkoStoreNote strong').count());

  // ===== 戻り方の案内が、押す前から見えていること =====
  const back = await page.locator('.kinko-open-back').innerText();
  console.log('return instructions shown (expect true):', back.includes('左上') && back.includes('✕'));
  console.log('says it imports automatically (expect true):', back.includes('自動'));

  // 注意書きはボタンより前、戻り方は後（読む順番になっていること）
  const order = await page.evaluate(() => {
    const card = document.getElementById('handoverDoneCard');
    const kids = [...card.children];
    return {
      note: kids.indexOf(document.getElementById('handoverKinkoStoreNote')),
      link: kids.indexOf(document.getElementById('handoverKinkoLink')),
      back: kids.indexOf(card.querySelector('.kinko-open-back'))
    };
  });
  console.log('note is above the button (expect true):', order.note >= 0 && order.note < order.link);
  console.log('return note is below the button (expect true):', order.back > order.link);

  // ===== 対応付けが無い店舗では、こちらの店舗名をそのまま出すこと =====
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ kinkoStoreMap: {} }, { merge: true });
  });
  await page.waitForTimeout(400);
  await postHandover();
  console.log('falls back to our own store name (expect true):',
    (await page.locator('#handoverKinkoStoreNote').innerText()).includes('博多住吉通り'));

  // ===== URLに既にハッシュが付いていても二重にならないこと =====
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      kinkoAppUrl: 'https://example.com/kinko/#old', kinkoStoreMap: { '博多住吉通り': '博多住吉通り店' }
    }, { merge: true });
  });
  await page.waitForTimeout(400);
  await postHandover();
  const href2 = await page.locator('#handoverKinkoLink').getAttribute('href');
  console.log('existing hash is replaced, not appended (expect 1):', href2.split('#').length - 1);
  console.log('still points at the right store (expect true):', href2.endsWith(encodeURIComponent('博多住吉通り店')));
  // ウィザードは開いたままにして、次の節の「閉じる」に任せる
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      kinkoAppUrl: 'https://example.com/kinko/'
    }, { merge: true });
  });
  await page.waitForTimeout(400);

  // ===== 英語でも出ること（外国人スタッフが使う画面） =====
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => setLang('en'));
  await page.waitForTimeout(300);
  await postHandover();
  const enNote = await page.locator('#handoverKinkoStoreNote').innerText();
  const enBack = await page.locator('.kinko-open-back').innerText();
  console.log('EN note is translated (expect true):', enNote.includes('opens as') && enNote.includes('博多住吉通り'));
  console.log('EN return instructions translated (expect true):', enBack.includes('top left'));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
