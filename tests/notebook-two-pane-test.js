// 連絡ノートの2分割表示（上＝その日の1枚 / 下＝過去を横スクロール）の確認。
// 日時は必ず Date.now() からの相対で作る（固定文字列は実行日によって意味が変わる）
const { chromium } = require('playwright');
const { check, checkIncludes, checkNotIncludes, info, report } = require('./assert');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 8175;

const hoursAgo = h => new Date(Date.now() - h * 3600000);

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
    localStorage.setItem('my_name', 'ゆだ');
    localStorage.setItem('active_store', '博多住吉通り');
    window.__mockUsers = {
      'staff@my-store-1234.local': { password: 'pin1234', user: { uid: 'shared-uid', isAnonymous: false, email: 'staff@my-store-1234.local', displayName: null } }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(300);
  await page.fill('#pinLoginInput', 'pin1234');
  await page.click('#pinLoginForm button');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ stores: ['博多住吉通り'] }, { merge: true });
  });
  await page.waitForTimeout(250);

  // その日ぶん（2時間前の引継ぎ → 1時間前の自由記入 → 自動リマインド）と、前日ぶん
  await page.evaluate(rows => {
    const fdb = window.firebase.firestore();
    rows.forEach(r => fdb.collection('notebookEntries').doc(r.id).set({
      ...r.data, createdAt: { __ts: new Date(r.at).getTime(), toDate: () => new Date(r.at) }
    }));
  }, [
    { id: 'today-handover', at: hoursAgo(2).toISOString(), data: { type: 'handover', text: '・店頭受取荷物: 3件', author: 'ゆだ', store: '博多住吉通り' } },
    { id: 'today-note', at: hoursAgo(1).toISOString(), data: { type: 'note', text: '本日14時に業者が来店予定です', author: 'ケン', store: '博多住吉通り' } },
    { id: 'today-reminder', at: hoursAgo(1).toISOString(), data: { type: 'note', text: '忘れ物の保管期限が近づいています', author: '🔔 自動リマインド', store: '博多住吉通り' } },
    { id: 'yesterday-handover', at: hoursAgo(26).toISOString(), data: { type: 'handover', text: '・レジ点検 異常なし', author: 'まえだ', store: '博多住吉通り' } }
  ]);
  await page.waitForTimeout(300);

  await page.click('.grid-card[onclick="openView(\'notebook\')"]');
  await page.waitForTimeout(300);

  const sheet = await page.locator('#latestHandoverContent').innerText();
  info('その日の1枚の中身', sheet.replace(/\n/g, ' | '));
  check('引継ぎと自由記入が同じ1枚に並ぶ', true, sheet.includes('店頭受取荷物') && sheet.includes('業者が来店'));
  check('時系列で並ぶ（引継ぎが先）', true, sheet.indexOf('店頭受取荷物') < sheet.indexOf('業者が来店'));
  check('投稿者と時刻が行ごとに出る', true, sheet.includes('ゆだ') && sheet.includes('ケン'));
  check('自動リマインドは1枚に混ぜない', false, sheet.includes('保管期限'));
  check('前日ぶんは上の1枚に入らない', false, sheet.includes('レジ点検'));
  check('行数は自動リマインドを除いた2行', 2, await page.locator('#latestHandoverContent .sheet-line').count());

  // 履歴には今までどおり残る（リマインドを消してはいない）
  const history = await page.locator('#notebookList').innerText();
  check('自動リマインドは履歴には残る', true, history.includes('保管期限'));

  // 下部：過去の引継ぎ
  check('過去の引継ぎカードが出る', 1, await page.locator('#pastDayScroller .day-card').count());
  const past = await page.locator('#pastDayScroller').innerText();
  info('過去カードの中身', past.replace(/\n/g, ' | '));
  check('前日の引継ぎが下に出る', true, past.includes('レジ点検'));
  check('横スクロールできる', true, await page.locator('#pastDayScroller').evaluate(
    el => getComputedStyle(el).overflowX === 'auto' && getComputedStyle(el).display === 'flex'));

  // 未確認のハイライト
  check('未確認ならその日の1枚が目立つ', true, await page.locator('#todaySheetCard').evaluate(el => el.classList.contains('unread')));
  check('未確認のしるしが出る', true, (await page.locator('#todaySheetChip').innerText()).includes('未確認'));
  check('過去カードも未確認なら目立つ', true, await page.locator('#pastDayScroller .day-card').first().evaluate(el => el.classList.contains('unread')));

  // 確認するとハイライトが外れる
  await page.evaluate(() => {
    window.firebase.firestore().collection('handoverConfirmations').doc('c1').set({
      entryId: 'today-handover', staffName: 'ケン',
      confirmedAt: { __ts: Date.now(), toDate: () => new Date() }
    });
  });
  await page.waitForTimeout(300);
  check('確認後はハイライトが外れる', false, await page.locator('#todaySheetCard').evaluate(el => el.classList.contains('unread')));
  checkIncludes('確認した人数が出る', (await page.locator('#todaySheetChip').innerText()).trim(), '1');

  // 営業日の切り替え時刻。夜勤が24時をまたいでも1枚に収まることを直接確かめる。
  // 「今が何時か」に依存しないよう、日付をまたぐ2点のキーを直接比べる
  check('既定の切り替え時刻', 5, await page.evaluate(() => notebookDayStartHour));
  const straddle = await page.evaluate(() => {
    const base = new Date();
    base.setHours(23, 50, 0, 0);              // 夜勤の途中
    const after = new Date(base.getTime() + 100 * 60000); // 100分後 = 翌 1:30
    return { before: businessDayKey(base), after: businessDayKey(after) };
  });
  check('朝5時区切りなら23:50と翌1:30が同じ営業日', true,
    straddle.before === straddle.after, `(${straddle.before} / ${straddle.after})`);

  await page.evaluate(() => {
    window.firebase.firestore().collection('appSettings').doc('general').set({ notebookDayStartHour: 0 }, { merge: true });
  });
  await page.waitForTimeout(350);
  check('設定が効く', 0, await page.evaluate(() => notebookDayStartHour));
  const split = await page.evaluate(() => {
    const base = new Date();
    base.setHours(23, 50, 0, 0);
    const after = new Date(base.getTime() + 100 * 60000);
    return { before: businessDayKey(base), after: businessDayKey(after) };
  });
  check('0時区切りにすると同じ夜勤が2枚に割れる', false,
    split.before === split.after, `(${split.before} / ${split.after})`);

  check('ページエラーなし', '[]', JSON.stringify(errors));
  report();
  await browser.close();
})();
