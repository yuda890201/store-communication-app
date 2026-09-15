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

  const crashed = [];
  for (const t of tests) {
    process.stdout.write(`\n===== ${t} =====\n`);
    try {
      process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, t)], {
        env: { ...process.env, PORT: String(PORT) },
        encoding: 'utf8',
        timeout: 120000
      }));
    } catch (e) {
      process.stdout.write((e.stdout || '') + (e.stderr || '') + '\n');
      process.stdout.write(`!! 異常終了: ${t}\n`);
      crashed.push(t);
    }
  }

  console.log('\n========================================');
  console.log(`実行: ${tests.length}本 / 異常終了: ${crashed.length}本`);
  if (crashed.length) console.log('異常終了:\n  ' + crashed.join('\n  '));
  console.log('\n各行の「(expect ...)」と実際の値が一致しているか、出力を目視で確認してください。');
  console.log('自動では判定していません。異常終了のみ検出します。');
  console.log('========================================');

  server.kill();
  process.exit(crashed.length ? 1 : 0);
};

server.on('message', m => { if (m === 'ready') runTests(); });
server.on('error', e => { console.error('静的サーバーを起動できませんでした:', e.message); process.exit(1); });
