const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');
// 日時は実行時刻からの相対で作る。固定文字列だと、実行した時間帯やタイムゾーン次第で
// 「開いた時刻より古い記録」と判定されて取り込みが止まる（tests/README.md 参照）
function localDatetime(offsetMs) {
  const d = new Date(Date.now() + offsetMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => d.accept());

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '清川二丁目');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      'read@view.example.com': { password: 'kinko-viewer-pass', user: { uid: 'kinko-viewer', isAnonymous: false, email: 'read@view.example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);

  // 連携設定・対応付け・金庫アプリURLをまとめて入れる（オーナー画面の操作は別テストで見ている）
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['清川二丁目'],
      kinkoAppUrl: 'https://example.com/kinko/',
      kinkoStoreMap: { '清川二丁目': '福岡清川二丁目店' },
      kinkoConfig: {
        apiKey: 'mock-kinko-key', projectId: 'kinko-app-2f5e4',
        viewerEmail: 'read@view.example.com', viewerPassword: 'kinko-viewer-pass'
      }
    });
    window.firebase.firestore().collection('handoverItems').add({
      question: 'レジの過不足はありましたか？', answerType: 'yesno',
      yesTemplate: 'レジ過不足あり', important: false, createdAt: new Date()
    });
  });
  await page.waitForTimeout(500);

  // 金庫アプリ側に最新記録を用意する
  await page.evaluate(fresh => {
    const app = window.firebase.apps.find(a => a.name === 'kinkoApp')
      || window.firebase.initializeApp({ apiKey: 'mock-kinko-key', projectId: 'kinko-app-2f5e4' }, 'kinkoApp');
    const kdb = app.firestore();
    kdb.collection('meta').doc('storeMaster').set({
      stores: [{ id: 'store-kiyokawa', name: '福岡清川二丁目店', target: 200000 }]
    });
    kdb.collection('storesConfig').doc('store-kiyokawa').collection('records').add({
      datetime: fresh, storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
      reg1: { staff: '佐藤', cashDiff: '-200', cashDiffDelta: -200, freeCouponDiff: '0', discCouponDiff: '0' },
      vaultTotal: '199,800', vaultTarget: 200000, vaultDiff: '-200', memo: '自動取り込みの確認用'
    });
  }, localDatetime(5 * 60 * 1000)); // 「開く」を押す時刻より後
  await page.waitForTimeout(400);

  // ===== 引継ぎを1件投稿する =====
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
  console.log('done card shown (expect true):', await page.locator('#handoverDoneCard').isVisible());
  console.log('no import status before opening safe app (expect ""):', JSON.stringify(await page.locator('#handoverKinkoImportStatus').innerText()));

  // ===== 金庫アプリを開いて戻ってくる =====
  // target=_blank の遷移はテストでは起こさず、押した事実だけを再現する
  await page.evaluate(() => markAwaitingKinkoReturn());
  await page.waitForTimeout(100);
  // タブを離れて戻る＝visibilitychange。ここで自動取り込みが走る
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
  const status = await page.locator('#handoverKinkoImportStatus').innerText();
  console.log('auto-imported on return (expect true):', status.includes('取り込みました'));

  await page.click('button[onclick="closeHandoverWizard()"]');
  await page.waitForTimeout(500);
  // ボタンを一度も押していないのに、引継ぎ書に金庫欄が入っていること
  console.log('kinko block present without pressing the button (expect 1):', await page.locator('#latestHandoverKinko .kinko-block-body').count());
  console.log('shows the vault figure (expect true):', (await page.locator('#latestHandoverKinko').innerText()).includes('199,800'));
  console.log('import button gone from the list (expect 0):', await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());
  console.log('no warning styling once imported (expect false):', await page.evaluate(() =>
    document.getElementById('latestHandoverKinko').classList.contains('kinko-block-missing')));

  // ===== 取り込み前の引継ぎは警告として見えること =====
  await page.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', store: '清川二丁目', author: 'テスト太郎', text: '・取り込んでいない引継ぎ', answers: [],
      createdAt: { toDate: () => new Date(Date.now() + 5 * 60 * 1000) }
    });
  });
  await page.waitForTimeout(600);
  console.log('warning shown for un-imported handover (expect true):', await page.evaluate(() =>
    document.getElementById('latestHandoverKinko').classList.contains('kinko-block-missing')));
  console.log('warning text (expect 未取り込み):', (await page.locator('#latestHandoverKinko').innerText()).includes('未取り込み'));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
