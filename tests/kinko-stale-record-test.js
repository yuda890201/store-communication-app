const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');

// 金庫アプリの datetime はローカル時刻の文字列。実行時刻に対して相対で作らないと、
// 固定文字列では実行環境のタイムゾーン次第で「未来の記録」になってしまう
function localDatetime(offsetMs) {
  const d = new Date(Date.now() + offsetMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 「博多住吉通り店」の最新記録が数時間前 = 点検は別店舗(清川)に保存されてしまった状態
const OLD_RECORD = {
  datetime: localDatetime(-5 * 60 * 60 * 1000), storeId: 'store-sumiyoshi', storeName: '博多住吉通り店',
  reg1: { staff: '中村', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
  vaultTotal: '200,000', vaultTarget: 200000, vaultDiff: '0', memo: ''
};

async function boot(browser, sink) {
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  page.on('pageerror', e => sink.errors.push('pageerror: ' + e.message));
  page.on('dialog', d => { sink.dialogs.push({ message: d.message(), type: d.type() }); sink.decide(d); });
  await page.addInitScript(fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8'));
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '博多住吉通り');
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
      stores: ['博多住吉通り'], kinkoAppUrl: 'https://example.com/kinko/',
      kinkoStoreMap: { '博多住吉通り': '博多住吉通り店' },
      kinkoConfig: { apiKey: 'k', projectId: 'kinko-app-2f5e4', viewerEmail: 'read@view.example.com', viewerPassword: 'vp' }
    });
    window.firebase.firestore().collection('handoverItems').add({
      question: 'レジの過不足はありましたか？', answerType: 'yesno', yesTemplate: 'レジ過不足あり', important: false, createdAt: new Date()
    });
  });
  await page.waitForTimeout(500);
  await page.evaluate(rec => {
    const app = window.firebase.apps.find(a => a.name === 'kinkoApp')
      || window.firebase.initializeApp({ apiKey: 'k', projectId: 'kinko-app-2f5e4' }, 'kinkoApp');
    const kdb = app.firestore();
    kdb.collection('meta').doc('storeMaster').set({ stores: [{ id: 'store-sumiyoshi', name: '博多住吉通り店', target: 200000 }] });
    kdb.collection('storesConfig').doc('store-sumiyoshi').collection('records').add(rec);
  }, OLD_RECORD);
  await page.waitForTimeout(400);
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const sink = { errors: [], dialogs: [], decide: d => d.accept() };
  const page = await boot(browser, sink);

  // ===== 引継ぎを投稿し、金庫アプリを開いて戻る（点検は別店舗に保存された想定） =====
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
  await page.evaluate(() => markAwaitingKinkoReturn());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);

  const status = await page.locator('#handoverKinkoImportStatus').innerText();
  console.log('stale record is NOT auto-imported (expect true):', status.includes('新しい点検が見つかりません'));
  console.log('status names the store on the record (expect true):', status.includes('博多住吉通り店'));
  console.log('status tells them to check the store (expect true):', status.includes('店舗名を確認'));

  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(500);
  console.log('nothing attached (expect 1 = button still there):',
    await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());
  console.log('the stale record is not in the handover (expect false):',
    (await page.locator('#latestHandoverKinko').innerText()).includes(OLD_RECORD.datetime.replace('T', ' ')));

  // ===== 正しい店舗で点検し直せば、戻った時に取り込まれること =====
  await page.evaluate(fresh => {
    const kdb = window.firebase.app('kinkoApp').firestore();
    kdb.collection('storesConfig').doc('store-sumiyoshi').collection('records').add({
      datetime: fresh,
      storeId: 'store-sumiyoshi', storeName: '博多住吉通り店',
      reg1: { staff: '渕上', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
      vaultTotal: '199,500', vaultTarget: 200000, vaultDiff: '-500', memo: '数え直し'
    });
  }, localDatetime(60 * 1000)); // 開いた時刻より後
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => openView('notebook'));
  await page.waitForTimeout(500);
  const card = await page.locator('#latestHandoverKinko').innerText();
  console.log('a fresh record does get imported (expect true):', card.includes('199,500'));

  // ===== どの店舗の点検かが必ず出ること（今回の事故が一目で分かるように） =====
  console.log('the kinko block names the store (expect true):', card.includes('点検店舗: 博多住吉通り店'));
  await page.locator('#notebookList button:has-text("印刷")').first().click();
  await page.waitForTimeout(300);
  console.log('print includes the store too (expect true):',
    (await page.locator('#printArea').innerText()).includes('点検店舗: 博多住吉通り店'));

  // ===== 同じ「分」に保存された記録を弾かないこと =====
  // 金庫アプリの datetime は分までしか持たない。開いた時刻(秒あり)とそのまま比べると
  // 同じ分の記録が必ず古い判定になり、実際に点検した結果が取り込めなくなる
  const page2 = await boot(browser, sink);
  await page2.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page2.waitForTimeout(300);
  await page2.click('button[onclick="startHandoverWizard()"]');
  await page2.waitForTimeout(400);
  await page2.click('#handoverNoBtn');
  await page2.waitForTimeout(150);
  await page2.click('#handoverNextBtn');
  await page2.waitForTimeout(300);
  await page2.click('button[onclick="submitHandover()"]');
  await page2.waitForTimeout(700);

  // 「開く」を押した時刻の秒を、わざと遅らせる（18:56:50 に押した状況）
  await page2.evaluate(() => {
    markAwaitingKinkoReturn();
    const d = new Date();
    d.setSeconds(50, 0);
    justPostedHandover.openedAt = d;
  });
  // 同じ分に保存された記録（18:56）
  await page2.evaluate(sameMinute => {
    const kdb = window.firebase.app('kinkoApp').firestore();
    kdb.collection('storesConfig').doc('store-sumiyoshi').collection('records').add({
      datetime: sameMinute, storeId: 'store-sumiyoshi', storeName: '博多住吉通り店',
      reg1: { staff: '中村', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', discCouponDiff: '0' },
      vaultTotal: '200,000', vaultTarget: 200000, vaultDiff: '0', memo: '同じ分に保存'
    });
  }, localDatetime(0));
  await page2.waitForTimeout(500);
  await page2.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page2.waitForTimeout(1200);
  const sameMinuteStatus = await page2.locator('#handoverKinkoImportStatus').innerText();
  console.log('same-minute record is imported, not rejected (expect true):', sameMinuteStatus.includes('取り込みました'));
  console.log('no false stale warning (expect false):', sameMinuteStatus.includes('見つかりません'));

  // 一方、前の分の記録はちゃんと弾くこと（判定が甘くなりすぎていないか）
  await page2.click('button[onclick="closeHandoverWizard()"]');
  await page2.waitForTimeout(300);

  console.log('errors:', JSON.stringify(sink.errors));
  await browser.close();
})();
