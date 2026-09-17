// シフト管理アプリ連携（ヘルプ募集のヘッダー表示）の確認。
// 日時は必ず Date.now() からの相対で作る。固定文字列で書くと、実行した日によって
// 「未来の募集」が「過去の募集」に変わり、いつか黙って落ちる（過去に3回踏んだ）
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;

const pad = n => String(n).padStart(2, '0');
const dayOffset = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const YESTERDAY = dayOffset(-1);
const TODAY = dayOffset(0);
const IN_3_DAYS = dayOffset(3);
const IN_5_DAYS = dayOffset(5);

const SHIFT_CONFIG = {
  apiKey: 'mock-shift-api-key',
  authDomain: 'shift-management-app-c6df2.firebaseapp.com',
  projectId: 'shift-management-app-c6df2',
  appId: '1:000:web:mockshift',
  viewerEmail: 'viewer@shift.example.com',
  viewerPassword: 'shift-viewer-pass'
};

async function bootStaffSession(browser, { shiftConfig }) {
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
    localStorage.setItem('active_store', '博多住吉通り');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } },
      // シフト管理アプリ側の閲覧専用アカウント（テスト用のダミー値）
      'viewer@shift.example.com': { password: 'shift-viewer-pass', user: { uid: 'shift-viewer-uid', isAnonymous: false, email: 'viewer@shift.example.com', displayName: null } },
      'owner@test.example.com': { password: 'owner-pass1', user: { uid: 'owner-uid', isAnonymous: false, email: 'owner@test.example.com', displayName: null } }
    };
    // 応募は新しいタブでシフト管理アプリを開く。テストでは開いたURLを控えるだけにする
    window.__opened = [];
    window.open = url => { window.__opened.push(url); return null; };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({
      stores: ['博多住吉通り', '清川二丁目'], adminEmails: ['owner@test.example.com']
    }, { merge: true });
  });
  await page.waitForTimeout(250);
  if (await page.locator('.store-option-btn:has-text("博多住吉通り")').isVisible()) {
    await page.click('.store-option-btn:has-text("博多住吉通り")');
    await page.waitForTimeout(150);
  }
  if (shiftConfig) {
    await page.evaluate(cfg => {
      window.firebase.firestore().collection('appSettings').doc('general').set({
        shiftConfig: cfg, shiftAppUrl: 'https://shift.example.com/'
      }, { merge: true });
    }, shiftConfig);
    await page.waitForTimeout(400);
  }
  return { page, errors, dialogs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // ---------- 連携が未設定のとき ----------
  const plain = await bootStaffSession(browser, { shiftConfig: null });
  console.log('未設定ならバナーを出さない (expect false):',
    await plain.page.locator('#helpBanner').isVisible());
  await plain.page.close();

  // ---------- 連携あり ----------
  const { page, errors, dialogs } = await bootStaffSession(browser, { shiftConfig: SHIFT_CONFIG });

  console.log('募集が0件のうちはバナーを出さない (expect false):',
    await page.locator('#helpBanner').isVisible());

  // 先方の helpPostingsPublic を模して募集を投入する
  await page.evaluate(rows => {
    const sdb = window.firebase.app('shiftApp').firestore();
    rows.forEach(r => sdb.collection('helpPostingsPublic').doc(r.id).set(r.data));
  }, [
    { id: 'fm71661__' + IN_3_DAYS + '_3', data: { storeId: 'fm71661', dateStr: IN_3_DAYS, slotName: '夕勤', startTime: '14:00', endTime: '22:00', isUrgent: false, status: 'open' } },
    { id: 'fm82043__' + IN_5_DAYS + '_1', data: { storeId: 'fm82043', dateStr: IN_5_DAYS, slotName: '朝勤', startTime: '09:00', endTime: '17:00', isUrgent: false, status: 'open' } },
    { id: 'fm71661__' + TODAY + '_2', data: { storeId: 'fm71661', dateStr: TODAY, slotName: '昼勤', startTime: '10:00', endTime: '18:00', isUrgent: true, status: 'pending' } },
    // 日付が過ぎた募集。先方が消していなくてもこちらで出さない
    { id: 'fm71661__' + YESTERDAY + '_1', data: { storeId: 'fm71661', dateStr: YESTERDAY, slotName: '夕勤', startTime: '14:00', endTime: '22:00', isUrgent: false, status: 'open' } },
    // 確定したもの。消すのではなく filled を経由してもらう取り決め
    { id: 'fm82043__' + IN_3_DAYS + '_4', data: { storeId: 'fm82043', dateStr: IN_3_DAYS, slotName: '夜勤', startTime: '17:00', endTime: '24:00', isUrgent: false, status: 'filled', filledAt: new Date().toISOString() } }
  ]);
  await page.waitForTimeout(350);

  const bannerText = () => page.locator('#helpBanner').innerText();
  console.log('募集があればバナーを出す (expect true):', await page.locator('#helpBanner').isVisible());
  console.log('募集中の件数は過去日を除いた3件 (expect "🆘 ヘルプ募集 3件"を含む):',
    (await bannerText()).replace(/\n/g, ' '));
  console.log('スタッフには承認待ちを出さない (expect false):', (await bannerText()).includes('承認待ち'));
  console.log('埋まった件数はスタッフにも出す (expect true):', (await bannerText()).includes('✅'));

  await page.click('#helpBanner');
  await page.waitForTimeout(200);
  console.log('タップで一覧が開く (expect true):',
    await page.locator('#helpListOverlay').evaluate(el => el.classList.contains('open')));
  const rowCount = await page.locator('.help-row').count();
  console.log('一覧の行数は過去日を除いた4件 (expect 4):', rowCount);
  const listText = (await page.locator('#helpListBody').innerText()).replace(/\n/g, ' | ');
  console.log('一覧の中身:', listText);
  console.log('過去日の募集は出さない (expect false):', listText.includes(YESTERDAY.slice(5).replace(/^0/, '').replace('-0', '/').replace('-', '/')));
  console.log('対応付け前は識別子がそのまま出る (expect true):', listText.includes('fm71661'));
  console.log('時間帯を出す (expect true):', listText.includes('14:00-22:00'));
  console.log('急募を出す (expect true):', listText.includes('急募'));

  // 応募はシフト管理アプリ側で完結させる。こちらは該当の募集を開くだけ
  await page.click('.help-row:not(.filled) >> nth=0');
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => window.__opened);
  console.log('募集をタップすると #help= 付きで開く (expect true):',
    opened.length === 1 && opened[0].startsWith('https://shift.example.com/#help='));
  console.log('開いたURL:', opened[0]);

  await page.click('.help-row.filled >> nth=0');
  await page.waitForTimeout(150);
  console.log('埋まった募集は開かず知らせる (expect true):',
    dialogs.some(m => m.includes('埋まりました')) && (await page.evaluate(() => window.__opened.length)) === 1);

  await page.click('#helpListOverlay .btn-clear');
  await page.waitForTimeout(150);

  // ---------- 責任者だけに承認待ちを出す ----------
  await page.click('.active-view .settings-btn:has-text("⚙️")');
  await page.waitForTimeout(150);
  await page.click('button[onclick="openOwnerDrawer()"]');
  await page.waitForTimeout(150);
  await page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await page.fill('#ownerLoginPassword', 'owner-pass1');
  await page.click('button[onclick="doOwnerLogin()"]');
  await page.waitForTimeout(400);
  console.log('責任者には承認待ちを出す (expect true):', (await bannerText()).includes('承認待ち'));

  // ---------- 店舗の対応付け ----------
  await page.click('summary:has-text("🆘 シフト管理アプリ連携設定")');
  await page.waitForTimeout(150);
  console.log('名前の無い識別子を知らせる (expect fm71661とfm82043を含む):',
    await page.locator('#shiftUnknownStores').innerText());
  await page.fill('#shiftStoreMapInput', 'fm71661 = 博多住吉通り\nfm82043 = 清川二丁目');
  await page.click('button[onclick="saveShiftStoreMap()"]');
  await page.waitForTimeout(400);
  console.log('対応付けの保存 (expect "✅ 2件"):', await page.locator('#shiftStoreMapStatus').innerText());
  console.log('保存後は名前が付く (expect すべて名前が付いている):',
    await page.locator('#shiftUnknownStores').innerText());

  await page.click('#ownerDrawerCloseBtn').catch(() => {});
  await page.waitForTimeout(150);
  await page.evaluate(() => { closeOwnerDrawer && closeOwnerDrawer(); closeSideDrawer && closeSideDrawer(); });
  await page.waitForTimeout(150);
  await page.click('#helpBanner');
  await page.waitForTimeout(250);
  const mapped = (await page.locator('#helpListBody').innerText()).replace(/\n/g, ' | ');
  console.log('対応付け後は店舗名で出る (expect true):',
    mapped.includes('博多住吉通り') && mapped.includes('清川二丁目') && !mapped.includes('fm71661'));
  console.log('自店には印を付ける (expect true):', mapped.includes('自店'));

  // ---------- 書き込みは一切しない ----------
  const shiftWrites = await page.evaluate(() => (window.__firestoreWrites || []).filter(w => w.app === 'shiftApp'));
  const seeded = 5; // テスト自身が投入した5件
  console.log('シフト管理アプリへの書き込みはテストの投入分だけ (expect 5):', shiftWrites.length, '→', shiftWrites.length === seeded);

  // ---------- 募集が全部埋まったとき ----------
  await page.evaluate(() => { closeHelpList(); });
  await page.evaluate(ids => {
    const sdb = window.firebase.app('shiftApp').firestore();
    ids.forEach(id => sdb.collection('helpPostingsPublic').doc(id).update({ status: 'filled', filledAt: new Date().toISOString() }));
  }, ['fm71661__' + IN_3_DAYS + '_3', 'fm82043__' + IN_5_DAYS + '_1', 'fm71661__' + TODAY + '_2']);
  await page.waitForTimeout(300);
  const doneText = (await bannerText()).replace(/\n/g, ' ');
  console.log('全部埋まったら「0件」ではなく埋まった旨を出す (expect 埋まりました / 0件を含まない):',
    doneText, '→', doneText.includes('埋まりました') && !doneText.includes('0件'));

  console.log('ページエラー (expect []):', JSON.stringify(errors));
  await page.close();

  // ---------- 接続に失敗したとき ----------
  const broken = await bootStaffSession(browser, {
    shiftConfig: { ...SHIFT_CONFIG, viewerPassword: 'wrong-password' }
  });
  await broken.page.waitForTimeout(400);
  console.log('接続に失敗したらバナーを出さない（0件と言わない） (expect false):',
    await broken.page.locator('#helpBanner').isVisible());
  console.log('失敗を握りつぶして「募集ゼロ」にしない (expect true):',
    await broken.page.evaluate(() => helpPostings === null && helpPostingsError !== ''));
  await broken.page.close();

  await browser.close();
})();
