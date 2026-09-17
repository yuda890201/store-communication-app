const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');

// 未入力のまま保存された記録（実査0円・設定20万・過不足-20万）を金庫アプリ側に用意する
const UNCOUNTED = {
  datetime: '2026-09-17T16:28', storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
  reg1: { staff: '', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
  reg2: { staff: '', cashDiff: '0', cashDiffDelta: 34, freeCouponDiff: '0', discCouponDiff: '0' },
  vaultTotal: '0', vaultTarget: 200000, vaultDiff: '-200,000', memo: ''
};
const COUNTED = {
  datetime: '2026-09-17T17:10', storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
  reg1: { staff: '佐藤', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
  reg2: { staff: '岡本', cashDiff: '-34', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
  vaultTotal: '200,000', vaultTarget: 200000, vaultDiff: '0', memo: '実査済み'
};

async function boot(browser, sink) {
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  page.on('pageerror', e => sink.errors.push('pageerror: ' + e.message));
  page.on('dialog', d => { sink.dialogs.push({ message: d.message(), type: d.type() }); sink.decide(d); });
  await page.addInitScript(fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8'));
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '清川二丁目');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'u', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      'read@view.example.com': { password: 'vp', user: { uid: 'v', isAnonymous: false, email: 'read@view.example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['清川二丁目'], kinkoAppUrl: 'https://example.com/kinko/',
      kinkoStoreMap: { '清川二丁目': '福岡清川二丁目店' },
      kinkoConfig: { apiKey: 'k', projectId: 'kinko-app-2f5e4', viewerEmail: 'read@view.example.com', viewerPassword: 'vp' }
    });
    window.firebase.firestore().collection('handoverItems').add({
      question: 'レジの過不足はありましたか？', answerType: 'yesno', yesTemplate: 'レジ過不足あり', important: false, createdAt: new Date()
    });
  });
  await page.waitForTimeout(500);
  return page;
}

async function seedKinko(page, record) {
  await page.evaluate(rec => {
    const app = window.firebase.apps.find(a => a.name === 'kinkoApp')
      || window.firebase.initializeApp({ apiKey: 'k', projectId: 'kinko-app-2f5e4' }, 'kinkoApp');
    const kdb = app.firestore();
    kdb.collection('meta').doc('storeMaster').set({ stores: [{ id: 'store-kiyokawa', name: '福岡清川二丁目店', target: 200000 }] });
    kdb.collection('storesConfig').doc('store-kiyokawa').collection('records').add(rec);
  }, record);
  await page.waitForTimeout(400);
}

async function postHandover(page) {
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(300);
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(400);
  await page.click('#handoverNoBtn');
  await page.waitForTimeout(150);
  await page.click('#handoverNextBtn');
  await page.waitForTimeout(300);
  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(700);
}

async function returnFromKinko(page) {
  await page.evaluate(() => markAwaitingKinkoReturn());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const sink = { errors: [], dialogs: [], decide: d => d.accept() };

  // ===== 1. 未入力の記録は自動取り込みしないこと =====
  const page = await boot(browser, sink);
  await seedKinko(page, UNCOUNTED);
  await postHandover(page);
  await returnFromKinko(page);

  const status = await page.locator('#handoverKinkoImportStatus').innerText();
  console.log('uncounted record is NOT auto-imported (expect true):', status.includes('実査合計が0円'));
  console.log('status explains what to do (expect true):', status.includes('入力して保存し直して'));
  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(500);
  // 取り込みボタンが残っている = その引継ぎに kinkoRecord が入っていない
  console.log('nothing was attached to the entry (expect 1 = button still there):',
    await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());
  console.log('handover shows the un-imported warning (expect true):', await page.evaluate(() =>
    document.getElementById('latestHandoverKinko').classList.contains('kinko-block-missing')));
  console.log('the false -200,000 is not in the handover (expect false):', (await page.locator('#latestHandoverKinko').innerText()).includes('-200,000'));

  // ===== 2. 数え直した記録なら取り込めること（同じ導線で再開できる） =====
  await seedKinko(page, COUNTED);
  await page.evaluate(() => openView('notebook'));
  await page.waitForTimeout(300);
  const btn = page.locator('#notebookList button:has-text("金庫の結果を取り込む")').first();
  await btn.click();
  await page.waitForTimeout(1000);
  const latest = await page.locator('#latestHandoverKinko').innerText();
  console.log('counted record imports fine (expect true):', latest.includes('200,000') && !latest.includes('-200,000'));
  console.log('no confirm dialog for a counted record (expect 0):', sink.dialogs.filter(d => d.type === 'confirm').length);

  // ===== 3. 手動取り込みでは確認を挟み、キャンセルすれば入らないこと =====
  const sink2 = { errors: [], dialogs: [], decide: d => d.dismiss() }; // キャンセルする
  const page2 = await boot(browser, sink2);
  await seedKinko(page2, UNCOUNTED);
  await page2.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', store: '清川二丁目', author: 'テスト太郎', text: '・取り込み前の引継ぎ', answers: [],
      createdAt: { toDate: () => new Date('2026-09-17T16:30:00+09:00') }
    });
  });
  await page2.waitForTimeout(500);
  await page2.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page2.waitForTimeout(400);
  await page2.locator('#notebookList button:has-text("金庫の結果を取り込む")').first().click();
  await page2.waitForTimeout(900);
  const confirms = sink2.dialogs.filter(d => d.type === 'confirm');
  console.log('manual import asks for confirmation (expect 1):', confirms.length);
  console.log('confirmation names the real figures (expect true):',
    confirms.length > 0 && confirms[0].message.includes('実査合計が0円') && confirms[0].message.includes('200,000'));
  console.log('cancelling leaves the entry untouched (expect 1 = button still there):',
    await page2.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());

  // ===== 4. 承認すれば取り込めること（本当に空の金庫のため） =====
  sink2.decide = d => d.accept();
  await page2.locator('#notebookList button:has-text("金庫の結果を取り込む")').first().click();
  await page2.waitForTimeout(900);
  console.log('accepting the confirm does import it (expect 0 = button gone):',
    await page2.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());

  console.log('errors:', JSON.stringify(sink.errors.concat(sink2.errors)));
  await browser.close();
})();
