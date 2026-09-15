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
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  // ===== 2店舗を登録し、渋谷店をアクティブに =====
  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['渋谷店', '新宿店'] });
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { chooseStore('渋谷店'); });
  await page.waitForTimeout(200);

  // ===== 引継ぎ項目をシード =====
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(150);
  await page.click('button[onclick="seedDefaultHandoverItems()"]');
  await page.waitForTimeout(400);

  // ===== 店舗別ダッシュボード: 初期状態 (両店舗とも未作成) =====
  await page.waitForTimeout(200);
  const dashboardInitial = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#handoverDashboardList .task-row-label')).map(el => el.textContent));
  console.log('dashboard initial (expect both 本日未作成):', dashboardInitial);

  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // ===== 引継ぎウィザードを実行 (レジ過不足=重要項目を「あり」で回答) =====
  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(150);
  await page.click('button[onclick="startHandoverWizard()"]');
  await page.waitForTimeout(200);

  for (let i = 0; i < 10; i++) {
    const isCount = await page.locator('#handoverCountRow').isVisible();
    const qText = await page.locator('#handoverQuestionText').innerText();
    if (isCount) {
      await page.fill('#handoverCountInput', '2');
    } else if (qText.includes('レジの過不足')) {
      await page.click('#handoverYesBtn');
      await page.fill('#handoverDetailInput', '1000円不足');
    } else {
      await page.click('#handoverNoBtn');
    }
    await page.click('#handoverNextBtn');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(200);

  // ===== 印刷ボタン (プレビュー) =====
  page.once('dialog', d => d.dismiss().catch(() => {}));
  await page.evaluate(() => { window.print = () => { __pw_printedPreview = true; }; });
  await page.click('button[onclick="printHandoverPreview()"]');
  console.log('printHandoverPreview called ok:', await page.evaluate(() => __pw_printedPreview === true));

  await page.click('button[onclick="submitHandover()"]');
  await page.waitForTimeout(400);

  // ===== 掲示板への重要項目自動投稿を確認 =====
  const bulletinTitles = await page.evaluate(() => bulletinPosts.map(p => p.title));
  console.log('bulletin posts after submit (expect ⚠️ 重要な引継ぎ事項):', bulletinTitles);
  const importantPost = await page.evaluate(() => {
    const p = bulletinPosts.find(x => x.title === '⚠️ 重要な引継ぎ事項');
    return p ? { body: p.body, requiresAck: p.requiresAck, storeTags: p.storeTags } : null;
  });
  console.log('important bulletin post:', JSON.stringify(importantPost));

  // ===== 最新引継ぎの印刷ボタンが表示される =====
  console.log('latest handover print button visible:', await page.locator('#latestHandoverPrintBtn').isVisible());
  await page.evaluate(() => { __pw_printedLatest = false; window.print = () => { __pw_printedLatest = true; }; });
  await page.click('#latestHandoverPrintBtn');
  console.log('printLatestHandover called ok:', await page.evaluate(() => __pw_printedLatest === true));

  // ===== 履歴フィルタ: 引継ぎのみ + 日付 =====
  await page.click('#notebookFilterHandoverOnly');
  await page.waitForTimeout(150);
  const handoverOnlyCount = await page.locator('#notebookList .card').count();
  console.log('history count with handover-only filter (expect 1):', handoverOnlyCount);

  const todayStr = new Date().toISOString().slice(0, 10);
  await page.fill('#notebookFilterDate', todayStr);
  await page.waitForTimeout(150);
  const dateFilterCount = await page.locator('#notebookList .card').count();
  console.log('history count with today date filter (expect 1):', dateFilterCount);

  await page.click('button[onclick="clearNotebookFilters()"]');
  await page.waitForTimeout(150);
  console.log('filters cleared, handoverOnly checked:', await page.locator('#notebookFilterHandoverOnly').isChecked());

  // ===== 引継ぎ確認サイン =====
  await page.click('#latestHandoverConfirmBtn');
  await page.waitForTimeout(200);
  const canvas = page.locator('#sigCanvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60);
  await page.mouse.up();
  await page.click('button[onclick="confirmSignature()"]');
  await page.waitForTimeout(300);
  console.log('confirm button hidden after signing:', !(await page.locator('#latestHandoverConfirmBtn').isVisible()));

  // ===== ダッシュボードで渋谷店が「本日作成済み・確認済み」になっているか =====
  await page.click('.back-btn');
  await page.waitForTimeout(150);
  await page.click('.home-topbar .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(300);
  const dashboardAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#handoverDashboardList .task-row-label')).map(el => el.textContent));
  console.log('dashboard after handover+confirm (expect 渋谷店: 本日作成済み・確認済み / 新宿店: 本日未作成):', dashboardAfter);
  await page.click('#ownerDrawer .side-drawer-close-btn');
  await page.click('#sideDrawer .side-drawer-close-btn');
  await page.waitForTimeout(150);

  // ===== 未確認リマインドの自動投稿 (作成から2時間超・未確認をシミュレート) =====
  await page.evaluate(async () => {
    const db = window.firebase.firestore();
    const handover = notebookEntries.find(e => e.type === 'handover' && e.store === '渋谷店');
    // 確認済みレコードを一旦削除し、作成時刻を3時間前に書き換えて未確認リマインド条件を満たす
    const toDelete = handoverConfirmations.filter(c => c.entryId === handover.id);
    for (const c of toDelete) {
      await db.collection('handoverConfirmations').doc(c.id).delete();
    }
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.collection('notebookEntries').doc(handover.id).update({
      createdAt: { toDate: () => threeHoursAgo }
    });
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => checkAndPostHandoverReminders());
  await page.waitForTimeout(300);
  const reminderNotes = await page.evaluate(() => notebookEntries.filter(e => e.author === '🔔 自動リマインド').map(e => e.text));
  console.log('auto reminder notes posted (expect 1, mentioning 2時間以上):', reminderNotes);
  const reminderChats = await page.evaluate(() => chatMessages.filter(m => m.sender === '🔔 自動リマインド').length);
  console.log('auto reminder chat messages posted (expect 1):', reminderChats);

  // 二重投稿されないことの確認
  await page.evaluate(() => checkAndPostHandoverReminders());
  await page.waitForTimeout(300);
  const reminderNotesAfterSecondRun = await page.evaluate(() => notebookEntries.filter(e => e.author === '🔔 自動リマインド').length);
  console.log('reminder notes after second run (expect still 1, no duplicate):', reminderNotesAfterSecondRun);

  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
