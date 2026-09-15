// テスト用の静的サーバー。リポジトリのルートを配信するだけ。
//   node tests/static-server.js        (既定: 8175番ポート)
//   PORT=9000 node tests/static-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8175;
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.rules': 'text/plain' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  // ルート外へのアクセスを防ぐ
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`静的サーバー: http://localhost:${PORT}/index.html`);
  if (process.send) process.send('ready');
});
