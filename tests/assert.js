// テストの合否を自動で判定するための小さなヘルパー。
//
// 以前は各テストが「項目名 (expect 期待値): 実際の値」を出力するだけで、
// 突き合わせているのは人間の目だけでした。run-all.js が検出できるのは
// 「スクリプトが異常終了したかどうか」だけだったため、判定が食い違っていても
// 素通りします。実際、時刻を固定文字列で書いたフィクスチャが壊れているのに
// 3回とも気づけませんでした（kinko-stale-record / kinko-empty-safe /
// kinko-auto-import）。
//
// 使い方:
//   const { check, checkIncludes, info, report } = require('./assert');
//   check('バナーを出す', true, await page.locator('#x').isVisible());
//   report();   // 最後に必ず呼ぶ。失敗があれば終了コードを 1 にする

let passed = 0;
const failures = [];

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

function record(ok, name, expected, actual, detail) {
  const tail = detail === undefined || detail === '' ? '' : `  ${detail}`;
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${tail}`);
  } else {
    failures.push({ name, expected, actual });
    console.log(`  ❌ ${name}  期待: ${fmt(expected)} / 実際: ${fmt(actual)}${tail}`);
  }
  return ok;
}

// 完全一致。NaN 同士や -0/+0 の差も含めて素直に比べたいので Object.is を使う
function check(name, expected, actual, detail) {
  return record(Object.is(expected, actual), name, expected, actual, detail);
}

// 部分一致。画面の文言は前後に余計なものが付くため、含まれているかで見る
function checkIncludes(name, actual, needle, detail) {
  const text = actual == null ? '' : String(actual);
  return record(text.includes(needle), name, `「${needle}」を含む`, text, detail);
}

function checkNotIncludes(name, actual, needle, detail) {
  const text = actual == null ? '' : String(actual);
  return record(!text.includes(needle), name, `「${needle}」を含まない`, text, detail);
}

// 判定しない参考出力。失敗の原因を追うための手掛かりを残す用
function info(name, value) {
  console.log(`  ・ ${name}: ${value == null ? '' : String(value).replace(/\n/g, ' | ')}`);
}

// 最後に必ず呼ぶ。run-all.js はこの行を読んで合否を集計する
function report() {
  console.log(`\n判定: ${passed}件 成功 / ${failures.length}件 失敗`);
  failures.forEach(f => console.log(`  失敗: ${f.name}  期待 ${fmt(f.expected)} / 実際 ${fmt(f.actual)}`));
  console.log(`TEST-RESULT pass=${passed} fail=${failures.length}`);
  if (failures.length) process.exitCode = 1;
}

module.exports = { check, checkIncludes, checkNotIncludes, info, report };
