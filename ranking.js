// ===== ランキング（Firestore）連携：5分タイムアタック専用 =====
// Firebase公式CDN（バージョン固定）から読み込む。app / auth / firestore は必ず同じバージョンにそろえること。
// firebaseConfigの値は公開されて良い情報で、実際のアクセス制限はFirestoreのセキュリティルールで行います。
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, query, orderBy, limit, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDbnYZRqxdCgL0CuyLKwiR6gLX9TLg8Zg8",
  authDomain: "future-vision-trade.firebaseapp.com",
  projectId: "future-vision-trade",
  storageBucket: "future-vision-trade.firebasestorage.app",
  messagingSenderId: "332038180664",
  appId: "1:332038180664:web:19e0538c6b0777ddabfbcd"
};
// App Check（任意）：reCAPTCHA v3 のサイトキーを取得したらここに入れると、サイト外からの書き込みを遮断できます
const RECAPTCHA_V3_SITE_KEY = "";

const EQUITY_CAP = 10000000;       // 資産の上限：1,000万円＝軍資金の10倍（ルール側と同じ値）
// 期間別のランキング。コレクション名は日本時間の日付・週から作る（ルール側でも同じ計算で検査）
const JST = 9 * 3600 * 1000;
function periodCollection(period) {
  const now = Date.now();
  if (period === "day") { const d = new Date(now + JST); return "ta5d_" + d.getUTCFullYear() + "_" + (d.getUTCMonth() + 1) + "_" + d.getUTCDate(); }
  if (period === "week") return "ta5w_" + Math.floor((now + JST + 3 * 86400000) / 604800000);
  return "ta5";
}
const PERIODS = ["all", "week", "day"];

let app = null, db = null, auth = null, initError = null;
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
} catch (e) { initError = e; console.error("Firebase init failed:", e); }

if (app && RECAPTCHA_V3_SITE_KEY) {
  try {
    const { initializeAppCheck, ReCaptchaV3Provider } = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js");
    initializeAppCheck(app, { provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY), isTokenAutoRefreshEnabled: true });
  } catch (e) { console.error("App Check init failed:", e); }
}

function ready() { if (!db) throw new Error(initError ? String(initError.message || initError) : "Firestore is not ready"); }
async function ensureUser() {
  ready();
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : 0));

// 期間ごと（全期間・今週・今日）に、自己ベストを更新したときだけ書き込む
// 戻り値: [{ period, status: "created" | "updated" | "notBest" | "error", best }]
async function submitBest(data) {
  const user = await ensureUser();
  const equity = Math.round(num(data.equity, 0, 1e12));
  if (equity > EQUITY_CAP) return { tooHigh: true, results: [] };
  const record = {
    nickname: String(data.nickname || "").slice(0, 20) || "名無しの未来人",
    equity,
    ret: Math.round(num(data.ret, -100, 1000) * 100) / 100,
    trades: Math.round(num(data.trades, 0, 10000)),
    winRate: Math.round(num(data.winRate, 0, 100)),
    futureRate: Math.round(num(data.futureRate, 0, 100)),
    rank: String(data.rank || "").slice(0, 40),
    seed: Math.round(num(data.seed, 0, 4294967295)),
    log: String(data.log || "").slice(0, 20000),
    ts: serverTimestamp()
  };
  const results = [];
  for (const period of PERIODS) {
    try {
      const ref = doc(db, periodCollection(period), user.uid);
      const snap = await getDoc(ref);
      const prev = snap.exists() ? snap.data() : null;
      if (prev && Number(prev.equity) >= equity) { results.push({ period, status: "notBest", best: Number(prev.equity) }); continue; }
      await setDoc(ref, record);
      results.push({ period, status: prev ? "updated" : "created", best: equity });
    } catch (e) {
      console.error(period, e);
      results.push({ period, status: "error", error: String(e && (e.code || e.message) || "") });
    }
  }
  return { tooHigh: false, results };
}

async function fetchTop(period, n) {
  ready();
  const q = query(collection(db, periodCollection(period)), orderBy("equity", "desc"), limit(n || 20));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach(d => rows.push(Object.assign({ id: d.id }, d.data())));
  return rows;
}
function myId() { return auth && auth.currentUser ? auth.currentUser.uid : null; }

window.Ranking = { submitBest, fetchTop, myId, EQUITY_CAP, ready: !!db };
window.dispatchEvent(new Event("ranking-ready"));
