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
    localStorage.setItem('active_store', '渋谷店');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      // 不具合報告アプリ側の閲覧専用アカウント (テスト用ダミー値。別プロジェクト store-trouble-report 想定)
      'viewer@test.example.com': { password: 'test-viewer-pass', user: { uid: 'viewer-uid', isAnonymous: false, email: 'viewer@test.example.com', displayName: null } },
      // オーナー設定を開くための管理者個人アカウント
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['渋谷店', 'みなと店'], adminEmails: ['owner@test.example.com']
    });
  });
  await page.waitForTimeout(300);
  // 店舗が2件以上あると店舗選択モーダルが毎回開く仕様のため、閉じておく
  if (await page.locator('.store-option-btn:has-text("渋谷店")').isVisible()) {
    await page.click('.store-option-btn:has-text("渋谷店")');
    await page.waitForTimeout(150);
  }

  // 未設定の段階では「未設定です」の案内が出ること
  await page.click('.grid-card[onclick="openView(\'troublereports\')"]');
  await page.waitForTimeout(200);
  console.log('shows not-configured message before setup:', (await page.locator('#troubleReportList .empty-state').innerText()).includes('未設定'));
  await page.click('[data-view="troublereports"] .back-btn');
  await page.waitForTimeout(150);

  // オーナー設定から連携情報を貼り付けて保存する操作を再現 (管理者ログインが必要)
  await page.click('.active-view .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(150);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(300);
  console.log('owner drawer opened after admin login (expect true):', await page.evaluate(() => document.getElementById('ownerDrawer').classList.contains('open')));
  await page.click('summary:has-text("🚨 不具合報告アプリ連携設定")');
  await page.waitForTimeout(150);
  await page.fill('#troubleReportConfigInput', JSON.stringify({
    apiKey: 'mock-trouble-api-key', authDomain: 'store-trouble-report.firebaseapp.com',
    projectId: 'store-trouble-report', storageBucket: 'store-trouble-report.firebasestorage.app',
    messagingSenderId: '000', appId: '1:000:web:mock',
    viewerEmail: 'viewer@test.example.com', viewerPassword: 'test-viewer-pass'
  }));
  await page.click('button[onclick="saveTroubleReportConfig()"]');
  await page.waitForTimeout(300);
  console.log('save status (expect 保存しました):', await page.locator('#troubleReportConfigStatus').innerText());
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(300);

  console.log('secondary app registered (expect true):', await page.evaluate(() => !!window.firebase.app('troubleReportApp')));
  console.log('secondary app config projectId (expect store-trouble-report):', await page.evaluate(() => window.firebase.app('troubleReportApp').config.projectId));
  console.log('default app still intact (expect my-store-1234):', await page.evaluate(() => window.firebase.app().config.projectId));

  // 別プロジェクト側に直接データを注入 (report本体は軽量、photoは別コレクション)
  await page.evaluate(() => {
    const tdb = window.firebase.app('troubleReportApp').firestore();
    tdb.collection('trouble_reports').add({
      target_type: '自作・業務アプリ', category: '勤怠・シフト', quick_trouble_preset: '保存できない',
      comment: '保存ボタンを押しても画面が戻りません。', reporter: 'ゆだ', store_name: '渋谷店',
      report_time: '2026-09-13 10:30', status: '未対応', has_photo: true, created_at: new Date()
    }).then(ref => {
      tdb.collection('trouble_report_photos').doc(ref.id).set({
        photo_data: 'data:image/jpeg;base64,ZmFrZS1qcGVnLWRhdGE=', created_at: new Date()
      });
    });
    tdb.collection('trouble_reports').add({
      target_type: '自作・業務アプリ', category: 'レジ', quick_trouble_preset: '起動しない',
      comment: '古い形式の報告（写真が本体に直接入っている想定）', reporter: '田中', store_name: '未登録店舗',
      report_time: '2026-09-12 09:00', status: '完了', has_photo: false,
      photo_data: 'data:image/jpeg;base64,b2xkLWZvcm1hdC1waG90bw==', created_at: new Date()
    });
  });
  await page.waitForTimeout(500);

  // ===== 不具合報告画面を開いて表示確認 =====
  await page.click('.grid-card[onclick="openView(\'troublereports\')"]');
  await page.waitForTimeout(400);

  const cardCount = await page.locator('#troubleReportList .card').count();
  console.log('trouble report cards rendered (expect 2):', cardCount);

  const firstCardText = await page.locator('#troubleReportList .card').first().innerText();
  console.log('first card contains category/preset:', firstCardText.includes('勤怠・シフト') && firstCardText.includes('保存できない'));
  console.log('first card shows matched store (渋谷店, registered):', firstCardText.includes('渋谷店') && !firstCardText.includes('一致なし'));
  console.log('first card status badge (未対応):', firstCardText.includes('未対応'));

  const secondCardText = await page.locator('#troubleReportList .card').nth(1).innerText();
  console.log('second card shows unmatched store label:', secondCardText.includes('未登録店舗') && secondCardText.includes('一致なし'));
  console.log('second card status (完了):', secondCardText.includes('完了'));

  // 未解決件数バッジ (未対応1件 + 完了1件 => 未解決1件)
  await page.click('[data-view="troublereports"] .back-btn');
  await page.waitForTimeout(200);
  console.log('home badge unresolved count (expect 1):', await page.locator('#badge-troublereports').innerText());

  // ===== 写真の遅延読み込み (別コレクションから) =====
  await page.click('.grid-card[onclick="openView(\'troublereports\')"]');
  await page.waitForTimeout(200);
  await page.locator('#troubleReportList .card').first().locator('button:has-text("写真を見る")').click();
  await page.waitForTimeout(300);
  const imgSrc1 = await page.locator('#troubleReportList .card').first().locator('img').getAttribute('src');
  console.log('lazy-loaded photo from separate collection (expect base64 jpeg):', (imgSrc1 || '').startsWith('data:image/jpeg;base64,'));

  // 旧形式 (photo_data が本体に直接入っている) も表示できること
  await page.locator('#troubleReportList .card').nth(1).locator('button:has-text("写真を見る")').click();
  await page.waitForTimeout(200);
  const imgSrc2 = await page.locator('#troubleReportList .card').nth(1).locator('img').getAttribute('src');
  console.log('legacy inline photo_data displayed (expect true):', imgSrc2 === 'data:image/jpeg;base64,b2xkLWZvcm1hdC1waG90bw==');

  // ===== ステータス変更がリアルタイムで反映されること =====
  await page.evaluate(async () => {
    const tdb = window.firebase.app('troubleReportApp').firestore();
    const snap = await new Promise(resolve => {
      tdb.collection('trouble_reports').onSnapshot(s => { resolve(s); });
    });
    const target = snap.docs.find(d => d.data().reporter === 'ゆだ');
    await tdb.collection('trouble_reports').doc(target.id).update({ status: '対応中' });
  });
  await page.waitForTimeout(400);
  const firstCardAfterUpdate = await page.locator('#troubleReportList .card').first().innerText();
  console.log('status updated live to 対応中:', firstCardAfterUpdate.includes('対応中'));

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
