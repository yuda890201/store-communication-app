const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');

// 数えた結果が0円だった記録（本当に空の金庫）。金庫アプリ側で「本当に空ですか？」の
// 確認を通って保存されたもので、こちらは通常の記録として扱わなければならない
function localDatetime(offsetMs) {
  const d = new Date(Date.now() + offsetMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_SAFE = {
  datetime: localDatetime(10 * 60 * 1000), storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
  reg1: { staff: '', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
  reg2: { staff: '', cashDiff: '0', cashDiffDelta: 34, freeCouponDiff: '0', discCouponDiff: '0' },
  vaultTotal: '0', vaultTarget: 200000, vaultDiff: '-200,000', memo: ''
};
const NORMAL = {
  datetime: localDatetime(20 * 60 * 1000), storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
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
  await seedKinko(page, EMPTY_SAFE);
  await postHandover(page);
  await returnFromKinko(page);

  // ===== 1. 空の金庫(0円)でも、そのまま自動取り込みされること =====
  // kinko-app側で「未入力のままでは保存できない」保証が入ったため、保存された0円は
  // 「数えた結果が0円」を意味する。こちらで弾くと、本当に空の金庫を報告できなくなる
  const status = await page.locator('#handoverKinkoImportStatus').innerText();
  console.log('empty safe is auto-imported (expect true):', status.includes('取り込みました'));
  console.log('no warning about counting (expect false):', status.includes('実査合計が0円'));
  console.log('no dialog blocks the auto import (expect 0):', sink.dialogs.length);

  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(500);
  console.log('attached to the entry (expect 0 = button gone):',
    await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());
  console.log('no un-imported warning on the card (expect false):', await page.evaluate(() =>
    document.getElementById('latestHandoverKinko').classList.contains('kinko-block-missing')));

  // 空の金庫は重大な事態。数字を握りつぶさず、そのまま引継ぎ書に出ること
  const emptyText = await page.locator('#latestHandoverKinko').innerText();
  console.log('the shortfall is shown, not swallowed (expect true):', emptyText.includes('-200,000'));
  console.log('the target is shown too (expect true):', emptyText.includes('200,000'));

  // ===== 2. 通常の記録も従来どおり取り込めること =====
  await seedKinko(page, NORMAL);
  await page.evaluate(() => openView('notebook'));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', store: '清川二丁目', author: 'テスト太郎', text: '・2件目の引継ぎ', answers: [],
      // 実行時刻より確実に後。固定時刻だと実行した時間帯次第で最新が入れ替わる
      createdAt: { toDate: () => new Date(Date.now() + 5 * 60 * 1000) }
    });
  });
  await page.waitForTimeout(600);
  await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').first().click();
  await page.waitForTimeout(1000);
  const latest = await page.locator('#latestHandoverKinko').innerText();
  console.log('normal record imports fine (expect true):', latest.includes('200,000') && !latest.includes('-200,000'));
  console.log('still no confirm dialog anywhere (expect 0):', sink.dialogs.filter(d => d.type === 'confirm').length);

  // ===== 3. 手動の取り込みでも空の金庫を弾かないこと =====
  const sink2 = { errors: [], dialogs: [], decide: d => d.accept() };
  const page2 = await boot(browser, sink2);
  await seedKinko(page2, EMPTY_SAFE);
  await page2.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', store: '清川二丁目', author: 'テスト太郎', text: '・手動取り込み用', answers: [],
      createdAt: { toDate: () => new Date(Date.now() + 5 * 60 * 1000) }
    });
  });
  await page2.waitForTimeout(500);
  await page2.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page2.waitForTimeout(400);
  await page2.locator('#notebookList button:has-text("金庫の結果を取り込む")').first().click();
  await page2.waitForTimeout(1000);
  console.log('manual import needs no confirmation (expect 0):', sink2.dialogs.filter(d => d.type === 'confirm').length);
  console.log('manual import of an empty safe succeeds (expect 0 = button gone):',
    await page2.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());

  console.log('errors:', JSON.stringify(sink.errors.concat(sink2.errors)));
  await browser.close();
})();
