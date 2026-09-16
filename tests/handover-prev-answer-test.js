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
    localStorage.setItem('active_store', '博多住吉通り');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);

  // 引継ぎ項目を2件 + 前回の引継ぎ(「あり」で詳細つき / 件数)を用意
  await page.evaluate(() => {
    const db = window.firebase.firestore();
    db.collection('appSettings').doc('general').set({ stores: ['博多住吉通り'] });
    db.collection('handoverItems').add({ question: 'レジの過不足はありましたか？', answerType: 'yesno', yesTemplate: 'レジ過不足あり', important: true, createdAt: new Date() });
    db.collection('handoverItems').add({ question: '店頭受取の荷物は何件ありますか？', answerType: 'count', yesTemplate: '店頭受取荷物: {n}件', important: false, createdAt: new Date() });
  });
  await page.waitForTimeout(500);

  const itemIds = await page.evaluate(() => window.handoverItems ? window.handoverItems.map(i => i.id) : null);
  await page.evaluate(async () => {
    const db = window.firebase.firestore();
    const snap = await new Promise(resolve => { db.collection('handoverItems').onSnapshot(s => resolve(s)); });
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const yesno = items.find(i => i.answerType === 'yesno');
    const count = items.find(i => i.answerType === 'count');
    db.collection('notebookEntries').add({
      type: 'handover', store: '博多住吉通り', author: '前任者', text: '（前回の引継ぎ）',
      // 実際のFirestoreが返すTimestamp相当 (toDate()を持つ)
      createdAt: { toDate: () => new Date('2026-09-14T22:30:00+09:00') },
      answers: [
        { itemId: yesno.id, question: yesno.question, yesTemplate: yesno.yesTemplate, answerType: 'yesno', important: true, answer: 'yes', count: '', detail: '100円不足。レジ3番。' },
        { itemId: count.id, question: count.question, yesTemplate: count.yesTemplate, answerType: 'count', important: false, answer: null, count: '2', detail: '' }
      ]
    });
  });
  await page.waitForTimeout(600);

  // ===== ウィザードを開始 =====
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(300);
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(400);

  // 🔁 持ち越し質問が出ないこと = 質問数が登録項目数(2)と一致すること
  console.log('progress label (expect 質問 1 / 2, no carry-over questions):', await page.locator('#handoverProgressLabel').innerText());
  console.log('first question is a registered item (expect true):', (await page.locator('#handoverQuestionText').innerText()).includes('レジの過不足'));
  console.log('no 未解決 carry-over question anywhere (expect false):', (await page.locator('#handoverQuestionText').innerText()).includes('未解決'));

  // 前回の回答が小さく表示されること (あり + 詳細)
  console.log('prev answer shown (expect true):', await page.locator('#handoverPrevAnswer').isVisible());
  const prevText = await page.locator('#handoverPrevAnswer').innerText();
  console.log('prev answer content (expect 前回 + あり + 詳細):', JSON.stringify(prevText));

  // 入力欄は空のまま = 前回値が引き継がれていないこと
  console.log('yes not preselected (expect false):', await page.evaluate(() => document.getElementById('handoverYesBtn').classList.contains('selected')));
  // あり／なしの質問に詳細欄は出さない（引継ぎのテンポを落とさないため）
  console.log('detail field not shown on yes/no (expect false):', await page.locator('#handoverDetailWrap').isVisible());

  // ===== 2問目 (件数タイプ) =====
  await page.click('#handoverYesBtn');
  await page.waitForTimeout(150);
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(300);
  console.log('second question prev answer (expect 前回 + 2件):', JSON.stringify(await page.locator('#handoverPrevAnswer').innerText()));
  console.log('no count preselected (expect 0):', await page.locator('#handoverCountGrid button.selected').count());

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
