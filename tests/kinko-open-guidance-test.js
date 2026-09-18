const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
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
  check('link carries the store', true, href.includes('#store='));
  check('store is URL-encoded', true, href.includes(encodeURIComponent('博多住吉通り店')));
  // このアプリの名前ではなく、金庫アプリ側の名前を渡さないと一致しない
  check('sends the safe app store name, not ours', true, decodeURIComponent(href.split('#store=')[1]) === '博多住吉通り店');
  check('base url is kept', true, href.startsWith('https://example.com/kinko/'));

  // ===== 開く前に、どの店舗として開くかが出ていること =====
  check('store note shown before tapping', true, await page.locator('#handoverKinkoStoreNote').isVisible());
  const note = await page.locator('#handoverKinkoStoreNote').innerText();
  check('note uses the safe app store name', true, note.includes('博多住吉通り店'));
  check('note tells them what to do if it differs', true, note.includes('保存せず'));
  check('store name is emphasised', 1, await page.locator('#handoverKinkoStoreNote strong').count());

  // ===== 戻り方の案内が、押す前から見えていること =====
  const back = await page.locator('.kinko-open-back').innerText();
  check('return instructions shown', true, back.includes('左上') && back.includes('✕'));
  check('says it imports automatically', true, back.includes('自動'));

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
  check('note is above the button', true, order.note >= 0 && order.note < order.link);
  check('return note is below the button', true, order.back > order.link);

  // ===== 対応付けが無い店舗では、こちらの店舗名をそのまま出すこと =====
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ kinkoStoreMap: {} }, { merge: true });
  });
  await page.waitForTimeout(400);
  await postHandover();
  check('falls back to our own store name', true, (await page.locator('#handoverKinkoStoreNote').innerText()).includes('博多住吉通り'));

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
  check('existing hash is replaced, not appended', 1, href2.split('#').length - 1);
  check('still points at the right store', true, href2.endsWith(encodeURIComponent('博多住吉通り店')));
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
  check('EN note is translated', true, enNote.includes('opens as') && enNote.includes('博多住吉通り'));
  check('EN return instructions translated', true, enBack.includes('top left'));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
