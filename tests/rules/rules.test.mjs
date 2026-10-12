// Firestore セキュリティルール（firestore.rules）の単体テスト。
// 使い方（tests/rules で実行）: npm install && npm test
//   → Firestore エミュレーターを起動し、このファイルを node --test で実行する（本番の Firebase には接続しない）
// コレクション名の計算は ranking.js の periodCollection() をそのまま取り出して使い、
// クライアントとルール（dayCol / weekCol）の計算が一致しているかを確かめる。
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, orderBy, limit, serverTimestamp, Timestamp } from "firebase/firestore";

const root = new URL("../../", import.meta.url);
const rules = readFileSync(new URL("firestore.rules", root), "utf8");
const rankingSrc = readFileSync(new URL("ranking.js", root), "utf8");

// ranking.js から EQUITY_CAP・GAMES・JST 定数と periodCollection() を取り出す
const capLine = rankingSrc.match(/^const EQUITY_CAP = .*$/m);
const gamesSrc = rankingSrc.match(/^const GAMES = \{[\s\S]*?^\};$/m);
const jstLine = rankingSrc.match(/^const JST = .*;$/m);
const fnSrc = rankingSrc.match(/^function periodCollection\(period, game\) \{[\s\S]*?^\}$/m);
assert.ok(capLine && gamesSrc && jstLine && fnSrc, "ranking.js の periodCollection() / GAMES が見つかりません");
const [clientPeriodCollection, GAMES] = new Function([capLine[0], gamesSrc[0], jstLine[0], fnSrc[0]].join("\n") + "\nreturn [periodCollection, GAMES];")();
const EQUITY_CAP = GAMES.normal.cap;
const WN_CAP = GAMES.walnut.cap;

// 指定時刻でのコレクション名（Date.now を一時的に差し替えてクライアントの関数を呼ぶ）
function colAt(period, ms, game) {
  const real = Date.now;
  Date.now = () => ms;
  try { return clientPeriodCollection(period, game); } finally { Date.now = real; }
}

// ranking.js の submitBest() が送るのと同じ形のデータ（base：軍資金。ウォルナットは30万円）
function record(equity, over = {}, base = 1000000) {
  return Object.assign({
    nickname: "ルールテスト", equity,
    ret: Math.round((equity - base) / (base / 100) * 100) / 100,
    trades: 3, winRate: 67, futureRate: 40, rank: "見習い未来人",
    seed: 123456789, log: "crnjpy,b,10000,1000,88.4,2000,88.5,0",
    ts: serverTimestamp()
  }, over);
}

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-future-trade", firestore: { rules } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const alice = () => env.authenticatedContext("alice").firestore();
const guest = () => env.unauthenticatedContext().firestore();
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), path), data); });
}
// 日付・週の境目をまたぐ瞬間の実行で結果がぶれないよう、境目の直前なら少し待つ
async function awayFromBoundary() {
  for (;;) {
    const now = Date.now();
    if (colAt("day", now) === colAt("day", now + 5000) && colAt("week", now) === colAt("week", now + 5000)) return;
    await new Promise(r => setTimeout(r, 1000));
  }
}

test("クライアントの期間コレクション名：既知の日時で正しい", () => {
  // 2026-09-25 23:59:59 JST（= 14:59:59 UTC）と、その1秒後（9/26 0:00 JST）
  const a = Date.UTC(2026, 8, 25, 14, 59, 59), b = a + 1000;
  assert.equal(colAt("day", a), "ta5d_2026_9_25");
  assert.equal(colAt("day", b), "ta5d_2026_9_26");
  assert.equal(colAt("all", a), "ta5");
  // 週の切り替わりは日本時間の月曜 0:00（2026-09-28 は月曜）
  const sunEnd = Date.UTC(2026, 8, 27, 14, 59, 59), monStart = sunEnd + 1000;
  assert.notEqual(colAt("week", sunEnd), colAt("week", monStart));
  assert.equal(colAt("week", monStart), colAt("week", monStart + 7 * 86400000 - 1));
  assert.match(colAt("week", monStart), /^ta5w_\d+$/);
});

test("ルールとクライアントで、今日・今週・全期間のコレクション名が一致する（登録できる）", async () => {
  await awayFromBoundary();
  const now = Date.now();
  for (const period of ["day", "week", "all"]) {
    await assertSucceeds(setDoc(doc(alice(), colAt(period, now), "alice"), record(1234567)));
  }
});

test("今日・今週以外の期間コレクションには登録できない", async () => {
  await awayFromBoundary();
  const now = Date.now();
  for (const ms of [now - 86400000, now + 86400000]) await assertFails(setDoc(doc(alice(), colAt("day", ms), "alice"), record(1234567)));
  for (const ms of [now - 7 * 86400000, now + 7 * 86400000]) await assertFails(setDoc(doc(alice(), colAt("week", ms), "alice"), record(1234567)));
  await assertFails(setDoc(doc(alice(), "users", "alice"), record(1234567)));
});

test("読み取り：ランキングのコレクションだけ誰でも読める", async () => {
  const now = Date.now();
  for (const col of ["ta5", colAt("day", now - 86400000), colAt("week", now - 7 * 86400000)]) {
    await assertSucceeds(getDocs(query(collection(guest(), col), orderBy("equity", "desc"), limit(20))));
  }
  await assertFails(getDoc(doc(guest(), "users", "x")));
  await assertFails(getDocs(collection(guest(), "ta5_evil")));
});

test("未ログイン・他人のIDでは登録できない", async () => {
  await assertFails(setDoc(doc(guest(), "ta5", "alice"), record(1234567)));
  await assertFails(setDoc(doc(alice(), "ta5", "bob"), record(1234567)));
});

