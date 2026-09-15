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
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'mock' }));
    localStorage.setItem('my_name', 'テスト太郎');
    window.__mockUsers = {
      'staff@mock.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@mock.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店'] });
  });
  await page.waitForTimeout(200);
  await page.click('.grid-card[onclick="openView(\'lostfound\')"]');
  await page.waitForTimeout(150);
  await page.click('[data-view="lostfound"] details summary');
  await page.waitForTimeout(100);

  // register a valuable item found today -> should trigger initial police reminder post
  await page.fill('#lostTitleInput', '黒い財布');
  await page.check('#lostValuableTagGroup input[value="財布"]');
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(400);

  // register an old item (4 months ago) -> should trigger disposal reminder post
  const fourMonthsAgo = new Date();
  fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
  await page.fill('#lostTitleInput', '古い傘');
  await page.fill('#lostDateInput', fourMonthsAgo.toISOString().slice(0, 10));
  await page.click('button[onclick="addLostItem()"]');
  await page.waitForTimeout(400);

  async function readNotebookTexts() {
    await page.click(`.grid-card[onclick="openView('notebook')"]`);
    await page.waitForTimeout(150);
    const texts = await page.locator('#notebookList .card .entry-body').allInnerTexts();
    await page.click('[data-view="notebook"] .back-btn');
    await page.waitForTimeout(100);
    return texts;
  }
  async function readChatTexts() {
    await page.click(`.grid-card[onclick="openView('chat')"]`);
    await page.waitForTimeout(150);
    const texts = await page.locator('#chatMessageList .chat-bubble, #chatMessageList .chat-bubble-other').allInnerTexts();
    await page.click('[data-view="chat"] .back-btn');
    await page.waitForTimeout(100);
    return texts;
  }

  await page.click('[data-view="lostfound"] .back-btn');
  await page.waitForTimeout(150);
  console.log('notebookEntries after registration:', await readNotebookTexts());
  console.log('chatMessages after registration:', await readChatTexts());

  // re-run the check again (simulate another snapshot fire) -> should NOT duplicate posts
  await page.evaluate(() => checkAndPostLostReminders());
  await page.waitForTimeout(300);
  console.log('notebookEntries count after re-check (should be unchanged, 2):', (await readNotebookTexts()).length);

  // simulate the wallet becoming 8 days overdue without having been reported, to test escalation
  await page.click(`.grid-card[onclick="openView('lostfound')"]`);
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    const doc = await window.firebase.firestore().collection('appSettings').doc('general').get();
    return doc; // just to ensure firebase is ready
  });
  const walletId = await page.evaluate(() => {
    return new Promise(resolve => {
      let unsub;
      unsub = window.firebase.firestore().collection('lostItems').onSnapshot(snap => {
        const found = snap.docs.find(d => d.data().title === '黒い財布');
        if (found) { if (unsub) unsub(); resolve(found.id); }
      });
    });
  });
  const eightDaysAgo = new Date();
  eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
  await page.evaluate(({ walletId, dateStr }) => {
    return window.firebase.firestore().collection('lostItems').doc(walletId).update({ foundDate: dateStr });
  }, { walletId, dateStr: eightDaysAgo.toISOString().slice(0, 10) });
  await page.waitForTimeout(300);
  await page.click('[data-view="lostfound"] .back-btn');
  await page.waitForTimeout(150);
  await page.evaluate(() => checkAndPostLostReminders());
  await page.waitForTimeout(300);
  console.log('notebookEntries after overdue escalation (expect 3):', await readNotebookTexts());

  // re-run again to confirm no duplicate escalation post
  await page.evaluate(() => checkAndPostLostReminders());
  await page.waitForTimeout(300);
  console.log('notebookEntries count after re-check post-escalation (should be unchanged, 3):', (await readNotebookTexts()).length);

  // ===== pull-to-refresh test =====
  const indicatorInitialMarginTop = await page.evaluate(() => getComputedStyle(document.getElementById('pullRefreshIndicator')).marginTop);
  console.log('pull indicator initial margin-top (should be -56px):', indicatorInitialMarginTop);

  const touchSupported = await page.evaluate(() => {
    try {
      const t = new Touch({ identifier: 1, target: document.body, clientX: 50, clientY: 10 });
      return !!t;
    } catch (e) { return 'error: ' + e.message; }
  });
  console.log('Touch constructor supported:', touchSupported);

  if (touchSupported === true) {
    const urlBefore = page.url();
    await page.evaluate(() => {
      function makeTouch(y, target) {
        return new Touch({ identifier: 42, target, clientX: 100, clientY: y, pageX: 100, pageY: y });
      }
      const target = document.body;
      let t = makeTouch(50, target);
      target.dispatchEvent(new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
      t = makeTouch(200, target);
      target.dispatchEvent(new TouchEvent('touchmove', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
      target.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);
    const urlAfter = page.url();
    console.log('url before pull:', urlBefore);
    console.log('url after pull (should contain _r= if refresh triggered):', urlAfter);
  }

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
