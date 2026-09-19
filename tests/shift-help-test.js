// シフト管理アプリ連携（ヘルプ募集のヘッダー表示）の確認。
// 日時は必ず Date.now() からの相対で作る。固定文字列で書くと、実行した日によって
// 「未来の募集」が「過去の募集」に変わり、いつか黙って落ちる（過去に3回踏んだ）
const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
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

// シフト管理アプリ側の店舗識別子は店舗ごとに固定のUUID（PINとは無関係）
const STORE_A = '3f2a9c1e-0000-4000-8000-000000000001';
const STORE_B = '7b41d0aa-0000-4000-8000-000000000002';
// オーナーが表示名を設定するまで先方が入れてくる文字列
const LABEL_UNSET = '(表示名未設定)';
// 先方の店舗名がこちらの店舗名と食い違う実例。
// 先方「福岡清川二丁目店」／こちら「清川二丁目」で、文字列が違うため自店と見なせない
const LABEL_A_DIFFERENT = '福岡博多住吉通り店';
const LABEL_B_DIFFERENT = '福岡清川二丁目店';

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
  check('未設定ならバナーを出さない', false, await plain.page.locator('#helpBanner').isVisible());
  await plain.page.close();

  // ---------- 連携あり ----------
  const { page, errors, dialogs } = await bootStaffSession(browser, { shiftConfig: SHIFT_CONFIG });

  check('募集が0件のうちはバナーを出さない', false, await page.locator('#helpBanner').isVisible());

  // 先方の helpPostingsPublic を模して募集を投入する
  await page.evaluate(rows => {
    const sdb = window.firebase.app('shiftApp').firestore();
    rows.forEach(r => sdb.collection('helpPostingsPublic').doc(r.id).set(r.data));
  }, [
    { id: 'auto-a1', data: { storeKey: STORE_A, storeLabel: LABEL_UNSET, dateStr: IN_3_DAYS, slotName: '夕勤', startTime: '14:00', endTime: '22:00', isUrgent: false, status: 'open' } },
    { id: 'auto-b1', data: { storeKey: STORE_B, storeLabel: LABEL_UNSET, dateStr: IN_5_DAYS, slotName: '朝勤', startTime: '09:00', endTime: '17:00', isUrgent: false, status: 'open' } },
    { id: 'auto-a2', data: { storeKey: STORE_A, storeLabel: LABEL_UNSET, dateStr: TODAY, slotName: '昼勤', startTime: '10:00', endTime: '18:00', isUrgent: true, status: 'pending' } },
    // 日付が過ぎた募集。先方は過去日を消さないため、こちらで出さない
    { id: 'auto-a3', data: { storeKey: STORE_A, storeLabel: LABEL_UNSET, dateStr: YESTERDAY, slotName: '夕勤', startTime: '14:00', endTime: '22:00', isUrgent: false, status: 'open' } },
    // 確定したもの。消すのではなく filled を経由してもらう取り決め
    { id: 'auto-b2', data: { storeKey: STORE_B, storeLabel: LABEL_UNSET, dateStr: IN_3_DAYS, slotName: '夜勤', startTime: '17:00', endTime: '24:00', isUrgent: false, status: 'filled', filledAt: new Date().toISOString() } }
  ]);
  await page.waitForTimeout(350);

  const bannerText = () => page.locator('#helpBanner').innerText();
  check('募集があればバナーを出す', true, await page.locator('#helpBanner').isVisible());
  checkIncludes('募集中の件数は過去日を除いた3件', (await bannerText()).replace(/\n/g, ' '), 'ヘルプ募集 3件');
  check('スタッフには承認待ちを出さない', false, (await bannerText()).includes('承認待ち'));
  check('埋まった件数はスタッフにも出す', true, (await bannerText()).includes('✅'));

  await page.click('#helpBanner');
  await page.waitForTimeout(200);
  check('タップで一覧が開く', true, await page.locator('#helpListOverlay').evaluate(el => el.classList.contains('open')));
  const rowCount = await page.locator('.help-row').count();
  check('一覧の行数は過去日を除いた4件', 4, rowCount);
  const listText = (await page.locator('#helpListBody').innerText()).replace(/\n/g, ' | ');
  info('一覧の中身', listText);
  check('過去日の募集は出さない', false, listText.includes(YESTERDAY.slice(5).replace(/^0/, '').replace('-0', '/').replace('-', '/')));
  // 先方の「(表示名未設定)」を店舗名として出してはいけない。
  // UUIDをそのまま出すのも意味が無いので、未設定であることが分かる形にする
  check('(表示名未設定) を店舗名として出さない', false, listText.includes('表示名未設定'));
  check('店舗ごとのUUIDをスタッフに見せない', false, listText.includes(STORE_A));
  check('店舗名が未設定であることが分かる', true, listText.includes('店舗名未設定'));
  check('時間帯を出す', true, listText.includes('14:00-22:00'));
  check('急募を出す', true, listText.includes('急募'));

  // 応募はシフト管理アプリ側で完結させる。こちらは該当の募集を開くだけ
  await page.click('.help-row:not(.filled) >> nth=0');
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => window.__opened);
  check('募集をタップすると #help= 付きで開く', true, opened.length === 1 && opened[0].startsWith('https://shift.example.com/#help='));
  info('開いたURL', opened[0]);

  await page.click('.help-row.filled >> nth=0');
  await page.waitForTimeout(150);
  check('埋まった募集は開かず知らせる', true, dialogs.some(m => m.includes('埋まりました')) && (await page.evaluate(() => window.__opened.length)) === 1);

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
  check('責任者には承認待ちを出す', true, (await bannerText()).includes('承認待ち'));

  // ---------- 店舗の対応付け ----------
  await page.click('summary:has-text("🆘 シフト管理アプリ連携設定")');
  await page.waitForTimeout(150);
  // 「(表示名未設定)」を名前として数えると、気づく手段ごと無くなる
  const unknownText = await page.locator('#shiftUnknownStores').innerText();
  check('未設定の合図を「名前あり」と数えない', true, unknownText.includes(STORE_A) && unknownText.includes(STORE_B));
  // 識別子だけを並べても、どのUUIDがどの店舗か分からず対応付けを書けない。
  // 先方の表示名とこちらでの表示を並べて出すこと
  checkIncludes('識別子とこちらでの表示を並べて出す', unknownText, `${STORE_A} →`);
  checkIncludes('名前が分からないものには何をすればよいか出す', unknownText, '対応付けを登録してください');
  info('オーナー設定の表示', unknownText.replace(/\n/g, ' | '));
  await page.fill('#shiftStoreMapInput', `${STORE_A} = 博多住吉通り\n${STORE_B} = 清川二丁目`);
  await page.click('button[onclick="saveShiftStoreMap()"]');
  await page.waitForTimeout(400);
  checkIncludes('対応付けの保存', await page.locator('#shiftStoreMapStatus').innerText(), '2件');
  const mappedText = await page.locator('#shiftUnknownStores').innerText();
  checkIncludes('保存後は対応付け済みと分かる', mappedText, '（対応付け済み）');
  checkIncludes('保存後は対応付けた店舗名が出る', mappedText, '清川二丁目');
  checkNotIncludes('保存後は「登録してください」を出さない', mappedText, '対応付けを登録してください');

  await page.click('#ownerDrawerCloseBtn').catch(() => {});
  await page.waitForTimeout(150);
  await page.evaluate(() => { closeOwnerDrawer && closeOwnerDrawer(); closeSideDrawer && closeSideDrawer(); });
  await page.waitForTimeout(150);
  await page.click('#helpBanner');
  await page.waitForTimeout(250);
  const mapped = (await page.locator('#helpListBody').innerText()).replace(/\n/g, ' | ');
  check('対応付け後は店舗名で出る', true, mapped.includes('博多住吉通り') && mapped.includes('清川二丁目') && !mapped.includes(STORE_A));
  check('自店には印を付ける', true, mapped.includes('自店'));

  // ---------- 連携の状態がオーナー設定から読めること ----------
  // ヘッダーは「募集が無い」ときも「つながっていない」ときも何も出さないため、
  // 画面からは区別が付かない。オーナー設定で内訳が読めるようにしてある
  const statusText = await page.locator('#shiftConnectionStatus').innerText();
  checkIncludes('接続できていることが分かる', statusText, '接続できています');
  checkIncludes('届いている件数が出る', statusText, '届いている募集 5件');
  checkIncludes('表示中の件数が出る', statusText, '表示中 4件');
  checkIncludes('過去日を除外したことが分かる', statusText, '過去日 1件');
  info('オーナー設定の連携状態', statusText);

  // ---------- 書き込みは一切しない ----------
  const shiftWrites = await page.evaluate(() => (window.__firestoreWrites || []).filter(w => w.app === 'shiftApp'));
  const seeded = 5; // テスト自身が投入した5件
  check('シフト管理アプリへの書き込みはテストの投入分だけ', seeded, shiftWrites.length);

  // ---------- filled なのに filledAt が無いとき ----------
  // シフト管理アプリの削除は「その店舗がアプリを開いたとき」に走る。こちらが
  // filledAt で切らないと「✅ 埋まりました」が出たまま戻らなくなる
  await page.evaluate(() => { closeHelpList(); });
  await page.evaluate(() => {
    const sdb = window.firebase.app('shiftApp').firestore();
    return sdb.collection('helpPostingsPublic').doc('auto-b2').update({ filledAt: null });
  });
  await page.waitForTimeout(300);
  const noFilledAt = (await bannerText()).replace(/\n/g, ' ');
  check('filledAt が無い filled は出さない', false, noFilledAt.includes('埋まりました'), `「${noFilledAt}」`);

  // 古い filledAt（48時間より前）も出さない
  await page.evaluate(oldIso => {
    const sdb = window.firebase.app('shiftApp').firestore();
    return sdb.collection('helpPostingsPublic').doc('auto-b2').update({ filledAt: oldIso });
  }, new Date(Date.now() - 72 * 3600000).toISOString());
  await page.waitForTimeout(300);
  check('48時間より古い filled は出さない', false, (await bannerText()).includes('埋まりました'));

  // 直近の filledAt なら出す
  await page.evaluate(nowIso => {
    const sdb = window.firebase.app('shiftApp').firestore();
    return sdb.collection('helpPostingsPublic').doc('auto-b2').update({ filledAt: nowIso });
  }, new Date().toISOString());
  await page.waitForTimeout(300);
  check('直近に埋まったものは出す', true, (await bannerText()).includes('埋まりました'));

  // ---------- 取り下げ（filled を経由せず消える）を「埋まりました」と言わない ----------
  // 休み希望が取り下げられた募集は、先方が filled を通さずいきなり削除する。
  // こちらは差分を取っていないので、黙って一覧から消えるだけで通知は出ない
  await page.evaluate(() => {
    const sdb = window.firebase.app('shiftApp').firestore();
    return sdb.collection('helpPostingsPublic').doc('auto-a2').delete();
  });
  await page.waitForTimeout(300);
  const afterWithdraw = (await bannerText()).replace(/\n/g, ' ');
  check('取り下げを「埋まりました」と言わない', 1,
    (afterWithdraw.match(/埋まりました/g) || []).length, `「${afterWithdraw}」`);
  check('取り下げた分だけ募集件数が減る', true, afterWithdraw.includes('2件'));

  // ---------- 募集が全部埋まったとき ----------
  await page.evaluate(() => { closeHelpList(); });
  await page.evaluate(async () => {
    const sdb = window.firebase.app('shiftApp').firestore();
    const snap = await sdb.collection('helpPostingsPublic').get();
    const now = new Date().toISOString();
    for (const d of snap.docs) {
      if (d.data().status !== 'filled') {
        await sdb.collection('helpPostingsPublic').doc(d.id).update({ status: 'filled', filledAt: now });
      }
    }
  });
  await page.waitForTimeout(400);
  const doneText = (await bannerText()).replace(/\n/g, ' ');
  check('全部埋まったら「N件」ではなく埋まった旨だけを出す', true,
    doneText.includes('埋まりました') && !/\d+件/.test(doneText), `「${doneText}」`);
  check('その状態のバナーは赤ではない', true, await page.locator('#helpBanner').evaluate(el => el.classList.contains('done')));

  check('ページエラーなし', '[]', JSON.stringify(errors));
  await page.close();

  // ---------- 先方の店舗名がこちらと違うとき ----------
  // 先方が「福岡清川二丁目店」、こちらが「清川二丁目」のように文字列が違うと、
  // 名前は付いているのに「📍 自店」の印が出ない。実際に本番でこれを踏んだ。
  // 画面から原因が分からないので、オーナー設定で読めるようにしてある
  const diff = await bootStaffSession(browser, { shiftConfig: SHIFT_CONFIG });
  await diff.page.evaluate(rows => {
    const sdb = window.firebase.app('shiftApp').firestore();
    rows.forEach(r => sdb.collection('helpPostingsPublic').doc(r.id).set(r.data));
  }, [
    // STORE_A はこの端末の店舗（博多住吉通り）だが、先方の表示名は別文字列
    { id: 'diff-1', data: { storeKey: STORE_A, storeLabel: LABEL_A_DIFFERENT, dateStr: IN_3_DAYS, slotName: '夜勤', startTime: '22:00', endTime: '08:00', isUrgent: true, status: 'open', postedToShareful: true } },
    { id: 'diff-2', data: { storeKey: STORE_B, storeLabel: LABEL_B_DIFFERENT, dateStr: IN_5_DAYS, slotName: '朝勤', startTime: '09:00', endTime: '17:00', isUrgent: false, status: 'open' } }
  ]);
  await diff.page.waitForTimeout(400);

  await diff.page.click('#helpBanner');
  await diff.page.waitForTimeout(250);
  const diffList = (await diff.page.locator('#helpListBody').innerText()).replace(/\n/g, ' | ');
  info('食い違いのある一覧', diffList);
  checkIncludes('先方が付けた店舗名はそのまま出す', diffList, LABEL_A_DIFFERENT);
  check('店舗名が食い違うと自店の印は出ない', false, diffList.includes('自店'));

  // ---------- シェアフル（外部の求人サービス）にも出ている枠 ----------
  // postedToShareful が true でも status は open のまま。社内からの立候補は
  // 引き続き受け付けるので、「埋まった」と読めてはいけない
  checkIncludes('外部にも出ている枠に印を付ける', diffList, '外部募集中');
  check('印が付くのは postedToShareful の枠だけ', 1, (diffList.match(/外部募集中/g) || []).length);
  const diffBanner = (await diff.page.locator('#helpBanner').innerText()).replace(/\n/g, ' ');
  checkIncludes('外部にも出ていても募集中として数える', diffBanner, 'ヘルプ募集 2件');
  checkNotIncludes('外部にも出ているだけで「埋まりました」と言わない', diffBanner, '埋まりました');
  check('外部にも出ている枠は応募で開ける', true, await diff.page.evaluate(async () => {
    document.querySelector('.help-row:not(.filled)').click();
    await new Promise(r => setTimeout(r, 100));
    return window.__opened.length === 1;
  }));

  // ---------- 対応付けを登録すれば自店の印が出る ----------
  await diff.page.evaluate(() => { closeHelpList(); });
  await diff.page.waitForTimeout(150);
  await diff.page.click('.active-view .settings-btn:has-text("⚙️")');
  await diff.page.waitForTimeout(150);
  await diff.page.click('button[onclick="openOwnerDrawer()"]');
  await diff.page.waitForTimeout(150);
  await diff.page.fill('#ownerLoginEmail', 'owner@test.example.com');
  await diff.page.fill('#ownerLoginPassword', 'owner-pass1');
  await diff.page.click('button[onclick="doOwnerLogin()"]');
  await diff.page.waitForTimeout(400);
  await diff.page.click('summary:has-text("🆘 シフト管理アプリ連携設定")');
  await diff.page.waitForTimeout(150);
  const diffUnknown = await diff.page.locator('#shiftUnknownStores').innerText();
  info('食い違い時のオーナー設定の表示', diffUnknown.replace(/\n/g, ' | '));
  checkIncludes('食い違っていることを知らせる', diffUnknown, '違います');
  checkIncludes('先方の表示名を出して対応付けを書けるようにする', diffUnknown, LABEL_A_DIFFERENT);

  await diff.page.fill('#shiftStoreMapInput', `${STORE_A} = 博多住吉通り`);
  await diff.page.click('button[onclick="saveShiftStoreMap()"]');
  await diff.page.waitForTimeout(400);
  await diff.page.evaluate(() => { closeOwnerDrawer && closeOwnerDrawer(); closeSideDrawer && closeSideDrawer(); });
  await diff.page.waitForTimeout(150);
  await diff.page.click('#helpBanner');
  await diff.page.waitForTimeout(250);
  const diffFixed = (await diff.page.locator('#helpListBody').innerText()).replace(/\n/g, ' | ');
  check('対応付けを登録すると自店の印が出る', true, diffFixed.includes('自店'));
  checkIncludes('対応付けた側はこちらの店舗名で出す', diffFixed, '博多住吉通り');
  checkNotIncludes('対応付けた側に先方の表示名は残さない', diffFixed, LABEL_A_DIFFERENT);
  checkIncludes('対応付けていない店舗は先方の表示名のまま', diffFixed, LABEL_B_DIFFERENT);
  check('食い違いの画面でページエラーなし', '[]', JSON.stringify(diff.errors));
  await diff.page.close();

  // ---------- 接続に失敗したとき ----------
  const broken = await bootStaffSession(browser, {
    shiftConfig: { ...SHIFT_CONFIG, viewerPassword: 'wrong-password' }
  });
  await broken.page.waitForTimeout(400);
  check('接続に失敗したらバナーを出さない（0件と言わない）', false, await broken.page.locator('#helpBanner').isVisible());
  check('失敗を握りつぶして「募集ゼロ」にしない', true, await broken.page.evaluate(() => helpPostings === null && helpPostingsError !== ''));
  await broken.page.close();

  report();
  await browser.close();
})();