test("損益率と資産額の一致チェック（整数で届く ret=0・-100・900 も含む）", async () => {
  for (const eq of [1000000, 0, EQUITY_CAP, 1234567, 999999, 1000001, 876543]) {
    await env.clearFirestore();
    await assertSucceeds(setDoc(doc(alice(), "ta5", "alice"), record(eq)), `equity=${eq}`);
  }
  await env.clearFirestore();
  await assertFails(setDoc(doc(alice(), "ta5", "alice"), record(1234567, { ret: 50 })));
  await assertFails(setDoc(doc(alice(), "ta5", "alice"), record(1234567, { ret: 23.43 })));   // 正しくは 23.46
  await assertFails(setDoc(doc(alice(), "ta5", "alice"), record(1234567, { ret: "23.46" })));
});

test("資産の上限・型・範囲のチェック", async () => {
  const ta5 = () => doc(alice(), "ta5", "alice");
  await assertFails(setDoc(ta5(), record(EQUITY_CAP + 1)));
  await assertFails(setDoc(ta5(), record(-1)));
  await assertFails(setDoc(ta5(), record(1234567.5, { ret: 23.46 })));
  await assertFails(setDoc(ta5(), record(1234567, { nickname: "" })));
  await assertFails(setDoc(ta5(), record(1234567, { nickname: "あ".repeat(21) })));
  await assertSucceeds(setDoc(ta5(), record(1234567, { nickname: "あ".repeat(20) })));
  await env.clearFirestore();
  await assertFails(setDoc(ta5(), record(1234567, { seed: -1 })));
  await assertFails(setDoc(ta5(), record(1234567, { seed: 4294967296 })));
  await assertFails(setDoc(ta5(), record(1234567, { log: "x".repeat(20001) })));
  await assertFails(setDoc(ta5(), record(1234567, { winRate: 101 })));
  await assertFails(setDoc(ta5(), record(1234567, { ts: Timestamp.fromMillis(Date.now()) })));
  await assertFails(setDoc(ta5(), record(1234567, { admin: true })));
  const missing = record(1234567); delete missing.log;
  await assertFails(setDoc(ta5(), missing));
});

test("更新：自己ベスト更新かつ前回から60秒以上あいたときだけ", async () => {
  const path = "ta5/alice", old = Timestamp.fromMillis(Date.now() - 120000);
  await seed(path, Object.assign(record(1100000), { ts: old }));
  await assertFails(setDoc(doc(alice(), path), record(1100000)));   // 同じ資産
  await assertFails(setDoc(doc(alice(), path), record(1050000)));   // 下がった
  await assertSucceeds(setDoc(doc(alice(), path), record(1200000)));
  // 直前（60秒以内）に登録したばかりなら、ベストでも更新できない
  await assertFails(setDoc(doc(alice(), path), record(1300000)));
  await seed("ta5/bob", Object.assign(record(1000000), { ts: old }));
  await assertFails(setDoc(doc(alice(), "ta5/bob"), record(1500000)));   // 他人の記録
});

test("ウォルナット：コレクション名（wn5）が既知の日時で正しい", () => {
  const a = Date.UTC(2026, 8, 25, 14, 59, 59);
  assert.equal(colAt("day", a, "walnut"), "wn5d_2026_9_25");
  assert.equal(colAt("all", a, "walnut"), "wn5");
  assert.equal(colAt("week", a, "walnut"), colAt("week", a).replace("ta5w_", "wn5w_"));
});

test("ウォルナット：今日・今週・全期間に登録でき、誰でも読める", async () => {
  await awayFromBoundary();
  const now = Date.now();
  for (const period of ["day", "week", "all"]) {
    await assertSucceeds(setDoc(doc(alice(), colAt(period, now, "walnut"), "alice"), record(654321, {}, 300000)));
  }
  for (const col of ["wn5", colAt("day", now - 86400000, "walnut"), colAt("week", now - 7 * 86400000, "walnut")]) {
    await assertSucceeds(getDocs(query(collection(guest(), col), orderBy("equity", "desc"), limit(20))));
  }
  await assertFails(getDocs(collection(guest(), "wn5_evil")));
  for (const ms of [now - 86400000, now + 86400000]) await assertFails(setDoc(doc(alice(), colAt("day", ms, "walnut"), "alice"), record(654321, {}, 300000)));
});

test("ウォルナット：軍資金30万円での損益率チェック・上限300万円・ゼロカットの0円", async () => {
  const wn = () => doc(alice(), "wn5", "alice");
  for (const eq of [300000, 0, WN_CAP, 654321, 299999]) {
    await env.clearFirestore();
    await assertSucceeds(setDoc(wn(), record(eq, {}, 300000)), `equity=${eq}`);
  }
  await env.clearFirestore();
  await assertFails(setDoc(wn(), record(WN_CAP + 1, {}, 300000)));
  await assertFails(setDoc(wn(), record(654321)));                                        // 通常モード（100万円基準）の損益率では登録できない
  await assertFails(setDoc(doc(alice(), "ta5", "alice"), record(654321, {}, 300000)));    // ウォルナットの成績を通常のランキングには登録できない
  await assertFails(setDoc(doc(guest(), "wn5", "alice"), record(654321, {}, 300000)));
});

test("削除はできない", async () => {
  await seed("ta5/alice", Object.assign(record(1100000), { ts: Timestamp.fromMillis(Date.now() - 120000) }));
  await assertFails(deleteDoc(doc(alice(), "ta5/alice")));
});
