// 全テストを順に実行する。静的サーバーの起動・停止も込みで完結する。
//   NODE_PATH=<playwrightの場所> node tests/run-all.js
const fs = require('fs');
const path = require('path');
const { fork, execFileSync } = require('child_process');

const PORT = process.env.PORT || 8175;

// サーバーは別プロセスに置く。同一プロセスだと execFileSync が
// イベントループを止めてしまい、テストからの接続を受けられない
const server = fork(path.join(__dirname, 'static-server.js'), {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
  detached: false
});

const runTests = () => {
  const tests = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('-test.js') || f === 'mock-regress-smoke.js')
    .sort();

  const crashed = [];   // スクリプトが落ちた
  const failed = [];    // 判定が食い違った
  const unjudged = [];  // report() を呼んでいない = 自動判定していない
  let totalPass = 0, totalFail = 0;

  for (const t of tests) {
    process.stdout.write(`\n===== ${t} =====\n`);
    let out = '';
    let crashedHere = false;
    try {
      out = execFileSync(process.execPath, [path.join(__dirname, t)], {
        env: { ...process.env, PORT: String(PORT) },
        encoding: 'utf8',
        timeout: 120000
      });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      crashedHere = true;
    }
    process.stdout.write(out);

    // assert.js が最後に出す 1 行から合否を拾う
    const m = /TEST-RESULT pass=(\d+) fail=(\d+)/.exec(out);
    if (m) {
      const pass = Number(m[1]), fail = Number(m[2]);
      totalPass += pass; totalFail += fail;
      if (fail > 0) failed.push(`${t} (${fail}件)`);
      // 判定行が出ていれば、終了コードが 1 なのは判定の失敗によるもの。
      // 判定は成功しているのに落ちた場合だけ「異常終了」として扱う
      if (crashedHere && fail === 0) { process.stdout.write(`!! 異常終了: ${t}\n`); crashed.push(t); }
    } else {
      // report() まで到達していない。途中で落ちたか、まだ自動判定に移行していない
      process.stdout.write(`!! 判定結果が出力されていません: ${t}\n`);
      (crashedHere ? crashed : unjudged).push(t);
    }
  }

  const bad = crashed.length + failed.length + unjudged.length;
  console.log('\n========================================');
  console.log(`実行: ${tests.length}本 / 判定: ${totalPass}件 成功 ・ ${totalFail}件 失敗`);
  if (failed.length) console.log('判定が食い違ったテスト:\n  ' + failed.join('\n  '));
  if (crashed.length) console.log('異常終了:\n  ' + crashed.join('\n  '));
  if (unjudged.length) console.log('自動判定していないテスト:\n  ' + unjudged.join('\n  '));
  if (!bad) console.log('すべて自動判定で合格しました。');
  console.log('========================================');

  server.kill();
  process.exit(bad ? 1 : 0);
};

let started = false;
server.on('message', m => { if (m === 'ready') { started = true; runTests(); } });
server.on('error', e => { console.error('静的サーバーを起動できませんでした:', e.message); process.exit(1); });
// ポートが使用中だと子プロセスは error ではなく exit で落ちる。
// これを拾わないと、何も出力しないまま終了してしまう
server.on('exit', code => {
  if (!started) {
    console.error(`静的サーバーが起動前に終了しました (code: ${code})。`);
    console.error(`ポート ${PORT} が既に使われていないか確認してください。`);
    process.exit(1);
  }
});
