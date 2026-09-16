const { chromium } = require('playwright');
const PORT = process.env.PORT || 8175;
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
  const errors = [];
  const dialogs = [];
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

  const mockScript = fs.readFileSync(path.join(__dirname, 'firebase-mock.js'), 'utf8');
  await page.addInitScript(mockScript);
  await page.addInitScript(() => {
    localStorage.setItem('firebase_config', JSON.stringify({ apiKey: 'mock', projectId: 'my-store-1234' }));
    localStorage.setItem('my_name', 'テスト太郎');
    localStorage.setItem('active_store', '清川二丁目');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      'owner@example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@example.com', displayName: null } },
      // 金庫アプリ側の閲覧専用アカウント（テスト用のダミー）
      'read@view.example.com': { password: 'kinko-viewer-pass', user: { uid: 'kinko-viewer', isAnonymous: false, email: 'read@view.example.com', displayName: null } }
    };
    window.__printed = 0;
    window.print = () => { window.__printed++; };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['清川二丁目'], adminEmails: ['owner@example.com']
    });
  });
  await page.waitForTimeout(400);

  // オーナーとして連携設定を保存する
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(200);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(200);
  await page.fill('#ownerLoginEmail', 'owner@example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  // この<details>は既定で開いているため、クリックすると逆に閉じてしまう
  await page.evaluate(() => {
    document.getElementById('kinkoConfigInput').closest('details').open = true;
  });
  await page.waitForTimeout(200);
  await page.fill('#kinkoConfigInput', JSON.stringify({
    apiKey: 'mock-kinko-key', projectId: 'kinko-app-2f5e4',
    viewerEmail: 'read@view.example.com', viewerPassword: 'kinko-viewer-pass'
  }));
  await page.click('button[onclick="saveKinkoConfig()"]');
  await page.waitForTimeout(300);
  console.log('config saved (expect 保存しました):', await page.locator('#kinkoConfigStatus').innerText());

  // 両アプリで店舗名の付け方が違う（こちら「清川二丁目」／金庫「福岡清川二丁目店」）
  await page.fill('#kinkoStoreMapInput', '清川二丁目 = 福岡清川二丁目店');
  await page.click('button[onclick="saveKinkoStoreMap()"]');
  await page.waitForTimeout(300);
  console.log('store map saved (expect 1件):', await page.locator('#kinkoStoreMapStatus').innerText());
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(300);

  // 金庫アプリ側（別プロジェクト）にマスタと記録を用意する
  await page.evaluate(() => {
    // アプリ側は取り込み時に初めて接続するので、テストでは先に同じ名前で用意しておく
    const app = window.firebase.apps.find(a => a.name === 'kinkoApp')
      || window.firebase.initializeApp({ apiKey: 'mock-kinko-key', projectId: 'kinko-app-2f5e4' }, 'kinkoApp');
    const kdb = app.firestore();
    // 金庫アプリ側の実際の登録名・実際の値の形式に合わせている
    // (vaultTotalはtoLocaleString、vaultDiffは正のときだけ+付き、いずれも円記号なし)
    kdb.collection('meta').doc('storeMaster').set({
      stores: [
        { id: 'store-1', name: '1号店', target: 200000 },
        { id: 'store-kiyokawa', name: '福岡清川二丁目店', target: 200000 },
        { id: 'store-sumiyoshi', name: '博多住吉通り店', target: 200000 }
      ]
    });
    const recs = kdb.collection('storesConfig').doc('store-kiyokawa').collection('records');
    recs.add({
      datetime: '2026-09-15T09:00', storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
      reg1: { staff: '前任者', cashDiff: '0', freeCouponDiff: '0', discCouponDiff: '0' },
      reg2: { staff: '前任者2', cashDiff: '0', freeCouponDiff: '0', discCouponDiff: '0' },
      vaultTotal: '200,000', vaultTarget: 200000, vaultDiff: '0', memo: ''
    });
    recs.add({
      datetime: '2026-09-16T10:30', storeId: 'store-kiyokawa', storeName: '福岡清川二丁目店',
      // 累計-300のうち今回分が-100。担当者の責任範囲はDelta側
      reg1: { staff: '佐藤', cashDiff: '-300', cashDiffDelta: -100, freeCouponDiff: '1', freeCouponDiffDelta: 1, discCouponDiff: '0', discCouponDiffDelta: 0 },
      reg2: { staff: '鈴木', cashDiff: '0', cashDiffDelta: 0, freeCouponDiff: '0', freeCouponDiffDelta: 0, discCouponDiff: '2', discCouponDiffDelta: 2 },
      vaultTotal: '199,900', vaultTarget: 200000, vaultDiff: '-100', memo: 'レジ2番で釣銭違い'
    });
  });
  await page.waitForTimeout(400);

  // 引継ぎ書を1件用意する
  await page.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', store: '清川二丁目', author: 'テスト太郎',
      text: '・レジ過不足あり', answers: [],
      createdAt: { toDate: () => new Date('2026-09-16T10:35:00+09:00') }
    });
  });
  await page.waitForTimeout(500);

  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(400);

  // ===== 取り込み前 =====
  console.log('import button shown before attaching (expect true):', await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').count() > 0);
  console.log('kinko block absent before attaching (expect 0):', await page.locator('#notebookList .kinko-block').count());

  // ===== 取り込み =====
  await page.click('#notebookList button:has-text("金庫の結果を取り込む")');
  await page.waitForTimeout(900);
  console.log('kinko block shown after attaching (expect 1):', await page.locator('#notebookList .kinko-block').count());
  const kinkoText = await page.locator('#notebookList .kinko-block-body').innerText();
  console.log('shows the latest record, not the older one (expect true):', kinkoText.includes('2026-09-16 10:30') && !kinkoText.includes('2026-09-15'));
  console.log('shows both register staff (expect true):', kinkoText.includes('佐藤') && kinkoText.includes('鈴木'));
  console.log('shows vault figures (expect true):', kinkoText.includes('199,900') && kinkoText.includes('200,000'));
  // 累計と今回分が違うときだけ併記し、同じときは重複させない
  console.log('cumulative and this-shift shown together (expect true):', kinkoText.includes('-300（今回分 -100）'));
  console.log('no redundant delta when equal (expect false):', kinkoText.includes('0（今回分 0）'));
  console.log('shows memo (expect true):', kinkoText.includes('レジ2番で釣銭違い'));
  console.log('import button hidden after attaching (expect 0):', await page.locator('#notebookList button:has-text("金庫の結果を取り込む")').count());
  // 一番見られる「最新の引継ぎ」にも出ること
  console.log('latest handover card shows kinko too (expect true):', await page.locator('#latestHandoverKinko').isVisible());
  console.log('latest card has the vault figure (expect true):', (await page.locator('#latestHandoverKinko').innerText()).includes('199,900'));

  // ===== 印刷に金庫欄が入ること =====
  await page.click('#notebookList button:has-text("印刷")');
  await page.waitForTimeout(300);
  const printArea = await page.locator('#printArea').innerText();
  console.log('print called (expect 1):', await page.evaluate(() => window.__printed));
  console.log('print includes handover text (expect true):', printArea.includes('レジ過不足あり'));
  console.log('print includes kinko section (expect true):', printArea.includes('金庫・レジ現金点検') && printArea.includes('199,900'));

  // ===== 店舗名が一致しない場合はエラーを出して黙って失敗しないこと =====
  await page.evaluate(() => {
    window.firebase.firestore().collection('notebookEntries').add({
      type: 'handover', store: '存在しない店', author: 'テスト太郎', text: '・別店舗の引継ぎ', answers: [],
      createdAt: { toDate: () => new Date('2026-09-16T11:00:00+09:00') }
    });
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['清川二丁目', '存在しない店'] }, { merge: true });
  });
  await page.waitForTimeout(500);
  if (await page.locator('.store-option-btn:has-text("清川二丁目")').isVisible()) {
    await page.click('.store-option-btn:has-text("清川二丁目")');
    await page.waitForTimeout(200);
  }
  await page.click('.grid-card[onclick="openView(\'notebook\')"]').catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.getElementById('showAllStoresCheckbox').checked = true; saveShowAllStores(); });
  await page.waitForTimeout(400);
  const btns = page.locator('#notebookList button:has-text("金庫の結果を取り込む")');
  if (await btns.count() > 0) {
    await btns.first().click();
    await page.waitForTimeout(900);
  }
  console.log('unmatched store surfaces an error (expect true):', dialogs.some(m => m.includes('店舗が見つかりません')));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
