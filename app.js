(function(){
  "use strict";

  // ======================= 設定 =======================
  const TICK_MS = 200;
  const DELAY_MS = 30000;
  const BACKFILL_MS = 8 * 3600 * 1000;       // 起動時に生成する過去データ（8時間分）
  const START_BALANCE = 1000000;   // 軍資金100万円
  const SHARE_URL = "https://rinpei135.github.io/Future-trade/"; // 公開先URL（自前ホスティング時は差し替え）
  const HASHTAG = "#30秒先が見えるトレード";

  const INSTRUMENTS = {
    crnjpy: {
      key: "crnjpy", code: "CRN/JPY", name: "クロノ/日本円", kind: "fx",
      start: 88.42, decimals: 3, tick: 0.001, spread: 0.006, leverage: 25,
      lots: [10000, 50000, 100000, 200000], defaultLot: 50000, minUnit: 1000, maxUnit: 5000000, unit: "通貨",
      // 時間足ごとの固定縮尺 [グリッド幅(円), 1グリッドあたりのpx]
      scales: { 1: [0.02, 34], 5: [0.02, 20], 60: [0.05, 20], 300: [0.1, 18] },
      drift: 0.01, longRevert: 0.0001, noise: 0.005, revert: 0.05,
      burstProb: 0.006, burstSize: 0.05, jumpProb: 0, jumpMin: 0, jumpMax: 0,
      limit: 0, floor: 30, volRef: 0.012,
      orderOffset: 0.05, tpOffset: 0.1, slOffset: 0.05,
      rateBuy: 0.00014, rateSell: -0.00016, carryLabel: "スワップ"
    },
    tokiwarp: {
      key: "tokiwarp", code: "TKWP", name: "トキワープHD", kind: "stock",
      start: 482, decimals: 0, tick: 1, spread: 1, leverage: 3.3,
      lots: [1000, 3000, 5000], defaultLot: 1000, minUnit: 100, maxUnit: 100000, unit: "株",
      scales: { 1: [2, 24], 5: [5, 24], 60: [10, 24], 300: [10, 20] },
      drift: 1.2, longRevert: 0.0001, noise: 0.6, revert: 0.06,
      burstProb: 0.02, burstSize: 6, jumpProb: 0.003, jumpMin: 8, jumpMax: 22,
      limit: 80, floor: 50, volRef: 2.5,           // 前日終値482円 → 値幅制限±80円
      orderOffset: 5, tpOffset: 15, slOffset: 8,
      rateBuy: -0.000077, rateSell: -0.000032, carryLabel: "金利"
    }
  };
  const SYM_KEYS = Object.keys(INSTRUMENTS);
  const TFS = [{ label: "1秒", sec: 1 }, { label: "5秒", sec: 5 }, { label: "1分", sec: 60 }, { label: "5分", sec: 300 }];
  const CHART_TYPES = [
    { t: "candle", label: "ローソク足" }, { t: "hollow", label: "中空ローソク足" }, { t: "bar", label: "バー" },
    { t: "line", label: "ライン" }, { t: "area", label: "エリア" }, { t: "hilo", label: "ハイロー" }
  ];
  const INDICATORS = [
    { id: "ma20", label: "移動平均線（20）", color: "#3b82f6" },
    { id: "ma50", label: "移動平均線（50）", color: "#a855f7" },
    { id: "bb", label: "ボリンジャーバンド（20, 2σ）", color: "#64748b" },
    { id: "vol", label: "出来高", color: "#17c99b" }
  ];

  // ======================= ユーティリティ =======================
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // シード値から毎回同じ乱数列を作る（挑戦状で同じ相場を再現するため）
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const gaussR = (r) => (r() + r() + r() - 1.5) / 1.5;
  const randomSeed = () => Math.floor(Math.random() * 4294967296) >>> 0;
  const roundTo = (x, t) => Math.round(x / t) * t;
  function fmtP(k, x) {
    const d = INSTRUMENTS[k].decimals;
    return d === 0 ? Math.round(x).toLocaleString("ja-JP") : x.toFixed(d);
  }
  const fmtIn = (k, x) => x.toFixed(INSTRUMENTS[k].decimals);
  function fmtYen(n) { return (n < 0 ? "-" : "") + "¥" + Math.abs(Math.round(n)).toLocaleString("ja-JP"); }
  function fmtSYen(n) { return (n > 0 ? "+" : n < 0 ? "-" : "±") + "¥" + Math.abs(Math.round(n)).toLocaleString("ja-JP"); }
  const fmtQty = (k, u) => u.toLocaleString("ja-JP") + INSTRUMENTS[k].unit;
  const fmtQtyShort = (k, u) => u >= 10000 ? +(u / 10000).toFixed(1) + "万" + INSTRUMENTS[k].unit : fmtQty(k, u);   // スマホの操作バー用
  const dirJ = (d) => (d === "buy" ? "買" : "売");
  function fmtSlip(k, s) {
    return INSTRUMENTS[k].kind === "fx" ? (s * 100).toFixed(1) + "銭" : Math.round(s) + "円";
  }
  function fmtClock(ms, withSec) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + (withSec ? ":" + p(d.getSeconds()) : "");
  }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  // ======================= 価格エンジン =======================
  const engines = {};
  const SYM_SALT = { crnjpy: 0x9E3779B9, tokiwarp: 0x85EBCA6B };
  function freshEngine(k, seed) {
    const c = INSTRUMENTS[k];
    return {
      price: c.start, center: c.start, pub: c.start, spreadMult: 1, ticks: [], bars: [], views: {}, book: new Map(), limitState: 0,
      rng: mulberry32((seed ^ (SYM_SALT[k] || 0)) >>> 0)
    };
  }
  const MAX_BARS = Math.ceil((BACKFILL_MS + DELAY_MS) / 1000) + 120;
  let backfilling = false;
  const newsQueue = [];
  const NEWS_UP = [
    "【速報】トキワープHD、試作機で「3秒前に戻る」ことに成功と発表。",
    "トキワープHD、大手家電メーカーと業務提携を発表。",
    "トキワープHD、上方修正を発表。「来期の決算はもう見てきた」と社長。"
  ];
  const NEWS_DOWN = [
    "【速報】トキワープHD、試作機が「3秒前」ではなく「3秒後」に進むだけと判明。",
    "トキワープHD社長、会見で「時計を見間違えていた」と釈明。",
    "トキワープHD、実験室の壁掛け時計が止まっていたことが発覚。"
  ];
  function limitsOf(k) { const c = INSTRUMENTS[k]; return c.limit ? [c.start - c.limit, c.start + c.limit] : null; }

  // 価格を1ステップ進める（st: { price, center, rng }）。ニュースが出たらその文面を返す
  function stepPrice(k, st) {
    const c = INSTRUMENTS[k], r = st.rng;
    let news = null;
    st.center += (r() - 0.5) * c.drift + (c.start - st.center) * c.longRevert;
    if (c.jumpProb && r() < c.jumpProb) {
      const up = r() < 0.5;
      st.center += (up ? 1 : -1) * (c.jumpMin + r() * (c.jumpMax - c.jumpMin));
      const list = up ? NEWS_UP : NEWS_DOWN;
      news = list[Math.floor(r() * list.length)];
    }
    const lim = limitsOf(k);
    if (lim) st.center = clamp(st.center, lim[0], lim[1]);
    const burst = r() < c.burstProb ? (r() - 0.5) * c.burstSize : 0;
    st.price += (st.center - st.price) * c.revert + gaussR(r) * c.noise + burst;
    st.price = lim ? clamp(st.price, lim[0], lim[1]) : Math.max(c.floor, st.price);
    return news;
  }
  function stepEngine(k, t) {
    const e = engines[k];
    const news = stepPrice(k, e);
    if (news && !backfilling) newsQueue.push({ at: t + DELAY_MS, text: news });
    const p = e.price;
    e.ticks.push({ t, p });
    if (e.ticks.length > 520) e.ticks.splice(0, e.ticks.length - 420);
    const bt = Math.floor(t / 1000) * 1000;
    const last = e.bars[e.bars.length - 1];
    if (!last || last.t !== bt) e.bars.push({ t: bt, o: p, h: p, l: p, c: p, n: 1 });
    else { if (p > last.h) last.h = p; if (p < last.l) last.l = p; last.c = p; last.n++; }
    if (e.bars.length > MAX_BARS + 600) e.bars.splice(0, 600);
  }

  function priceAt(k, t) {
    const ts = engines[k].ticks;
    for (let i = ts.length - 1; i >= 0; i--) if (ts[i].t <= t) return ts[i].p;
    return ts.length ? ts[0].p : engines[k].price;
  }

  // ---- 相場時刻の管理 ----
  const GRID_START = -(BACKFILL_MS + DELAY_MS + 5000);   // 過去チャート用に、開始点の8時間前から生成
  let marketSeed = 0, marketEpoch = 0, nextM = GRID_START;
  const roundTrades = [];   // このラウンドで決済した取引の記録
  let clockM = null;   // ラウンド終了処理中だけ、相場時刻を「終了時刻ちょうど」に固定する
  function currentM() { return clockM !== null ? clockM : Date.now() - marketEpoch; }
  function advanceTo(m) {
    while (nextM <= m) {
      const t = marketEpoch + nextM;
      SYM_KEYS.forEach(k => stepEngine(k, t));
      nextM += TICK_MS;
    }
  }
  // seed の相場を作り、今この瞬間を相場時刻 startM に合わせる
  function initMarket(seed, startM) {
    marketSeed = seed >>> 0;
    marketEpoch = Date.now() - startM;
    nextM = GRID_START;
    SYM_KEYS.forEach(k => { engines[k] = freshEngine(k, marketSeed); });
    newsQueue.length = 0;
    SYM_KEYS.forEach(k => { if (drawingsBySym[k]) drawingsBySym[k].length = 0; });
    backfilling = true;
    advanceTo(startM);
    backfilling = false;
    updatePub(Date.now(), true);
  }

  // 表の現在値（30秒前）とスプレッド。取引に関わる値はすべてここから
  function updatePub(now, quiet) {
    SYM_KEYS.forEach(k => {
      const c = INSTRUMENTS[k], e = engines[k];
      const cut = now - DELAY_MS;
      e.pub = priceAt(k, cut);
      const vol = Math.abs(e.pub - priceAt(k, cut - 1000));
      const target = 1 + Math.min(4, Math.max(0, (vol / c.volRef - 1) * 1.5));
      e.spreadMult += (target - e.spreadMult) * (target > e.spreadMult ? 0.6 : 0.08);
      const lim = limitsOf(k);
      if (lim) {
        const st = e.pub >= lim[1] - 1e-9 ? 1 : e.pub <= lim[0] + 1e-9 ? -1 : 0;
        if (st !== e.limitState) {
          e.limitState = st;
          if (!quiet && st === 1) { pushNews("【ストップ高】トキワープHD、買い注文が殺到しストップ高。売り物がありません。"); toast("トキワープHDがストップ高になりました", "warn"); }
          if (!quiet && st === -1) { pushNews("【ストップ安】トキワープHD、売りが売りを呼びストップ安。買い手が見当たりません。"); toast("トキワープHDがストップ安になりました", "warn"); }
        }
      }
    });
  }
  function spreadOf(k) { const c = INSTRUMENTS[k]; return Math.max(c.spread, roundTo(c.spread * engines[k].spreadMult, c.tick)); }
  function bidOf(k) {
    const c = INSTRUMENTS[k], lim = limitsOf(k);
    let b = roundTo(engines[k].pub - spreadOf(k) / 2, c.tick);
    return lim ? clamp(b, lim[0], lim[1]) : b;
  }
  function askOf(k) {
    const c = INSTRUMENTS[k], lim = limitsOf(k);
    let a = roundTo(engines[k].pub + spreadOf(k) / 2, c.tick);
    if (a <= bidOf(k)) a = bidOf(k) + c.tick;
    return lim ? clamp(a, lim[0], lim[1]) : a;
  }
  // 挑戦状で同じ条件になるよう、運ではなく「その瞬間のスプレッドの広がり具合」だけで決める
  function slippage(k) {
    const c = INSTRUMENTS[k], m = engines[k].spreadMult;
    if (m < 1.4) return 0;
    return roundTo((m - 1) * c.spread * 0.4, c.tick);
  }

  // ======================= 口座・注文の状態 =======================
  let currentSym = "crnjpy";
  let balance = START_BALANCE;
  let realized = 0;
  let positions = [];
  let orders = [];
  let seq = 1;
  const stats = { trades: 0, wins: 0, futureTrades: 0, maxWin: 0, maxLoss: 0 };
  const FUTURE_MAX_SEC = 30;      // 未来視点を連続でONにできる最大秒数
  const FUTURE_COOLDOWN_SEC = 60; // OFFになってから再びONにできるまでの秒数
  let futureState = "ready";      // "ready" | "active" | "cooldown"
  let futureRemain = FUTURE_MAX_SEC;
  let futureVisible = false;
  let chartType = "candle";
  const indOn = { ma20: true, ma50: false, bb: false, vol: true };
  const view = { tf: 1, bars: 90, offset: 0 };
  const drawingsBySym = {};
  SYM_KEYS.forEach(k => { drawingsBySym[k] = []; });
  const order = { type: "market", dir: "buy", qty: {}, tpOn: false, slOn: false };
  SYM_KEYS.forEach(k => { order.qty[k] = INSTRUMENTS[k].defaultLot; });

  let bestBalance = START_BALANCE;
  try { const s = window.localStorage.getItem("futurefx_best_v7"); if (s) bestBalance = Math.max(bestBalance, parseFloat(s) || START_BALANCE); } catch (e) {}

  // ======================= 通知・ニュース =======================
  const toastWrap = $("toastWrap");
  // ======================= 効果音・振動 =======================
  // 音声ファイルは使わず、Web Audio で短い音を合成する。最初の操作までは鳴らさない（ブラウザの仕様）
  let soundOn = true;
  try { soundOn = window.localStorage.getItem("futurefx_sound") !== "off"; } catch (e) {}
  let actx = null;
  function audio() {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; try { actx = new AC(); } catch (e) { return null; } }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  document.addEventListener("pointerdown", () => { if (soundOn) audio(); }, { once: true });
  function tone(freq, start, dur, type, vol, freqEnd) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime + start;
    o.type = type || "sine"; o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function buzz(pattern) { if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} } }
  function sfx(type) {
    if (!soundOn) return;
    switch (type) {
      case "open": tone(660, 0, 0.09, "triangle", 0.1, 880); buzz(15); break;
      case "win": tone(784, 0, 0.1, "triangle", 0.11); tone(1175, 0.08, 0.16, "triangle", 0.11); buzz(25); break;
      case "loss": tone(392, 0, 0.12, "sawtooth", 0.05, 262); buzz([20, 30, 20]); break;
      case "tick": tone(1320, 0, 0.05, "square", 0.04); break;
      case "end": [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.5, "triangle", 0.08)); buzz([60, 40, 90]); break;
      case "ability": tone(440, 0, 0.35, "sine", 0.09, 1760); buzz(30); break;
      case "err": tone(180, 0, 0.14, "square", 0.04); break;
    }
  }
  function renderSoundBtn() { const b = $("soundBtn"); if (b) { b.textContent = soundOn ? "🔊" : "🔇"; b.title = soundOn ? "効果音：ON" : "効果音：OFF"; } }

  function toast(msg, kind) {
    if (kind === "err") sfx("err");
    const d = document.createElement("div");
    d.className = "toast " + (kind || "");
    d.textContent = msg;
    toastWrap.appendChild(d);
    while (toastWrap.children.length > 4) toastWrap.firstChild.remove();
    setTimeout(() => d.classList.add("out"), 3400);
    setTimeout(() => d.remove(), 3800);
  }
  const newsTextEl = $("newsText");
  const NEWS_LINES = [
    "未来が見えるトレーダーが1名、この端末に出現した模様。",
    "市場関係者「30秒あれば十分」との声、真偽は不明。",
    "スプレッドという名の刺客が、今日もあなたを待っている。",
    "トキワープHD、本日も値動きという概念を試している模様。",
    "証拠金維持率、未来からは救ってくれません。"
  ];
  let newsIdx = 0, newsHoldUntil = 0;
  function pushNews(text) { newsTextEl.textContent = text; newsHoldUntil = Date.now() + 8000; }
  setInterval(() => {
    if (Date.now() < newsHoldUntil) return;
    newsIdx = (newsIdx + 1) % NEWS_LINES.length;
    newsTextEl.textContent = NEWS_LINES[newsIdx];
  }, 9000);

  // ======================= 取引ロジック =======================
  function requiredMargin(k, units, price) { return (units * price) / INSTRUMENTS[k].leverage; }
  function usedMargin() { return positions.reduce((s, p) => s + p.margin, 0); }
  function exitPriceOf(p) { return p.dir === "buy" ? bidOf(p.sym) : askOf(p.sym); }
  function pricePnl(p, exit) { return (exit - p.entry) * p.units * (p.dir === "buy" ? 1 : -1); }
  function markPnl(p) { return pricePnl(p, exitPriceOf(p)) + p.swap; }
  function floatingTotal() { return positions.reduce((s, p) => s + markPnl(p), 0); }
  function freeMargin() { return balance + floatingTotal() - usedMargin(); }

  // ストップ高・ストップ安では反対側の注文がなく約定しない
  function blockedByLimit(k, dir) {
    const e = engines[k];
    if (e.limitState === 1 && dir === "buy") return "ストップ高のため買い注文は約定しませんでした（売り物がありません）";
    if (e.limitState === -1 && dir === "sell") return "ストップ安のため売り注文は約定しませんでした（買い手がいません）";
    return null;
  }

  function openPosition(k, dir, units, price, tp, sl, how, slip) {
    if (challengeOver) { toast("挑戦は終了しました。「もう一度挑戦」か「普通に遊ぶ」を選んでください", "err"); return false; }
    const margin = requiredMargin(k, units, price);
    if (margin > freeMargin()) { toast("証拠金が不足しているため約定できませんでした", "err"); return false; }
    positions.push({ id: seq++, sym: k, dir, units, entry: price, margin, tp: tp ?? null, sl: sl ?? null, swap: 0, futureOn: futureVisible, om: currentM() });
    let msg = `${how} ${dirJ(dir)} ${INSTRUMENTS[k].code} ${fmtQty(k, units)} を ${fmtP(k, price)} で約定`;
    if (slip) msg += `（スリッページ ${fmtSlip(k, slip)}）`;
    toast(msg, dir);
    sfx("open");
    renderPositions();
    return true;
  }

  function marketOrder(k, dir, units, tp, sl, how) {
    const blocked = blockedByLimit(k, dir);
    if (blocked) { toast(blocked, "err"); return false; }
    const slip = slippage(k);
    const lim = limitsOf(k);
    let price = dir === "buy" ? askOf(k) + slip : bidOf(k) - slip;
    if (lim) price = clamp(price, lim[0], lim[1]);
    return openPosition(k, dir, units, price, tp, sl, how || "成行", slip);
  }

  function closeAt(p, exit, reason) {
    const idx = positions.indexOf(p);
    if (idx === -1) return;
    const pnl = pricePnl(p, exit) + p.swap;
    realized += pnl;
    balance += pnl;
    positions.splice(idx, 1);
    stats.trades++;
    if (pnl > 0) stats.wins++;
    if (p.futureOn) stats.futureTrades++;
    stats.maxWin = Math.max(stats.maxWin, pnl);
    stats.maxLoss = Math.min(stats.maxLoss, pnl);
    addHistoryRow(p, exit, pnl, reason);
    // 取引の記録（結果の振り返りチャートと、ランキングの検証に使う）
    roundTrades.push({ k: p.sym, d: p.dir, u: p.units, em: p.om, ep: p.entry, xm: currentM(), xp: exit, sw: p.swap, fut: !!p.futureOn });
    if (balance > bestBalance) {
      bestBalance = balance;
      try { window.localStorage.setItem("futurefx_best_v7", String(bestBalance)); } catch (e) {}
    }
    sfx(pnl >= 0 ? "win" : "loss");
    toast(`${reason}：${dirJ(p.dir)} ${INSTRUMENTS[p.sym].code} ${fmtQty(p.sym, p.units)} を ${fmtP(p.sym, exit)} で決済 ${fmtSYen(pnl)}`, pnl >= 0 ? "buy" : "sell");
  }

  function closeManual(p) {
    const closeDir = p.dir === "buy" ? "sell" : "buy";
    const blocked = blockedByLimit(p.sym, closeDir);
    if (blocked) { toast(blocked.replace("注文", "決済注文"), "err"); return; }
    const slip = slippage(p.sym);
    const exit = p.dir === "buy" ? bidOf(p.sym) - slip : askOf(p.sym) + slip;
    closeAt(p, exit, "決済");
    renderPositions();
  }

  function validBracket(k, dir, kind, price, ref) {
    if (kind === "tp") return dir === "buy" ? price > ref : price < ref;
    return dir === "buy" ? price < ref : price > ref;
  }
  function validOrderPrice(k, type, dir, price) {
    const bid = bidOf(k), ask = askOf(k);
    if (type === "limit") return dir === "buy" ? price < ask : price > bid;
    return dir === "buy" ? price > ask : price < bid;
  }

  function processTriggers() {
    // 指値・逆指値
    orders.slice().forEach(o => {
      const bid = bidOf(o.sym), ask = askOf(o.sym);
      let hit = false, fillPrice = null;
      if (o.type === "limit") {
        if (o.dir === "buy" && ask <= o.price) { hit = true; fillPrice = Math.min(o.price, ask); }
        if (o.dir === "sell" && bid >= o.price) { hit = true; fillPrice = Math.max(o.price, bid); }
      } else {
        if (o.dir === "buy" && ask >= o.price) hit = true;
        if (o.dir === "sell" && bid <= o.price) hit = true;
      }
      if (!hit) return;
      const blocked = blockedByLimit(o.sym, o.dir);
      if (blocked) return; // 値幅制限中は待機
      orders.splice(orders.indexOf(o), 1);
      if (o.type === "limit") openPosition(o.sym, o.dir, o.units, fillPrice, o.tp, o.sl, "指値", 0);
      else marketOrder(o.sym, o.dir, o.units, o.tp, o.sl, "逆指値");
      renderPositions();
    });
    // 利確・損切
    let changed = false;
    positions.slice().forEach(p => {
      const bid = bidOf(p.sym), ask = askOf(p.sym);
      if (p.dir === "buy") {
        if (p.tp !== null && bid >= p.tp) { closeAt(p, Math.max(p.tp, bid), "利確"); changed = true; }
        else if (p.sl !== null && bid <= p.sl && !blockedByLimit(p.sym, "sell")) { closeAt(p, bid - slippage(p.sym), "損切"); changed = true; }
      } else {
        if (p.tp !== null && ask <= p.tp) { closeAt(p, Math.min(p.tp, ask), "利確"); changed = true; }
        else if (p.sl !== null && ask >= p.sl && !blockedByLimit(p.sym, "buy")) { closeAt(p, ask + slippage(p.sym), "損切"); changed = true; }
      }
    });
    if (changed) renderPositions();
  }

  function accrueCarry(dt) {
    positions.forEach(p => {
      const c = INSTRUMENTS[p.sym];
      const rate = p.dir === "buy" ? c.rateBuy : c.rateSell;
      p.swap += p.units * p.entry * rate * dt / 86400000;
    });
  }

  function checkLosscut() {
    const um = usedMargin();
    if (um <= 0) return;
    if ((balance + floatingTotal()) / um < 0.5) {
      positions.slice().forEach(p => closeAt(p, exitPriceOf(p), "ロスカット"));
      renderPositions();
      pushNews("【ロスカット】証拠金維持率が50%を割り込み、全建玉が強制決済されました。未来は見えていたはずですが…");
      toast("証拠金維持率が50%を下回ったため、ロスカットされました", "err");
    }
  }

  // ======================= 建玉・注文・履歴の表示 =======================
  const openBody = $("openBody"), ordersBody = $("ordersBody"), historyBody = $("historyBody");
  function symCell(sym, dir) {
    return '<span class="dir-tag ' + dir + '">' + dirJ(dir) + '</span><span class="mono">' + INSTRUMENTS[sym].code + "</span>";
  }
  function renderPositions() {
    openBody.innerHTML = "";
    if (!positions.length) openBody.innerHTML = '<tr><td class="empty-row" colspan="5">建玉はありません</td></tr>';
    positions.forEach(p => {
      const tr = document.createElement("tr");
      let brk = "";
      if (p.tp !== null) brk += '<span>利 ' + fmtP(p.sym, p.tp) + '<span class="x" data-clear="tp">×</span></span> ';
      if (p.sl !== null) brk += '<span>損 ' + fmtP(p.sym, p.sl) + '<span class="x" data-clear="sl">×</span></span>';
      tr.innerHTML =
        "<td>" + symCell(p.sym, p.dir) + "</td>" +
        '<td class="mono">' + p.units.toLocaleString("ja-JP") + "</td>" +
        '<td class="mono">' + fmtP(p.sym, p.entry) + (brk ? '<span class="brk mono">' + brk + "</span>" : "") + "</td>" +
        '<td class="mono" data-pnl="' + p.id + '">¥0</td><td></td>';
      tr.querySelectorAll("[data-clear]").forEach(x => x.addEventListener("click", () => {
        p[x.dataset.clear] = null;
        toast((x.dataset.clear === "tp" ? "利確" : "損切") + "を取り消しました", "warn");
        renderPositions();
      }));
      const b = document.createElement("button");
      b.className = "mini-btn"; b.textContent = "決済";
      b.addEventListener("click", () => closeManual(p));
      tr.lastElementChild.appendChild(b);
      openBody.appendChild(tr);
    });
    ordersBody.innerHTML = "";
    if (!orders.length) ordersBody.innerHTML = '<tr><td class="empty-row" colspan="5">注文はありません</td></tr>';
    orders.forEach(o => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + symCell(o.sym, o.dir) + "</td>" +
        "<td>" + (o.type === "limit" ? "指値" : "逆指値") + "</td>" +
        '<td class="mono">' + o.units.toLocaleString("ja-JP") + "</td>" +
        '<td class="mono">' + fmtP(o.sym, o.price) + "</td><td></td>";
      const b = document.createElement("button");
      b.className = "mini-btn"; b.textContent = "取消";
      b.addEventListener("click", () => { orders.splice(orders.indexOf(o), 1); toast("注文を取り消しました", "warn"); renderPositions(); });
      tr.lastElementChild.appendChild(b);
      ordersBody.appendChild(tr);
    });
    updateOpenPnl();
  }
  function updateOpenPnl() {
    positions.forEach(p => {
      const cell = openBody.querySelector('[data-pnl="' + p.id + '"]');
      if (!cell) return;
      const v = markPnl(p);
      cell.textContent = fmtSYen(v);
      cell.className = "mono " + (v >= 0 ? "pos" : "neg");
      cell.title = INSTRUMENTS[p.sym].carryLabel + " " + fmtSYen(p.swap);
    });
  }
  function resetHistory() { historyBody.innerHTML = '<tr><td class="empty-row" colspan="4">まだ決済履歴はありません</td></tr>'; }
  function addHistoryRow(p, exit, pnl, reason) {
    if (historyBody.querySelector(".empty-row")) historyBody.innerHTML = "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + symCell(p.sym, p.dir) + "</td>" +
      '<td class="mono">' + p.units.toLocaleString("ja-JP") + "</td>" +
      '<td class="mono">' + fmtP(p.sym, p.entry) + "→" + fmtP(p.sym, exit) + "</td>" +
      '<td class="mono ' + (pnl >= 0 ? "pos" : "neg") + '">' + fmtSYen(pnl) + '<span class="reason">' + reason + "</span></td>";
    historyBody.prepend(tr);
    while (historyBody.children.length > 60) historyBody.lastChild.remove();
  }

  function setSigned(el, v) { el.textContent = fmtSYen(v); el.style.color = v > 0 ? "var(--buy)" : v < 0 ? "var(--sell)" : "var(--text)"; }
  function updateStats() {
    const fl = floatingTotal();
    setSigned($("floatingPnl"), fl);
    setSigned($("realizedPnl"), realized);
    $("balanceVal").textContent = fmtYen(balance);
    const um = usedMargin();
    $("marginLevel").textContent = um > 0 ? Math.round(((balance + fl) / um) * 100) + "%" : "---%";
    $("winRate").textContent = stats.trades ? Math.round((stats.wins / stats.trades) * 100) + "%（" + stats.trades + "回）" : "---";
  }

  // ======================= 注文パネル =======================
  const qtyInput = $("qtyInput"), priceInput = $("priceInput"), tpInput = $("tpInput"), slInput = $("slInput");
  const submitBtn = $("submitBtn");
  function refPrice() {
    const k = currentSym;
    if (order.type === "market") return order.dir === "buy" ? askOf(k) : bidOf(k);
    const v = parseFloat(priceInput.value);
    return isFinite(v) ? v : engines[k].pub;
  }
  function setDefaultOrderPrice() {
    const k = currentSym, c = INSTRUMENTS[k], pub = engines[k].pub;
    const below = (order.type === "limit") === (order.dir === "buy");
    priceInput.value = fmtIn(k, roundTo(pub + (below ? -c.orderOffset : c.orderOffset), c.tick));
  }
  function setDefaultBracket(which) {
    const k = currentSym, c = INSTRUMENTS[k], ref = refPrice(), s = order.dir === "buy" ? 1 : -1;
    if (which === "tp") tpInput.value = fmtIn(k, roundTo(ref + s * c.tpOffset, c.tick));
    if (which === "sl") slInput.value = fmtIn(k, roundTo(ref - s * c.slOffset, c.tick));
  }
  function renderLots() {
    const k = currentSym, row = $("lotRow");
    row.innerHTML = "";
    INSTRUMENTS[k].lots.forEach(u => {
      const b = document.createElement("button");
      b.className = "lot-btn" + (u === order.qty[k] ? " active" : "");
      b.textContent = fmtQty(k, u);
      b.addEventListener("click", () => { order.qty[k] = u; qtyInput.value = u; renderLots(); updateOrderPanel(); });
      row.appendChild(b);
    });
  }
  function setOrderType(t) {
    order.type = t;
    $("orderTypeSeg").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.t === t));
    $("priceRow").hidden = t === "market";
    $("priceLabel").textContent = t === "limit" ? "指値価格" : "逆指値価格";
    if (t !== "market") setDefaultOrderPrice();
    if (order.tpOn) setDefaultBracket("tp");
    if (order.slOn) setDefaultBracket("sl");
    updateOrderPanel();
  }
  function setDirection(d) {
    order.dir = d;
    $("btnDirBuy").classList.toggle("active", d === "buy");
    $("btnDirSell").classList.toggle("active", d === "sell");
    if (order.type !== "market") setDefaultOrderPrice();
    if (order.tpOn) setDefaultBracket("tp");
    if (order.slOn) setDefaultBracket("sl");
    updateOrderPanel();
  }
  $("orderTypeSeg").querySelectorAll("button").forEach(b => b.addEventListener("click", () => setOrderType(b.dataset.t)));
  $("btnDirBuy").addEventListener("click", () => setDirection("buy"));
  $("btnDirSell").addEventListener("click", () => setDirection("sell"));
  qtyInput.addEventListener("input", () => {
    const v = parseInt(qtyInput.value, 10);
    if (isFinite(v)) order.qty[currentSym] = v;
    renderLots(); updateOrderPanel();
  });
  [priceInput, tpInput, slInput].forEach(i => i.addEventListener("input", updateOrderPanel));
  $("tpOn").addEventListener("change", (e) => { order.tpOn = e.target.checked; tpInput.disabled = !order.tpOn; if (order.tpOn) setDefaultBracket("tp"); updateOrderPanel(); });
  $("slOn").addEventListener("change", (e) => { order.slOn = e.target.checked; slInput.disabled = !order.slOn; if (order.slOn) setDefaultBracket("sl"); updateOrderPanel(); });

  function updateOrderPanel() {
    const k = currentSym, c = INSTRUMENTS[k];
    $("dirSellPx").textContent = fmtP(k, bidOf(k));
    $("dirBuyPx").textContent = fmtP(k, askOf(k));
    const units = order.qty[k];
    const ref = refPrice();
    $("execLabel").textContent = order.type === "market" ? "発注レート" : "注文価格";
    $("execPriceLabel").textContent = fmtP(k, ref);
    const m = requiredMargin(k, units || 0, ref);
    $("marginLabel").textContent = fmtYen(m);
    const free = freeMargin();
    $("freeMarginLabel").textContent = fmtYen(free);
    const s = order.dir === "buy" ? 1 : -1;
    const parts = [];
    const tp = parseFloat(tpInput.value), sl = parseFloat(slInput.value);
    if (order.tpOn && isFinite(tp)) parts.push("利確時 " + fmtSYen((tp - ref) * units * s));
    if (order.slOn && isFinite(sl)) parts.push("損切時 " + fmtSYen((sl - ref) * units * s));
    $("bracketHint").textContent = parts.join(" / ");
    const typeJ = order.type === "market" ? "成行" : order.type === "limit" ? "指値" : "逆指値";
    submitBtn.textContent = (order.dir === "buy" ? "買い" : "売り") + " " + typeJ + "注文";
    submitBtn.className = "go-btn " + order.dir;
    submitBtn.disabled = !units || units <= 0 || (order.type === "market" && m > free);
  }

  function validQty(k, u) {
    const c = INSTRUMENTS[k];
    if (!isFinite(u) || u < c.minUnit || u > c.maxUnit || u % c.minUnit !== 0) {
      toast("数量は" + fmtQty(k, c.minUnit) + "単位（最大" + fmtQty(k, c.maxUnit) + "）で入力してください", "err");
      return false;
    }
    return true;
  }
  submitBtn.addEventListener("click", () => {
    if (challengeOver) { toast("挑戦は終了しました。「もう一度挑戦」か「普通に遊ぶ」を選んでください", "err"); return; }
    const k = currentSym, units = order.qty[k], dir = order.dir;
    if (!validQty(k, units)) return;
    const ref = refPrice();
    let tp = null, sl = null;
    if (order.tpOn) { tp = parseFloat(tpInput.value); if (!isFinite(tp) || !validBracket(k, dir, "tp", tp, ref)) { toast("利確価格が不正です（" + (dir === "buy" ? "注文価格より上" : "注文価格より下") + "に設定してください）", "err"); return; } }
    if (order.slOn) { sl = parseFloat(slInput.value); if (!isFinite(sl) || !validBracket(k, dir, "sl", sl, ref)) { toast("損切価格が不正です（" + (dir === "buy" ? "注文価格より下" : "注文価格より上") + "に設定してください）", "err"); return; } }
    if (order.type === "market") { marketOrder(k, dir, units, tp, sl); updateOrderPanel(); return; }
    const price = parseFloat(priceInput.value);
    if (!isFinite(price) || !validOrderPrice(k, order.type, dir, price)) {
      const want = order.type === "limit" ? (dir === "buy" ? "現在の買値より下" : "現在の売値より上") : (dir === "buy" ? "現在の買値より上" : "現在の売値より下");
      toast((order.type === "limit" ? "指値" : "逆指値") + "価格は" + want + "に設定してください", "err");
      return;
    }
    orders.push({ id: seq++, sym: k, type: order.type, dir, units, price, tp, sl });
    toast((order.type === "limit" ? "指値" : "逆指値") + "注文を受け付けました：" + dirJ(dir) + " " + fmtQty(k, units) + " @" + fmtP(k, price), "warn");
    renderPositions();
  });

  // ワンクリック注文（チャート左上の価格ボックス）
  $("qSell").addEventListener("click", () => { if (validQty(currentSym, order.qty[currentSym])) marketOrder(currentSym, "sell", order.qty[currentSym], null, null, "ワンクリック"); });
  $("qBuy").addEventListener("click", () => { if (validQty(currentSym, order.qty[currentSym])) marketOrder(currentSym, "buy", order.qty[currentSym], null, null, "ワンクリック"); });

  $("closeAllBtn").addEventListener("click", () => { positions.slice().forEach(p => closeManual(p)); renderPositions(); });
  $("cancelAllBtn").addEventListener("click", () => { if (orders.length) toast("注文をすべて取り消しました", "warn"); orders = []; renderPositions(); });
  function resetAccount() {
    roundTrades.length = 0;
    balance = START_BALANCE; realized = 0; positions = []; orders = [];
    Object.assign(stats, { trades: 0, wins: 0, futureTrades: 0, maxWin: 0, maxLoss: 0 });
    resetHistory(); renderPositions(); updateOrderPanel();
  }
  // 中断・リセットなど取り消せない操作は、3秒以内にもう一度押したときだけ実行する（誤操作防止）
  let abortArmedUntil = 0;
  function armed(msg) {
    if (Date.now() <= abortArmedUntil) { abortArmedUntil = 0; return true; }
    abortArmedUntil = Date.now() + 3000; toast(msg, "warn"); return false;
  }
  $("resetBtn").addEventListener("click", () => {
    if (challenge && challenge.mode === "ta") {
      if (challengeOver) { exitChallenge(); return; }
      if (!armed("もう一度押すとタイムアタックを中断します")) return;
      exitChallenge(); toast("タイムアタックを中断しました", "warn"); return;
    }
    if (challenge) {
      if (!challengeOver && !armed("もう一度押すと、同じ相場で最初から挑戦し直します")) return;
      startChallenge(challenge); toast("同じ相場で、最初から挑戦し直します", "warn"); return;
    }
    if (!armed("もう一度押すと資産を100万円にリセットします（建玉・注文・成績は消えます）")) return;
    resetAccount();
    roundStartM = currentM();   // 挑戦状URLは、ここから先のプレイ区間で作られる
    toast("資産を100万円にリセットしました", "warn");
  });

  // ======================= 板（株のみ） =======================
  function renderBoard() {
    const k = currentSym, c = INSTRUMENTS[k], e = engines[k];
    const card = $("boardCard");
    if (c.kind !== "stock") { card.hidden = true; return; }
    card.hidden = false;
    const lim = limitsOf(k), bid = bidOf(k), ask = askOf(k);
    const q = (px) => {
      let v = e.book.get(px);
      if (v === undefined || Math.random() < 0.12) { v = (1 + Math.floor(Math.random() * Math.random() * 60)) * 100; e.book.set(px, v); }
      return v;
    };
    if (e.book.size > 200) e.book.clear();
    const badge = $("boardBadge");
    badge.hidden = e.limitState === 0;
    badge.className = "badge " + (e.limitState === 1 ? "up" : "down");
    badge.textContent = e.limitState === 1 ? "ストップ高" : "ストップ安";
    let html = "";
    for (let i = 4; i >= 0; i--) {
      const px = ask + i * c.tick;
      const noSell = e.limitState === 1 || px > lim[1];
      html += '<tr class="ask' + (i === 0 && !noSell ? " best" : "") + '"><td class="q mono">' + (noSell ? "" : q(px).toLocaleString("ja-JP")) +
        '</td><td class="px mono">' + (px > lim[1] ? "" : fmtP(k, px)) + "</td><td></td></tr>";
    }
    for (let i = 0; i < 5; i++) {
      const px = bid - i * c.tick;
      const noBuy = e.limitState === -1 || px < lim[0];
      let qty = noBuy ? "" : q(px).toLocaleString("ja-JP");
      if (e.limitState === 1 && i === 0) qty = '<span class="tokubai">特</span>' + (1200000 + Math.floor(Math.random() * 90000) * 10).toLocaleString("ja-JP");
      html += '<tr class="bid' + (i === 0 ? " best" : "") + '"><td></td><td class="px mono">' + (px < lim[0] ? "" : fmtP(k, px)) +
        '</td><td class="q mono">' + qty + "</td></tr>";
    }
    $("boardBody").innerHTML = html;
  }

  // ======================= 上部メニュー =======================
  const symMenu = $("symMenu"), ctMenu = $("chartTypeMenu"), indMenu = $("indMenu"), toolFlyout = $("toolFlyout"), moreMenu = $("moreMenu");
  const menus = [symMenu, ctMenu, indMenu, toolFlyout, moreMenu];
  function toggleMenu(m, e) { e.stopPropagation(); const open = !m.classList.contains("open"); menus.forEach(x => x.classList.remove("open")); if (open) m.classList.add("open"); }
  document.addEventListener("click", () => menus.forEach(x => x.classList.remove("open")));
  [symMenu, ctMenu, indMenu, toolFlyout].forEach(m => m.addEventListener("click", (e) => e.stopPropagation()));
  // スマホ用「⋯」メニュー：中身は上部のボタン（スマホでは非表示）をそのまま押す
  $("moreBtn").addEventListener("click", (e) => {
    $("moreReset").textContent = $("resetBtn").textContent;
    $("moreReset").disabled = $("resetBtn").disabled;
    $("moreSound").textContent = soundOn ? "効果音：ON（タップでOFF）" : "効果音：OFF（タップでON）";
    toggleMenu(moreMenu, e);
  });
  [["moreReset", "resetBtn"], ["moreSound", "soundBtn"], ["moreHelp", "helpBtn"]].forEach(([m, t]) =>
    $(m).addEventListener("click", () => { moreMenu.classList.remove("open"); $(t).click(); }));

  SYM_KEYS.forEach(k => {
    const c = INSTRUMENTS[k];
    const b = document.createElement("button");
    b.className = "dd-item"; b.dataset.sym = k;
    b.innerHTML = '<span class="mono">' + c.code + "</span> " + c.name + '<span class="sub">' + (c.kind === "fx" ? "FX" : "株・荒い") + "</span>";
    b.addEventListener("click", () => { switchSymbol(k); symMenu.classList.remove("open"); });
    symMenu.appendChild(b);
  });
  $("symBtn").addEventListener("click", (e) => toggleMenu(symMenu, e));

  CHART_TYPES.forEach(ct => {
    const b = document.createElement("button");
    b.className = "dd-item" + (ct.t === chartType ? " active" : "");
    b.textContent = ct.label;
    b.addEventListener("click", () => {
      chartType = ct.t; $("chartTypeLabel").textContent = ct.label;
      ctMenu.querySelectorAll(".dd-item").forEach(x => x.classList.toggle("active", x === b));
      ctMenu.classList.remove("open"); requestDraw();
    });
    ctMenu.appendChild(b);
  });
  $("chartTypeBtn").addEventListener("click", (e) => toggleMenu(ctMenu, e));

  INDICATORS.forEach(ind => {
    const b = document.createElement("button");
    b.className = "dd-item" + (indOn[ind.id] ? " on" : "");
    b.innerHTML = '<span class="chk">' + (indOn[ind.id] ? "✓" : "") + "</span>" + ind.label + '<span class="sub"><i class="swatch-line" style="background:' + ind.color + '"></i></span>';
    b.addEventListener("click", () => {
      indOn[ind.id] = !indOn[ind.id];
      b.classList.toggle("on", indOn[ind.id]);
      b.querySelector(".chk").textContent = indOn[ind.id] ? "✓" : "";
      requestDraw();
    });
    indMenu.appendChild(b);
  });
  $("indBtn").addEventListener("click", (e) => toggleMenu(indMenu, e));

  const tfPills = $("tfPills");
  TFS.forEach(tf => {
    const b = document.createElement("button");
    b.className = "tf-pill" + (tf.sec === view.tf ? " active" : "");
    b.textContent = tf.label;
    b.addEventListener("click", () => {
      view.tf = tf.sec; view.bars = 90; view.offset = 0;
      tfPills.querySelectorAll(".tf-pill").forEach(x => x.classList.toggle("active", x === b));
      updateChartMeta(); requestDraw();
    });
    tfPills.appendChild(b);
  });

  function updateFutureButton() {
    const html = '<span class="dot"></span>' + (futureState === "ready" ? "未来視点を使う"
      : futureState === "active" ? "未来視点 ON（残り" + Math.ceil(futureRemain) + "秒）"
      : "クールダウン " + Math.ceil(futureRemain) + "秒");
    ["futureToggle", "mFuture"].forEach(id => {   // 上部のボタンと、スマホの操作バーのボタン
      const b = $(id);
      b.disabled = futureState === "cooldown";
      b.classList.toggle("off", futureState !== "active");
      if (b.innerHTML !== html) b.innerHTML = html;
    });
  }
  function endFutureView() {
    futureState = "cooldown"; futureVisible = false; futureRemain = FUTURE_COOLDOWN_SEC;
    renderLegend(); updateFutureButton(); requestDraw();
  }
  function tickFutureAbility(dt) {
    const sec = dt / 1000;
    if (futureState === "active") {
      futureRemain -= sec;
      if (futureRemain <= 0) { endFutureView(); toast("未来視点の残り時間が切れました。" + FUTURE_COOLDOWN_SEC + "秒のクールダウンに入ります", "warn"); return; }
    } else if (futureState === "cooldown") {
      futureRemain -= sec;
      if (futureRemain <= 0) { futureState = "ready"; futureRemain = FUTURE_MAX_SEC; toast("未来視点が再び使えるようになりました", "buy"); }
    }
    updateFutureButton();
  }
  $("mFuture").addEventListener("click", () => $("futureToggle").click());
  $("futureToggle").addEventListener("click", () => {
    stopCoach();
    if (futureState === "ready") {
      futureState = "active"; futureVisible = true; futureRemain = FUTURE_MAX_SEC;
      sfx("ability");
      renderLegend(); updateFutureButton(); requestDraw();
    } else if (futureState === "active") {
      endFutureView();
    }
  });
  function renderLegend() {
    $("legendRow").innerHTML = futureVisible
      ? '<span><i class="sw candle-up"></i>陽線／<i class="sw candle-down"></i>陰線＝みんなに見えている「現在」</span><span><i class="sw dash"></i>破線＝あなたにだけ見える30秒先の「未来」</span>'
      : '<span><i class="sw candle-up"></i>陽線（上昇）</span><span><i class="sw candle-down"></i>陰線（下落）</span>';
  }

  function updateChartMeta() {
    const c = INSTRUMENTS[currentSym];
    $("chName").textContent = c.name;
    $("chMeta").textContent = "· " + c.code + " · " + TFS.find(t => t.sec === view.tf).label;
  }

  function switchSymbol(k) {
    currentSym = k;
    const c = INSTRUMENTS[k];
    $("symBtnLabel").textContent = c.code;
    $("orderTitle").textContent = "新規注文 · " + c.name;
    $("leverageLabel").textContent = c.leverage + "倍";
    $("qtyUnit").textContent = c.unit;
    qtyInput.step = c.minUnit;
    qtyInput.value = order.qty[k];
    [priceInput, tpInput, slInput].forEach(i => { i.step = c.tick; });
    symMenu.querySelectorAll(".dd-item").forEach(b => b.classList.toggle("active", b.dataset.sym === k));
    pendingPoint = null;
    view.offset = 0;
    updateChartMeta();
    renderLots();
    if (order.type !== "market") setDefaultOrderPrice();
    if (order.tpOn) setDefaultBracket("tp");
    if (order.slOn) setDefaultBracket("sl");
    updateOrderPanel();
    renderBoard();
    requestDraw();
  }

  // ======================= 描画ツール =======================
  let activeTool = "cursor";
  let pendingPoint = null;
  function setTool(name) {
    activeTool = name;
    pendingPoint = null;
    document.querySelectorAll(".rail-btn[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === name));
    document.querySelectorAll(".tf-item").forEach(b => b.classList.toggle("active", b.dataset.tool === name));
  }
  document.querySelectorAll(".rail-btn[data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  toolFlyout.querySelectorAll(".tf-item").forEach(b => b.addEventListener("click", () => { setTool(b.dataset.tool); toolFlyout.classList.remove("open"); }));
  $("toolMore").addEventListener("click", (e) => toggleMenu(toolFlyout, e));
  $("toolEraser").addEventListener("click", () => { drawingsBySym[currentSym].length = 0; setTool("cursor"); requestDraw(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { setTool("cursor"); return; }
    if (!e.altKey) return;
    const tool = { t: "trendline", h: "hline", v: "vline", c: "cursor" }[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); setTool(tool); }
  });

  // ======================= チャート =======================
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  let scale = null;
  let lastLines = [];
  let mouse = null;
  let drag = null;
  let rafPending = false;
  function requestDraw() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; drawChart(); }); }
  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestDraw();
  }
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvas);
  window.addEventListener("resize", resizeCanvas);

  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // 公開（30秒遅延）データから指定時間足のローソク足を作る
  function publicCandles(k, tfMs, fromT, toT, cutoff) {
    const e = engines[k], bars = e.bars, out = [];
    let cur = null;
    const add = (t, o, h, l, c, n) => {
      const b = Math.floor(t / tfMs) * tfMs;
      if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, o, h, l, c, n }; }
      else { if (h > cur.h) cur.h = h; if (l < cur.l) cur.l = l; cur.c = c; cur.n += n; }
    };
    const cutBar = Math.floor(cutoff / 1000) * 1000;
    for (let i = lowerBound(bars, Math.floor(fromT / tfMs) * tfMs); i < bars.length; i++) {
      const b = bars[i];
      if (b.t >= cutBar || b.t > toT) break;
      add(b.t, b.o, b.h, b.l, b.c, b.n);
    }
    if (cutBar <= toT) {
      let o = null, h = 0, l = 0, c = 0, n = 0;
      e.ticks.forEach(x => {
        if (x.t < cutBar || x.t > cutoff) return;
        if (o === null) { o = h = l = x.p; }
        h = Math.max(h, x.p); l = Math.min(l, x.p); c = x.p; n++;
      });
      if (o !== null) add(cutBar, o, h, l, c, n);
    }
    if (cur) out.push(cur);
    return out;
  }
  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    let s = 0;
    for (let i = 0; i < vals.length; i++) { s += vals[i]; if (i >= n) s -= vals[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }

  function drawChart() {
    const k = currentSym, c = INSTRUMENTS[k], e = engines[k];
    const r = canvas.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (W < 50 || H < 50) return;
    ctx.clearRect(0, 0, W, H);

    const axisW = 70, timeH = 22, volH = indOn.vol ? 54 : 0;
    const L = 4, R = W - axisW, T = 8;
    const plotBottom = H - timeH - volH - (volH ? 6 : 0);
    const volTop = plotBottom + 6, volBottom = H - timeH;

    const now = Date.now(), cutoff = now - DELAY_MS;
    const tfMs = view.tf * 1000;
    const liveEdge = futureVisible ? now : cutoff;
    const padMs = (futureVisible ? 1 : 3) * tfMs;
    const maxOffset = Math.max(0, BACKFILL_MS - view.bars * tfMs - 60000);
    view.offset = clamp(view.offset, 0, maxOffset);
    const wEnd = liveEdge + padMs - view.offset, wStart = wEnd - view.bars * tfMs;
    $("liveBtn").hidden = view.offset < tfMs * 2;

    const all = publicCandles(k, tfMs, wStart - 60 * tfMs, wEnd, cutoff);
    const first = all.findIndex(cd => cd.t + tfMs > wStart);
    const candles = first < 0 ? [] : all.slice(first);
    const fut = futureVisible ? e.ticks.filter(x => x.t > cutoff && x.t >= wStart && x.t <= wEnd) : [];

    // 縦軸：時間足ごとの基本縮尺（グリッド幅は固定単位）。値動きが収まらないときだけ
    // 1→2→5→10倍…とキリの良い倍率で縮小し、はみ出しそうなときは中心をすぐに追従させる
    const [baseStep, pxStep] = c.scales[view.tf];
    const baseRange = ((plotBottom - T) / pxStep) * baseStep;
    let hi = -Infinity, lo = Infinity;
    candles.forEach(cd => { if (cd.h > hi) hi = cd.h; if (cd.l < lo) lo = cd.l; });
    fut.forEach(x => { if (x.p > hi) hi = x.p; if (x.p < lo) lo = x.p; });
    let mult = 1;
    if (hi > -Infinity) {
      const need = (hi - lo) * 1.2;
      mult = [1, 2, 2.5, 5, 10, 20, 25, 50, 100].find(m => baseRange * m >= need) || 100;
    }
    const gStep = baseStep * mult;
    const range = baseRange * mult;
    if (e.views[view.tf] === undefined) e.views[view.tf] = hi > -Infinity ? (hi + lo) / 2 : e.pub;
    if (hi > -Infinity) {
      let v = e.views[view.tf];
      const mid = (hi + lo) / 2;
      const margin = range * 0.06;
      if (hi > v + range / 2 - margin || lo < v - range / 2 + margin) v += (mid - v) * 0.5;       // はみ出しそう → 素早く追従
      else if (Math.abs(mid - v) > range * 0.25) v += (mid - v) * (drag ? 0.35 : 0.12);          // 偏っている → ゆっくり追従
      if (hi > v + range / 2 || lo < v - range / 2) v = mid;                                      // それでも外 → 即座に合わせる
      e.views[view.tf] = v;
    }
    const vc = e.views[view.tf], minP = vc - range / 2, maxP = vc + range / 2;
    const x = (t) => L + ((t - wStart) / (wEnd - wStart)) * (R - L);
    const y = (p) => T + (1 - (p - minP) / (maxP - minP)) * (plotBottom - T);
    const tAtX = (px) => wStart + ((px - L) / (R - L)) * (wEnd - wStart);
    const pAtY = (py) => maxP - ((py - T) / (plotBottom - T)) * (maxP - minP);
    scale = { x, y, tAtX, pAtY, L, R, T, plotBottom, H, tfMs };

    const colText = css("--text"), colDim = css("--text-dim"), colMid = css("--text-mid"), colGrid = css("--grid-line");
    const colUp = css("--buy"), colDown = css("--sell"), colFut = css("--future"), colBg = css("--panel");
    const colPos = css("--pos-line"), colOrd = css("--order-line");

    function tag(yy, text, bg, fg, sub) {
      const hgt = sub ? 30 : 18;
      const top = clamp(yy - 9, T, H - timeH - hgt);
      ctx.fillStyle = bg; ctx.fillRect(R + 1, top, axisW - 2, hgt);
      ctx.fillStyle = fg;
      ctx.font = "700 11px 'JetBrains Mono', monospace";
      ctx.fillText(text, R + 6, top + 13);
      if (sub) { ctx.font = "10px 'JetBrains Mono', monospace"; ctx.fillText(sub, R + 6, top + 25); }
    }

    // --- グリッドと軸ラベル ---
    ctx.lineWidth = 1;
    ctx.strokeStyle = colGrid;
    const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map(s => s * 1000);
    const pxPerMs = (R - L) / (wEnd - wStart);
    const tStep = steps.find(s => s * pxPerMs >= 110) || steps[steps.length - 1];
    const timeLabels = [];
    for (let t = Math.ceil((wStart + DELAY_MS) / tStep) * tStep - DELAY_MS; t <= wEnd; t += tStep) {
      const px = x(t);
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, H - timeH); ctx.stroke();
      timeLabels.push([px, fmtClock(t + DELAY_MS, tStep < 60000)]);
    }
    ctx.font = "10.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = colDim;
    const labelEvery = Math.max(1, Math.ceil(18 / pxStep));
    let li = 0;
    for (let p = Math.ceil(minP / gStep) * gStep; p <= maxP + 1e-9 && li < 500; p += gStep, li++) {
      const py = y(p);
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(R, py); ctx.stroke();
      if (li % labelEvery === 0) ctx.fillText(fmtP(k, p), R + 6, py + 4);
    }
    ctx.strokeStyle = css("--border");
    ctx.beginPath(); ctx.moveTo(R + 0.5, T); ctx.lineTo(R + 0.5, H - timeH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L, H - timeH + 0.5); ctx.lineTo(R, H - timeH + 0.5); ctx.stroke();
    ctx.fillStyle = colDim;
    ctx.font = "10px 'JetBrains Mono', monospace";
    timeLabels.forEach(([px, lbl]) => {
      const tw = ctx.measureText(lbl).width;
      if (px - tw / 2 > L && px + tw / 2 < R) ctx.fillText(lbl, px - tw / 2, H - 7);
    });

    // --- 未来ゾーン ---
    const nowX = x(cutoff);
    if (futureVisible && nowX < R) {
      ctx.fillStyle = css("--future-glow");
      ctx.fillRect(Math.max(L, nowX), T, R - Math.max(L, nowX), plotBottom - T);
      ctx.save();
      ctx.setLineDash([3, 4]); ctx.strokeStyle = colDim; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(nowX, T); ctx.lineTo(nowX, H - timeH); ctx.stroke();
      ctx.restore();
      if (R - nowX > 110) { ctx.fillStyle = colFut; ctx.font = "700 10px Inter, sans-serif"; ctx.fillText("未来ゾーン（+30秒）", nowX + 8, plotBottom - 8); }
    }

    // --- 出来高 ---
    const barW = Math.max(1, Math.min(14, ((R - L) / view.bars) * 0.68));
    if (indOn.vol && candles.length) {
      const vols = candles.map(cd => (cd.h - cd.l + c.tick) * cd.n);
      const maxVol = Math.max(...vols);
      candles.forEach((cd, i) => {
        const vh = (vols[i] / maxVol) * (volBottom - volTop - 2);
        ctx.fillStyle = cd.c >= cd.o ? "rgba(23,201,155,0.35)" : "rgba(255,92,108,0.35)";
        ctx.fillRect(x(cd.t + tfMs / 2) - barW / 2, volBottom - vh, barW, vh);
      });
    }

    // --- 価格エリア（クリップ） ---
    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, R - L, plotBottom - T); ctx.clip();
    const cx = (cd) => x(cd.t + tfMs / 2);
    function series(vals, color, width, dash) {
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      all.forEach((cd, i) => {
        if (vals[i] === null || cd.t + tfMs <= wStart) return;
        const px = cx(cd), py = y(vals[i]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      });
      ctx.stroke(); ctx.restore();
    }
    const closes = all.map(cd => cd.c);
    const indValues = {};
    if (indOn.bb && all.length > 20) {
      const mid = sma(closes, 20);
      const up = [], dn = [];
      closes.forEach((_, i) => {
        if (mid[i] === null) { up.push(null); dn.push(null); return; }
        let s = 0; for (let j = i - 19; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
        const sd = Math.sqrt(s / 20); up.push(mid[i] + 2 * sd); dn.push(mid[i] - 2 * sd);
      });
      ctx.save(); ctx.fillStyle = "rgba(100,116,139,0.10)"; ctx.beginPath();
      const idx = all.map((cd, i) => i).filter(i => up[i] !== null && all[i].t + tfMs > wStart);
      idx.forEach((i, n) => { const px = cx(all[i]); if (n === 0) ctx.moveTo(px, y(up[i])); else ctx.lineTo(px, y(up[i])); });
      idx.slice().reverse().forEach(i => ctx.lineTo(cx(all[i]), y(dn[i])));
      ctx.closePath(); ctx.fill(); ctx.restore();
      series(up, "#64748b", 1); series(dn, "#64748b", 1); series(mid, "#94a3b8", 1, [4, 3]);
      indValues.bb = [up[up.length - 1], dn[dn.length - 1]];
    }
    if (indOn.ma20) { const v = sma(closes, 20); series(v, "#3b82f6", 1.5); indValues.ma20 = v[v.length - 1]; }
    if (indOn.ma50) { const v = sma(closes, 50); series(v, "#a855f7", 1.5); indValues.ma50 = v[v.length - 1]; }

    if (["candle", "hollow", "bar", "hilo"].includes(chartType)) {
      candles.forEach(cd => {
        const px = cx(cd), up = cd.c >= cd.o, col = up ? colUp : colDown;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        if (chartType === "hilo") { ctx.lineWidth = Math.max(1.5, barW * 0.5); }
        ctx.beginPath(); ctx.moveTo(px, y(cd.h)); ctx.lineTo(px, y(cd.l)); ctx.stroke();
        const top = y(Math.max(cd.o, cd.c)), bot = y(Math.min(cd.o, cd.c)), bh = Math.max(1, bot - top);
        if (chartType === "candle") ctx.fillRect(px - barW / 2, top, barW, bh);
        else if (chartType === "hollow") {
          if (up) { ctx.fillStyle = colBg; ctx.fillRect(px - barW / 2, top, barW, bh); ctx.strokeRect(px - barW / 2 + 0.5, top + 0.5, barW - 1, Math.max(0.5, bh - 1)); }
          else ctx.fillRect(px - barW / 2, top, barW, bh);
        } else if (chartType === "bar") {
          ctx.beginPath(); ctx.moveTo(px - barW / 2, y(cd.o)); ctx.lineTo(px, y(cd.o)); ctx.moveTo(px, y(cd.c)); ctx.lineTo(px + barW / 2, y(cd.c)); ctx.stroke();
        }
      });
    } else if (candles.length > 1) {
      if (chartType === "area") {
        const grd = ctx.createLinearGradient(0, T, 0, plotBottom);
        grd.addColorStop(0, "rgba(59,130,246,0.30)"); grd.addColorStop(1, "rgba(59,130,246,0.02)");
        ctx.fillStyle = grd; ctx.beginPath();
        candles.forEach((cd, i) => { const px = cx(cd); if (i === 0) ctx.moveTo(px, y(cd.c)); else ctx.lineTo(px, y(cd.c)); });
        ctx.lineTo(cx(candles[candles.length - 1]), plotBottom); ctx.lineTo(cx(candles[0]), plotBottom); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = chartType === "area" ? "#3b82f6" : colText; ctx.lineWidth = 2; ctx.beginPath();
      candles.forEach((cd, i) => { const px = cx(cd); if (i === 0) ctx.moveTo(px, y(cd.c)); else ctx.lineTo(px, y(cd.c)); });
      ctx.stroke();
    }

    // 未来線（ONのときだけ・チャートにのみ表示）
    if (fut.length) {
      ctx.save(); ctx.strokeStyle = colFut; ctx.globalAlpha = 0.75; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x(cutoff), y(e.pub));
      fut.forEach(pt => ctx.lineTo(x(pt.t), y(pt.p)));
      ctx.stroke(); ctx.restore();
    }

    // ユーザーの描画
    ctx.save(); ctx.strokeStyle = colMid; ctx.lineWidth = 1.4;
    const drawn = drawingsBySym[k];
    drawn.forEach(d => {
      if (d.type === "trendline") { ctx.beginPath(); ctx.moveTo(x(d.p1.t), y(d.p1.p)); ctx.lineTo(x(d.p2.t), y(d.p2.p)); ctx.stroke(); }
      else if (d.type === "hline") { ctx.beginPath(); ctx.moveTo(L, y(d.p)); ctx.lineTo(R, y(d.p)); ctx.stroke(); }
      else if (d.type === "vline") { ctx.beginPath(); ctx.moveTo(x(d.t), T); ctx.lineTo(x(d.t), plotBottom); ctx.stroke(); }
    });
    if (activeTool === "trendline" && pendingPoint && mouse) {
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x(pendingPoint.t), y(pendingPoint.p)); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
    }
    ctx.restore();

    // 建玉・利確・損切・注文ライン
    const lines = [];
    positions.filter(p => p.sym === k).forEach(p => {
      const pnl = markPnl(p);
      lines.push({ kind: "entry", ref: p, price: p.entry, color: colPos, dash: null, label: dirJ(p.dir) + " " + fmtQty(k, p.units) + "  " + fmtSYen(pnl), labelBg: colPos });
      const s = p.dir === "buy" ? 1 : -1;
      if (p.tp !== null) lines.push({ kind: "tp", ref: p, price: p.tp, color: colUp, dash: [6, 4], label: "利確 " + fmtSYen((p.tp - p.entry) * p.units * s), labelBg: colUp });
      if (p.sl !== null) lines.push({ kind: "sl", ref: p, price: p.sl, color: colDown, dash: [6, 4], label: "損切 " + fmtSYen((p.sl - p.entry) * p.units * s), labelBg: colDown });
    });
    orders.filter(o => o.sym === k).forEach(o => {
      lines.push({ kind: "order", ref: o, price: o.price, color: colOrd, dash: [2, 3], label: (o.type === "limit" ? "指値" : "逆指値") + dirJ(o.dir) + " " + fmtQty(k, o.units), labelBg: colOrd });
    });
    if (drag && drag.kind === "line") {
      const ln = lines.find(l => l.kind === drag.line.kind && l.ref === drag.line.ref);
      if (drag.line.kind === "entry") {
        const p = drag.line.ref;
        const kind = (p.dir === "buy") === (drag.price > exitPriceOf(p)) ? "tp" : "sl";
        lines.push({ kind: "ghost", ref: p, price: drag.price, color: kind === "tp" ? colUp : colDown, dash: [6, 4], label: (kind === "tp" ? "利確 " : "損切 ") + fmtSYen((drag.price - p.entry) * p.units * (p.dir === "buy" ? 1 : -1)), labelBg: kind === "tp" ? colUp : colDown });
      } else if (ln) {
        ln.price = drag.price;
        if (ln.kind === "tp" || ln.kind === "sl") ln.label = (ln.kind === "tp" ? "利確 " : "損切 ") + fmtSYen((drag.price - ln.ref.entry) * ln.ref.units * (ln.ref.dir === "buy" ? 1 : -1));
      }
    }
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, R - L, plotBottom - T); ctx.clip();
    lines.forEach(ln => {
      ln.y = y(ln.price);
      ctx.save(); ctx.strokeStyle = ln.color; ctx.lineWidth = ln.kind === "entry" ? 1.4 : 1.2; if (ln.dash) ctx.setLineDash(ln.dash);
      ctx.beginPath(); ctx.moveTo(L, ln.y); ctx.lineTo(R, ln.y); ctx.stroke(); ctx.restore();
    });
    ctx.restore();
    ctx.font = "700 10.5px Inter, 'Hiragino Sans', sans-serif";
    lines.forEach(ln => {
      if (ln.y < T || ln.y > plotBottom) return;
      const tw = ctx.measureText(ln.label).width + 14;
      const lx = R - tw - 90;
      ctx.fillStyle = ln.labelBg; ctx.fillRect(lx, ln.y - 9, tw, 18);
      ctx.fillStyle = "#fff"; ctx.fillText(ln.label, lx + 7, ln.y + 4);
      ln.lx = lx; ln.lw = tw;
    });
    lastLines = lines.filter(l => l.kind !== "ghost");
    ctx.restore();

    // --- 右軸の価格タグ ---
    drawn.forEach(d => { if (d.type === "hline") { const py = y(d.p); if (py > T && py < plotBottom) tag(py, fmtP(k, d.p), colMid, colBg); } });
    lines.forEach(ln => { if (ln.y > T && ln.y < plotBottom) tag(ln.y, fmtP(k, ln.price), ln.color, "#fff"); });
    if (candles.length) {
      const lc = candles[candles.length - 1];
      const py = clamp(y(lc.c), T, plotBottom);
      ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = lc.c >= lc.o ? colUp : colDown; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(R, py); ctx.stroke(); ctx.restore();
      let sub = null;
      if (view.offset < tfMs) {
        const rem = Math.max(0, lc.t + tfMs - cutoff) / 1000;
        sub = view.tf >= 60 ? String(Math.floor(rem / 60)).padStart(2, "0") + ":" + String(Math.floor(rem % 60)).padStart(2, "0") : "00:" + String(Math.ceil(rem)).padStart(2, "0");
      }
      tag(py, fmtP(k, e.pub), lc.c >= lc.o ? colUp : colDown, "#fff", sub);
    }
    if (futureVisible && fut.length) {
      const py = clamp(y(e.price), T, plotBottom);
      ctx.fillStyle = colFut; ctx.beginPath(); ctx.arc(x(fut[fut.length - 1].t), y(e.price), 3.2, 0, Math.PI * 2); ctx.fill();
      tag(py, fmtP(k, e.price), colFut, "#05100c");
    }

    // --- クロスヘア ---
    let hover = null;
    if (mouse && !(drag && drag.kind === "pan") && mouse.x >= L && mouse.x <= R && mouse.y >= T && mouse.y <= H - timeH) {
      const tm = tAtX(mouse.x);
      const bucket = Math.floor(tm / tfMs) * tfMs;
      hover = candles.find(cd => cd.t === bucket) || null;
      const sx = hover ? cx(hover) : mouse.x;
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = colMid; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(sx, T); ctx.lineTo(sx, H - timeH); ctx.stroke();
      if (mouse.y <= plotBottom) { ctx.beginPath(); ctx.moveTo(L, mouse.y); ctx.lineTo(R, mouse.y); ctx.stroke(); }
      ctx.restore();
      if (mouse.y <= plotBottom) tag(mouse.y, fmtP(k, pAtY(mouse.y)), colText, colBg);
      const lbl = fmtClock(bucket + DELAY_MS, view.tf < 60);
      ctx.font = "700 10px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(lbl).width + 12;
      ctx.fillStyle = colText; ctx.fillRect(sx - tw / 2, H - timeH + 2, tw, 18);
      ctx.fillStyle = colBg; ctx.fillText(lbl, sx - tw / 2 + 6, H - timeH + 15);
    }

    // --- ヘッダー（OHLC・インジケーター値） ---
    const hc = hover || candles[candles.length - 1];
    if (hc) {
      const chg = hc.c - hc.o, col = chg >= 0 ? "pos" : "neg";
      $("chOhlc").innerHTML =
        "<span>始値 <b class='" + col + "'>" + fmtP(k, hc.o) + "</b></span><span>高値 <b class='" + col + "'>" + fmtP(k, hc.h) + "</b></span>" +
        "<span>安値 <b class='" + col + "'>" + fmtP(k, hc.l) + "</b></span><span>終値 <b class='" + col + "'>" + fmtP(k, hc.c) + "</b></span>" +
        "<span class='" + col + "'>" + (chg >= 0 ? "+" : "") + (c.decimals ? chg.toFixed(c.decimals) : Math.round(chg)) + "</span>";
    }
    const ind = [];
    if (indOn.ma20 && indValues.ma20) ind.push("<span style='color:#3b82f6'>MA20 " + fmtP(k, indValues.ma20) + "</span>");
    if (indOn.ma50 && indValues.ma50) ind.push("<span style='color:#a855f7'>MA50 " + fmtP(k, indValues.ma50) + "</span>");
    if (indOn.bb && indValues.bb) ind.push("<span style='color:#94a3b8'>BB " + fmtP(k, indValues.bb[0]) + " / " + fmtP(k, indValues.bb[1]) + "</span>");
    $("chInd").innerHTML = ind.join("");
  }

  // --- マウス操作 ---
  function mpos(ev) { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
  function hitLine(py) {
    let best = null, bestD = 7;
    lastLines.forEach(ln => {
      const d = Math.abs(ln.y - py);
      const pri = ln.kind === "entry" ? 0.5 : 0;
      if (d + pri < bestD) { best = ln; bestD = d + pri; }
    });
    return best;
  }
  canvas.addEventListener("pointerdown", (ev) => {
    if (!scale) return;
    const m = mpos(ev);
    mouse = m;
    if (m.x > scale.R) return;
    const k = currentSym;
    if (activeTool === "cursor") {
      const hit = m.y <= scale.plotBottom ? hitLine(m.y) : null;
      if (hit) drag = { kind: "line", line: hit, price: hit.price };
      else drag = { kind: "pan", startX: m.x, startOffset: view.offset };
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = hit ? "ns-resize" : "grabbing";
      return;
    }
    const t = scale.tAtX(m.x), p = scale.pAtY(m.y);
    const list = drawingsBySym[k];
    if (activeTool === "trendline") {
      if (!pendingPoint) pendingPoint = { t, p };
      else { list.push({ type: "trendline", p1: pendingPoint, p2: { t, p } }); pendingPoint = null; }
    } else if (activeTool === "hline") list.push({ type: "hline", p });
    else if (activeTool === "vline") list.push({ type: "vline", t });
    requestDraw();
  });
  canvas.addEventListener("pointermove", (ev) => {
    mouse = mpos(ev);
    if (drag && drag.kind === "pan") {
      const dt = ((mouse.x - drag.startX) / (scale.R - scale.L)) * view.bars * scale.tfMs;
      view.offset = Math.max(0, drag.startOffset + dt);
    } else if (drag && drag.kind === "line") {
      drag.price = roundTo(scale.pAtY(mouse.y), INSTRUMENTS[currentSym].tick);
    } else if (activeTool === "cursor" && scale) {
      canvas.style.cursor = mouse.y <= scale.plotBottom && hitLine(mouse.y) ? "ns-resize" : "crosshair";
    }
    requestDraw();
  });
  function endDrag() {
    if (drag && drag.kind === "line") applyLineDrag(drag);
    drag = null;
    canvas.style.cursor = "crosshair";
    requestDraw();
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => { if (!drag) { mouse = null; requestDraw(); } });
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const f = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
    const maxBars = Math.min(600, Math.floor((BACKFILL_MS - 120000) / (view.tf * 1000)));
    view.bars = clamp(Math.round(view.bars * f), 20, maxBars);
    requestDraw();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => { view.offset = 0; requestDraw(); });
  $("liveBtn").addEventListener("click", () => { view.offset = 0; requestDraw(); });

  function setBracket(p, kind, price) {
    const cur = exitPriceOf(p);
    if (!validBracket(p.sym, p.dir, kind, price, cur)) {
      toast((kind === "tp" ? "利確" : "損切") + "は現在値より" + ((kind === "tp") === (p.dir === "buy") ? "上" : "下") + "に設定してください", "err");
      return;
    }
    p[kind] = price;
    toast((kind === "tp" ? "利確" : "損切") + "を " + fmtP(p.sym, price) + " に設定しました", "warn");
  }
  function applyLineDrag(d) {
    const ln = d.line, price = d.price, c = INSTRUMENTS[ln.ref.sym];
    if (Math.abs(price - ln.price) < c.tick / 2) return;
    if (ln.kind === "tp" || ln.kind === "sl") setBracket(ln.ref, ln.kind, price);
    else if (ln.kind === "entry") {
      const p = ln.ref;
      const kind = (p.dir === "buy") === (price > exitPriceOf(p)) ? "tp" : "sl";
      setBracket(p, kind, price);
    } else if (ln.kind === "order") {
      const o = ln.ref;
      if (validOrderPrice(o.sym, o.type, o.dir, price)) { o.price = price; toast("注文価格を " + fmtP(o.sym, price) + " に変更しました", "warn"); }
      else toast("その価格には変更できません（すぐに約定してしまう位置です）", "err");
    }
    renderPositions();
  }

  // ======================= ニックネーム =======================
  const NICK_KEY = "futurefx_nickname";
  // なりすまし防止のための予約語チェック（必要に応じて追加してください）
  const NG_WORDS = ["admin", "運営", "staff", "公式"];
  function randomNickname() { return "未来人" + (1000 + Math.floor(Math.random() * 9000)); }
  function loadNickname() { try { return window.localStorage.getItem(NICK_KEY); } catch (e) { return null; } }
  function saveNickname(n) { try { window.localStorage.setItem(NICK_KEY, n); } catch (e) {} }
  function sanitizeNickname(raw) {
    let n = String(raw || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    n = Array.from(n).slice(0, 12).join("");
    return n;
  }
  function validateNickname(n) {
    if (!n) return "ニックネームを入力してください";
    if (NG_WORDS.some(w => n.toLowerCase().includes(w.toLowerCase()))) return "その名前は使用できません";
    return null;
  }
  // 名前を自分で決めるまでは自動の名前（未来人1234 など）で遊べる。ランキング登録のときに初めて決めてもらう
  const NICK_AUTO_KEY = "futurefx_nickname_auto";
  let nickname = loadNickname();
  let nickConfirmed = !!nickname;
  if (!nickname) {
    try { nickname = window.localStorage.getItem(NICK_AUTO_KEY); } catch (e) {}
    if (!nickname) { nickname = randomNickname(); try { window.localStorage.setItem(NICK_AUTO_KEY, nickname); } catch (e) {} }
  }
  let nickResolve = null;
  const nickModal = $("nickModal"), nickInput = $("nickInput"), nickErr = $("nickErr");
  function openNicknameModal(forEdit) {
    nickInput.value = nickname || randomNickname();
    nickErr.textContent = "";
    nickModal.hidden = false;
    nickInput.focus(); nickInput.select();
    return new Promise((resolve) => { nickResolve = resolve; });
  }
  function confirmNickname() {
    const n = sanitizeNickname(nickInput.value);
    const err = validateNickname(n);
    if (err) { nickErr.textContent = err; return; }
    nickname = n; nickConfirmed = true;
    saveNickname(n);
    nickModal.hidden = true;
    if (nickResolve) { nickResolve(n); nickResolve = null; }
  }
  $("nickConfirm").addEventListener("click", confirmNickname);
  nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmNickname(); });
  // 共有画面から名前を変えたら、まだランキングに登録していない成績にも反映し、共有画面（カード・投稿文・挑戦状URL・Xのリンク）を作り直す
  $("rcPlayerEdit").addEventListener("click", () => openNicknameModal(true).then(() => {
    if (lastRound && !lastRound.submitted) lastRound.nickname = nickname;
    if (!$("shareModal").hidden) openShare();
  }));
  // 初回起動時：遊び方の説明 → 「未来視点」ボタンを光らせて最初の一押しを案内（どちらも1回だけ）
  const HELP_KEY = "futurefx_help_seen";
  function helpSeen() { try { return !!window.localStorage.getItem(HELP_KEY); } catch (e) { return false; } }
  function showHelp() { $("helpModal").hidden = false; }
  $("helpClose").addEventListener("click", () => {
    const first = !helpSeen();
    $("helpModal").hidden = true;
    try { window.localStorage.setItem(HELP_KEY, "1"); } catch (e) {}
    if (first) startCoach();
  });
  $("helpBtn").addEventListener("click", showHelp);
  if (!helpSeen()) showHelp();
  let coachTimer = 0;
  function startCoach() {
    if (futureState !== "ready") return;
    ["futureToggle", "mFuture"].forEach(id => $(id).classList.add("coach"));
    toast("まずは「未来視点を使う」を押してみよう。30秒先の値動きが見えます", "warn");
    coachTimer = setTimeout(stopCoach, 20000);
  }
  function stopCoach() {
    clearTimeout(coachTimer);
    ["futureToggle", "mFuture"].forEach(id => $(id).classList.remove("coach"));
  }

  // ======================= 成績シェア =======================
  function rankOf(ret, trades) {
    if (trades === 0) return "未来を眺めていただけの人";
    if (ret >= 20) return "未来を完全に支配した者";
    if (ret >= 5) return "時をかけるトレーダー";
    if (ret > 0) return "ちょっとだけ未来人";
    if (ret > -5) return "未来が見えても微損";
    if (ret > -20) return "未来に裏切られた人";
    return "未来が見えても溶かす人";
  }
  // ======================= 成績シェア =======================
  // 成績カード：終わったラウンドがあればその成績、なければフリープレイの現在の成績
  function currentCard() {
    if (challenge && challengeOver && lastRound) return Object.assign({}, lastRound);
    const equity = balance + floatingTotal(), diff = equity - START_BALANCE, ret = (diff / START_BALANCE) * 100;
    const winRate = stats.trades ? Math.round((stats.wins / stats.trades) * 100) : 0;
    const futureRate = stats.trades ? Math.round((stats.futureTrades / stats.trades) * 100) : 0;
    return { mode: "free", nickname, equity, ret, trades: stats.trades, winRate, futureRate, rank: rankOf(ret, stats.trades + positions.length) };
  }
  function modeLabel(card) {
    if (card.mode === "ta") return "5分タイムアタック";
    if (card.mode === "chal") return "vs " + challenge.n + "（挑戦状）";
    return "フリープレイ";
  }
  let shareCard = null;
  function openShare() {
    const card = currentCard();
    shareCard = card;
    const diff = card.equity - START_BALANCE;
    const win = card.trades ? card.winRate + "%" : "-";
    const fu = card.trades ? card.futureRate + "%" : "-";
    $("rcDate").textContent = new Date().toLocaleDateString("ja-JP") + "・" + modeLabel(card);
    $("rcPlayer").textContent = nickname || randomNickname();
    $("rcRank").textContent = "「" + card.rank + "」";
    $("rcEquity").textContent = fmtYen(card.equity);
    $("rcRet").textContent = fmtSYen(diff) + "（" + (card.ret >= 0 ? "+" : "") + card.ret.toFixed(2) + "%）";
    $("rcRet").style.color = diff >= 0 ? "#17c99b" : "#ff5c6c";
    $("rcTrades").textContent = card.trades + "回";
    $("rcWin").textContent = win;
    $("rcFuture").textContent = fu;
    $("rcBest").textContent = fmtYen(Math.max(bestBalance, card.equity));
    $("rcMaxWin").textContent = stats.maxWin > 0 ? fmtSYen(stats.maxWin) : "-";
    $("rcMaxLoss").textContent = stats.maxLoss < 0 ? fmtSYen(stats.maxLoss) : "-";

    let head = (nickname || "名無しの未来人") + "の成績（" + modeLabel(card) + "）";
    let line1;
    if (card.mode === "free" && card.trades === 0 && !positions.length) line1 = "30秒先の未来が見えるのに、1回も取引しませんでした。";
    else if (diff >= 0) line1 = "30秒先の未来が見えるトレードで、100万円 → " + fmtYen(card.equity) + "（+" + card.ret.toFixed(2) + "%）";
    else line1 = "30秒先の未来が見えていたのに、100万円 → " + fmtYen(card.equity) + "（" + card.ret.toFixed(2) + "%）";
    if (card.mode === "chal") {
      const d = card.equity - challenge.e;
      head = challenge.n + "さんの挑戦状に挑んで" + (Math.round(d) === 0 ? "引き分け" : d > 0 ? fmtYen(d) + "差で勝利！" : fmtYen(-d) + "差で敗北…");
    }
    const hasChal = card.mode !== "free";
    const chalUrl = hasChal ? buildChallengeUrl(card.equity) : "";
    const text = head + "\n" + line1 + "\n" +
      (card.trades ? "決済" + card.trades + "回・勝率" + win + "・未来視点の使用率" + fu + "\n" : "") +
      "称号：「" + card.rank + "」\n" +
      (hasChal ? "同じ相場の5分勝負、受けて立つ？👇\n" : "") + HASHTAG;
    $("shareText").value = text;
    $("chalUrlRow").hidden = !hasChal;
    $("chalUrl").value = chalUrl;
    $("chalUrlNote").textContent = hasChal
      ? "このURLを開いた人は、あなたと同じ相場を同じ5分間遊び、最終資産で勝負します。"
      : "挑戦状URLは「5分タイムアタック」の結果から作れます。";
    $("shareX").href = "https://x.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(hasChal ? chalUrl : shareBaseUrl());
    $("shareModal").hidden = false;
  }
  $("shareBtn").addEventListener("click", openShare);

  // ---- 成績カードの画像（1200×675、Xのカード比率） ----
  function drawCardImage(card) {
    const W = 1200, H = 675;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const font = (w, px, mono) => w + " " + px + "px " + (mono ? "'JetBrains Mono', ui-monospace, monospace" : "Inter, 'Hiragino Sans', 'Yu Gothic', sans-serif");
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#111a27"); bg.addColorStop(1, "#0a0e15");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W, 0, 0, W, 0, 700);
    glow.addColorStop(0, "rgba(240,180,41,0.30)"); glow.addColorStop(1, "rgba(240,180,41,0)");
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    // 右側：取引の振り返りチャート（ラウンドの結果なら）／なければ飾りの未来線
    const rd = card.mode !== "free" && lastRound && lastRound.tradeList ? replayData(lastRound.tradeList) : null;
    if (rd && rd.trades.length) {
      g.fillStyle = "rgba(255,255,255,0.04)"; g.fillRect(700, 130, 440, 330);
      g.fillStyle = "#8b98ab"; g.font = font("600", 20); g.fillText("取引の振り返り（" + INSTRUMENTS[rd.k].code + "）", 716, 160);
      drawReplay(g, 716, 178, 408, 240, rd, { grid: "rgba(255,255,255,0.06)", line: "#a3b0c2", up: "#17c99b", down: "#ff5c6c",
        bg: "#111a27", dim: "#8b98ab", lw: 3, mk: 10, fs: 18, font: "18px 'JetBrains Mono', monospace" });
    } else {
      g.save(); g.strokeStyle = "rgba(240,180,41,0.35)"; g.setLineDash([12, 10]); g.lineWidth = 3; g.beginPath();
      for (let i = 0; i <= 30; i++) { const x = 600 + i * 20, y = 520 - Math.sin(i / 3) * 40 - i * 6; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke(); g.restore();
    }
    const diff = card.equity - START_BALANCE;
    g.fillStyle = "#a3b0c2"; g.font = font("600", 28); g.fillText("30秒先が見えるトレード", 64, 84);
    g.textAlign = "right"; g.fillText(modeLabel(card), W - 64, 84); g.textAlign = "left";
    g.fillStyle = "#f4f7fb"; g.font = font("700", 32); g.fillText("プレイヤー：" + (nickname || "名無しの未来人"), 64, 150);
    g.fillStyle = "#f0b429"; g.font = font("700", 28); g.fillText("称号", 64, 220);
    g.fillStyle = "#f4f7fb"; g.font = font("800", 54); g.fillText("「" + card.rank + "」", 52, 285);
    g.font = font("800", fmtYen(card.equity).length > 10 ? 84 : 96, true); g.fillText(fmtYen(card.equity), 60, 420);
    g.fillStyle = diff >= 0 ? "#17c99b" : "#ff5c6c"; g.font = font("700", 40, true);
    g.fillText(fmtSYen(diff) + "（" + (card.ret >= 0 ? "+" : "") + card.ret.toFixed(2) + "%）", 64, 480);
    const boxes = [["取引回数", card.trades + "回"], ["勝率", card.trades ? card.winRate + "%" : "-"], ["未来視点の使用率", card.trades ? card.futureRate + "%" : "-"]];
    boxes.forEach((b, i) => {
      const x = 64 + i * 250, y = 530;
      g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(x, y, 230, 84);
      g.fillStyle = "#8b98ab"; g.font = font("600", 20); g.fillText(b[0], x + 16, y + 30);
      g.fillStyle = "#f4f7fb"; g.font = font("700", 30, true); g.fillText(b[1], x + 16, y + 68);
    });
    g.fillStyle = "#8b98ab"; g.font = font("600", 24); g.textAlign = "right"; g.fillText(HASHTAG, W - 64, H - 50);
    return cv;
  }
  $("shareImg").addEventListener("click", async () => {
    const card = shareCard || currentCard();
    const cv = drawCardImage(card);
    const blob = await new Promise(res => cv.toBlob(res, "image/png"));
    if (!blob) { toast("画像を作成できませんでした", "err"); return; }
    const file = new File([blob], "future-trade-result.png", { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: $("shareText").value });
        return;
      }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "future-trade-result.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("成績カードの画像を保存しました", "buy");
  });

  // ======================= 取引の振り返りチャート =======================
  // ラウンド中に「みんなに見えていた価格」の推移と、自分の売買ポイントを描く
  function replayData(trades) {
    if (!challenge) return null;
    const count = {};
    trades.forEach(t => { count[t.k] = (count[t.k] || 0) + 1; });
    const k = Object.keys(count).sort((x, y) => count[y] - count[x])[0] || currentSym;
    const bars = engines[k].bars, pts = [];
    for (let m = challenge.a; m <= challenge.b; m += 1000) {
      const t = Math.floor((marketEpoch + m - DELAY_MS) / 1000) * 1000;
      const i = Math.min(bars.length - 1, Math.max(0, lowerBound(bars, t)));
      if (bars[i]) pts.push({ m, p: bars[i].c });
    }
    return { k, pts, trades: trades.filter(t => t.k === k) };
  }
  function drawReplay(g, X, Y, W, H, data, theme) {
    if (!data || data.pts.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    data.pts.forEach(p => { lo = Math.min(lo, p.p); hi = Math.max(hi, p.p); });
    data.trades.forEach(t => { lo = Math.min(lo, t.ep, t.xp); hi = Math.max(hi, t.ep, t.xp); });
    const pad = (hi - lo) * 0.12 || INSTRUMENTS[data.k].tick * 5; lo -= pad; hi += pad;
    const a = challenge.a, b = challenge.b;
    const x = (m) => X + ((m - a) / (b - a)) * W;
    const y = (p) => Y + (1 - (p - lo) / (hi - lo)) * H;
    g.save();
    g.strokeStyle = theme.grid; g.lineWidth = 1;
    for (let i = 1; i < 5; i++) { const gx = X + (W * i) / 5; g.beginPath(); g.moveTo(gx, Y); g.lineTo(gx, Y + H); g.stroke(); }
    g.strokeStyle = theme.line; g.lineWidth = theme.lw; g.beginPath();
    data.pts.forEach((p, i) => { if (i) g.lineTo(x(p.m), y(p.p)); else g.moveTo(x(p.m), y(p.p)); });
    g.stroke();
    data.trades.forEach(t => {
      const win = (t.xp - t.ep) * (t.d === "buy" ? 1 : -1) >= 0;
      g.setLineDash([4, 3]); g.strokeStyle = win ? theme.up : theme.down; g.lineWidth = theme.lw * 0.8;
      g.beginPath(); g.moveTo(x(t.em), y(t.ep)); g.lineTo(x(t.xm), y(t.xp)); g.stroke(); g.setLineDash([]);
      const ex = x(t.em), ey = y(t.ep), s = theme.mk;
      g.fillStyle = t.d === "buy" ? theme.up : theme.down; g.beginPath();
      if (t.d === "buy") { g.moveTo(ex, ey - s); g.lineTo(ex - s, ey + s * 0.8); g.lineTo(ex + s, ey + s * 0.8); }
      else { g.moveTo(ex, ey + s); g.lineTo(ex - s, ey - s * 0.8); g.lineTo(ex + s, ey - s * 0.8); }
      g.closePath(); g.fill();
      g.fillStyle = theme.bg; g.strokeStyle = win ? theme.up : theme.down; g.lineWidth = theme.lw;
      g.beginPath(); g.arc(x(t.xm), y(t.xp), s * 0.7, 0, Math.PI * 2); g.fill(); g.stroke();
    });
    g.fillStyle = theme.dim; g.font = theme.font;
    ["0:00", "1:00", "2:00", "3:00", "4:00", "5:00"].forEach((l, i) => {
      const lx = X + (W * i) / 5, tw = g.measureText(l).width;
      g.fillText(l, Math.min(Math.max(lx - tw / 2, X), X + W - tw), Y + H + theme.fs + 4);
    });
    g.restore();
  }
  function renderReplay() {
    const cv = $("replayCv"), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
    const data = replayData(lastRound ? lastRound.tradeList : []);
    $("replaySym").textContent = data ? INSTRUMENTS[data.k].code + (data.trades.length ? "・" + data.trades.length + "件" : "・取引なし") : "";
    drawReplay(g, 4, 6, r.width - 8, r.height - 24, data, {
      grid: css("--grid-line"), line: css("--text-mid"), up: css("--buy"), down: css("--sell"), bg: css("--panel-2"),
      dim: css("--text-dim"), lw: 1.5, mk: 5, fs: 10, font: "10px 'JetBrains Mono', monospace"
    });
  }

  // ======================= 成績の検証（ランキング用） =======================
  // 取引記録を短い文字列にする： 銘柄,売買,数量,建て時刻,建値,決済時刻,決済値,スワップ ; ...
  function encodeLog(trades) {
    return trades.map(t => [SYM_KEYS.indexOf(t.k), t.d === "buy" ? "b" : "s", t.u, Math.round(t.em), fmtIn(t.k, t.ep),
      Math.round(t.xm), fmtIn(t.k, t.xp), (Math.round(t.sw * 100) / 100)].join(",")).join(";");
  }
  function decodeLog(str) {
    if (typeof str !== "string" || !str) return [];
    return str.split(";").map(rec => {
      const f = rec.split(",");
      const k = SYM_KEYS[parseInt(f[0], 10)];
      if (f.length !== 8 || !k || (f[1] !== "b" && f[1] !== "s")) throw new Error("bad record");
      const n = f.slice(2).map(Number);
      if (n.some(v => !Number.isFinite(v))) throw new Error("bad number");
      return { k, d: f[1] === "b" ? "buy" : "sell", u: n[0], em: n[1], ep: n[2], xm: n[3], xp: n[4], sw: n[5] };
    });
  }
  // シード値から相場を作り直し、各取引の価格がその時点の相場と一致するか、損益の合計が最終資産と合うかを調べる
  function verifyRound(seed, equity, logStr) {
    let trades;
    try { trades = decodeLog(logStr); } catch (e) { return { ok: false, msg: "取引記録の形式が不正です" }; }
    if (trades.length > 400) return { ok: false, msg: "取引記録が多すぎます" };
    const from = -DELAY_MS - 2000, to = TA_MS + 2000;
    const series = {};
    SYM_KEYS.forEach(k => {
      const c = INSTRUMENTS[k];
      const st = { price: c.start, center: c.start, rng: mulberry32(((seed >>> 0) ^ (SYM_SALT[k] || 0)) >>> 0) };
      const arr = [];
      let base = null;
      for (let m = GRID_START; m <= to; m += TICK_MS) {
        stepPrice(k, st);
        if (m >= from) { if (base === null) base = m; arr.push(st.price); }
      }
      series[k] = { arr, base };
    });
    const pubAt = (k, m) => {
      const s = series[k], idx = Math.floor((m - DELAY_MS - s.base) / TICK_MS);
      return s.arr[clamp(idx, 0, s.arr.length - 1)];
    };
    const near = (k, m, price) => {
      let best = Infinity;
      for (let mm = m - 800; mm <= m; mm += TICK_MS) best = Math.min(best, Math.abs(price - pubAt(k, mm)));
      return best;
    };
    let total = START_BALANCE;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i], c = INSTRUMENTS[t.k], no = "取引" + (i + 1) + "件目";
      if (t.em < 0 || t.xm < t.em || t.xm > TA_MS + 2000) return { ok: false, msg: no + "の時刻が5分間の範囲外です" };
      if (t.u < c.minUnit || t.u > c.maxUnit || t.u % c.minUnit !== 0) return { ok: false, msg: no + "の数量が不正です" };
      const tol = c.spread * 4.5 + c.tick;
      if (near(t.k, t.em, t.ep) > tol) return { ok: false, msg: no + "の建値が、その時点の相場と一致しません" };
      if (near(t.k, t.xm, t.xp) > tol) return { ok: false, msg: no + "の決済値が、その時点の相場と一致しません" };
      const carryMax = t.u * t.ep * 0.0002 * Math.max(1, t.xm - t.em) / 86400000 + 1;
      if (Math.abs(t.sw) > carryMax) return { ok: false, msg: no + "のスワップ・金利が不自然です" };
      total += (t.xp - t.ep) * t.u * (t.d === "buy" ? 1 : -1) + t.sw;
    }
    if (Math.abs(total - equity) > 2 + trades.length * 0.5) return { ok: false, msg: "取引の損益合計（" + fmtYen(total) + "）と最終資産が一致しません" };
    return { ok: true, msg: "取引" + trades.length + "件がすべて相場と一致し、損益の合計も最終資産と合っています" };
  }

  // ======================= ランキング（Firestore・5分タイムアタックのみ） =======================
  function waitRankingReady(timeoutMs) {
    if (window.Ranking) return Promise.resolve(window.Ranking);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { window.removeEventListener("ranking-ready", onReady); reject(new Error("timeout")); }, timeoutMs || 6000);
      function onReady() { clearTimeout(t); resolve(window.Ranking); }
      window.addEventListener("ranking-ready", onReady, { once: true });
    });
  }
  const PERIOD_J = { all: "全期間", week: "今週", day: "今日" };
  $("resRankBtn").addEventListener("click", async () => {
    if (!lastRound || lastRound.mode !== "ta" || lastRound.submitted) return;
    if (!nickConfirmed) { await openNicknameModal(false); lastRound.nickname = nickname; }   // 初めての登録で名前を決めてもらう
    const btn = $("resRankBtn"), note = $("resRankNote");
    btn.disabled = true;
    note.textContent = "登録しています…";
    try {
      const api = await waitRankingReady();
      const res = await api.submitBest(lastRound);
      if (res.tooHigh) { note.textContent = "記録が上限（" + fmtYen(api.EQUITY_CAP) + "）を超えているため登録できません"; lastRound.submitted = true; return; }
      const parts = [], order = ["day", "week", "all"];
      let anyOk = false, anyErr = false, rateLimited = false;
      order.forEach(p => {
        const r = res.results.find(x => x.period === p);
        if (!r) return;
        if (r.status === "created") { parts.push(PERIOD_J[p] + "：登録"); anyOk = true; }
        else if (r.status === "updated") { parts.push(PERIOD_J[p] + "：自己ベスト更新"); anyOk = true; }
        else if (r.status === "notBest") parts.push(PERIOD_J[p] + "：自己ベスト（" + fmtYen(r.best) + "）未満");
        else { anyErr = true; if (/permission/i.test(r.error || "")) rateLimited = true; }
      });
      if (anyErr) parts.push(rateLimited ? "一部登録できませんでした（前回の登録から60秒以上あけてください）" : "一部の登録に失敗しました");
      note.textContent = parts.join(" / ");
      if (anyOk) { toast("ランキングに登録しました", "buy"); sfx("win"); }
      lastRound.submitted = !anyErr;
      btn.disabled = !anyErr ? true : false;
    } catch (e) {
      note.textContent = "登録に失敗しました（通信状態を確認して、もう一度お試しください）";
      btn.disabled = false;
      console.error(e);
    }
  });

  function renderRankRows(rows) {
    const body = $("rankBody");
    if (!rows.length) { body.innerHTML = '<tr><td class="empty-row" colspan="6">まだ登録がありません。最初の1件になってみませんか？</td></tr>'; return; }
    body.innerHTML = "";
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const me = window.Ranking && window.Ranking.myId ? window.Ranking.myId() : null;
      if (me && r.id === me) tr.className = "me";
      // 他人が書き込んだデータなので、数値は必ず数値に変換し、文字列はエスケープしてから表示する
      const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const equity = toNum(r.equity), ret = toNum(r.ret), trades = Math.round(toNum(r.trades));
      tr.innerHTML =
        '<td class="rnk">' + (i + 1) + "</td>" +
        "<td>" + escapeHtml(String(r.nickname || "名無し").slice(0, 20)) + "</td>" +
        '<td class="mono">' + fmtYen(equity) + "</td>" +
        '<td class="mono ' + (ret >= 0 ? "pos" : "neg") + '">' + (ret >= 0 ? "+" : "") + ret.toFixed(2) + "%</td>" +
        '<td class="mono">' + trades + "回</td><td></td>";
      const cell = tr.lastElementChild;
      if (Number.isInteger(r.seed) && typeof r.log === "string") {
        const b = document.createElement("button");
        b.className = "vfy"; b.textContent = "検証";
        b.addEventListener("click", () => {
          b.textContent = "…";
          setTimeout(() => {
            const v = verifyRound(r.seed, equity, r.log);
            b.textContent = v.ok ? "✓ 本物" : "✗ 不一致";
            b.className = "vfy " + (v.ok ? "ok" : "ng");
            b.title = v.msg;
            toast((v.ok ? "検証OK：" : "検証NG：") + v.msg, v.ok ? "buy" : "err");
          }, 20);
        });
        cell.appendChild(b);
      } else cell.textContent = "-";
      body.appendChild(tr);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  let rankPeriod = "day";
  let rankReq = 0;   // タブを素早く切り替えたとき、前のタブの遅れて届いた結果で上書きしないための通し番号
  async function openRanking() {
    const req = ++rankReq;
    $("rankModal").hidden = false;
    $("rankTabs").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.p === rankPeriod));
    $("rankBody").innerHTML = '<tr><td class="empty-row" colspan="6">読み込み中…</td></tr>';
    try {
      const api = await waitRankingReady();
      const rows = await api.fetchTop(rankPeriod, 20);
      if (req !== rankReq) return;
      renderRankRows(rows);
    } catch (e) {
      if (req !== rankReq) return;
      $("rankBody").innerHTML = '<tr><td class="empty-row" colspan="6">読み込みに失敗しました（時間をおいて「更新」をお試しください）</td></tr>';
      console.error(e);
    }
  }
  $("rankTabs").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { rankPeriod = b.dataset.p; openRanking(); }));
  $("rankBtn").addEventListener("click", openRanking);
  $("rankRefreshBtn").addEventListener("click", openRanking);
  $("rankClose").addEventListener("click", () => { $("rankModal").hidden = true; });
  $("rankModal").addEventListener("click", (e) => { if (e.target.id === "rankModal") $("rankModal").hidden = true; });
  $("shareClose").addEventListener("click", () => { $("shareModal").hidden = true; });
  $("chalUrlCopy").addEventListener("click", () => {
    const inp = $("chalUrl");
    const done = () => toast("挑戦状URLをコピーしました", "buy");
    const fallback = () => { inp.focus(); inp.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (e) {} if (ok) done(); else toast("URLを選択しました。コピーして使ってください", "warn"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(done, fallback);
    else fallback();
  });
  $("shareModal").addEventListener("click", (e) => { if (e.target.id === "shareModal") $("shareModal").hidden = true; });
  $("shareCopy").addEventListener("click", () => {
    const ta = $("shareText");
    const done = () => toast("ポスト用のテキストをコピーしました", "buy");
    const fallback = () => {
      ta.focus(); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      if (ok) done(); else toast("テキストを選択しました。コピーして使ってください", "warn");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value + ($("chalUrl").value ? "\n" + $("chalUrl").value : "")).then(done, fallback);
    else fallback();
  });

  // ======================= 挑戦状 =======================
  // 時間制限つきラウンド。mode: "ta"（5分タイムアタック）| "chal"（受け取った挑戦状）
  let challenge = null;        // { mode, s, a, b, n, e, t }
  let challengeOver = false;   // 制限時間を迎えたか
  let roundStartM = 0;         // 今のラウンドの開始点（相場時刻）
  const TA_MS = 5 * 60 * 1000;   // タイムアタック・挑戦状の制限時間（5分）

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
  }
  // URLに入ってくる値は他人が自由に書き換えられるので、すべて型と範囲をチェックする
  function parseChallenge() {
    const m = String(location.hash || "").match(/[#&]c=([A-Za-z0-9_-]{8,600})/);
    if (!m) return null;
    try {
      const o = JSON.parse(b64urlDecode(m[1]));
      const ok = o && o.v === 3 &&
        Number.isInteger(o.s) && o.s >= 0 && o.s <= 4294967295 &&
        Number.isFinite(o.a) && Number.isFinite(o.b) &&
        o.a >= 0 && o.a <= 24 * 3600 * 1000 && Math.abs((o.b - o.a) - TA_MS) < TICK_MS;   // 5分勝負のみ受け付ける
      if (!ok) return null;
      const eq = Number(o.e);
      return {
        mode: "chal",
        s: o.s >>> 0,
        a: Math.round(o.a / TICK_MS) * TICK_MS,
        b: Math.round(o.a / TICK_MS) * TICK_MS + TA_MS,
        n: sanitizeNickname(String(o.n || "")) || "名無しの未来人",
        e: Number.isFinite(eq) ? clamp(eq, 0, 1e10) : START_BALANCE,
        t: Number.isInteger(o.t) ? clamp(o.t, 0, 100000) : 0
      };
    } catch (err) { return null; }
  }
  // 自分のサイト（GitHub Pages等）で開いているならそのURLを、claude.ai上やローカルファイルならSHARE_URLを使う
  function shareBaseUrl() {
    const h = location.hostname || "";
    const onClaude = /(^|\.)claude\.(ai|com)$|claudeusercontent\.com$/.test(h);
    if (/^https?:$/.test(location.protocol) && h && !onClaude) return location.origin + location.pathname;
    return SHARE_URL.split("#")[0];
  }
  function buildChallengeUrl(equity) {
    const range = challenge ? { a: challenge.a, b: challenge.b } : { a: roundStartM, b: currentM() };
    const payload = { v: 3, s: marketSeed, a: Math.round(range.a), b: Math.round(range.b), n: nickname || "", e: Math.round(equity), t: stats.trades };
    return shareBaseUrl() + "#c=" + b64urlEncode(JSON.stringify(payload));
  }
  function fmtDur(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return (h ? h + ":" + p(mm) : p(mm)) + ":" + p(ss);
  }
  function fmtDurJ(ms) {
    const sec = Math.round(ms / 1000), mm = Math.floor(sec / 60), ss = sec % 60;
    return (mm ? mm + "分" : "") + (ss || !mm ? ss + "秒" : "");
  }
  function resetAbility() {
    futureState = "ready"; futureRemain = FUTURE_MAX_SEC; futureVisible = false;
    renderLegend(); updateFutureButton();
  }

  function showChallengeIntro(ch) {
    $("chalFrom").textContent = ch.n;
    $("chalEquity").textContent = fmtYen(ch.e);
    const diff = ch.e - START_BALANCE;
    const ret = $("chalRet");
    ret.textContent = fmtSYen(diff) + "（" + (diff >= 0 ? "+" : "") + ((diff / START_BALANCE) * 100).toFixed(2) + "%）";
    ret.className = "mono " + (diff >= 0 ? "pos" : "neg");
    $("chalDur").textContent = fmtDurJ(ch.b - ch.a);
    $("chalModal").hidden = false;
    $("chalAccept").onclick = () => { $("chalModal").hidden = true; startChallenge(ch); toast("挑戦開始！制限時間は" + fmtDurJ(ch.b - ch.a) + "です", "warn"); };
    $("chalDecline").onclick = () => { $("chalModal").hidden = true; exitChallenge(); };
  }
  function startChallenge(ch) {
    challenge = ch;
    challengeOver = false;
    lastRound = null;
    initMarket(ch.s, ch.a);
    roundStartM = ch.a;
    resetAccount();
    resetAbility();
    view.offset = 0;
    $("resetBtn").textContent = ch.mode === "ta" ? "中断する" : "最初から挑戦";
    $("taBtn").disabled = true;
    $("chalResultModal").hidden = true;
    tickRound();
  }
  // 新しいランダム相場で5分タイムアタックを始める
  function startTimeAttack() {
    startChallenge({ mode: "ta", s: randomSeed(), a: 0, b: TA_MS, n: null, e: null, t: 0 });
    toast("5分タイムアタック開始！", "warn");
  }
  function exitChallenge() {
    challenge = null;
    challengeOver = false;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (err) {}
    initMarket(randomSeed(), 0);
    roundStartM = 0;
    resetAccount();
    resetAbility();
    view.offset = 0;
    $("resetBtn").textContent = "資産をリセット";
    $("taBtn").disabled = false;
    $("chalResultModal").hidden = true;
    tickRound();
  }
  let lastBeepSec = null;
  function tickRound() {
    const badge = $("roundBadge");
    if (challenge) {
      const remain = challenge.b - currentM();
      const label = challenge.mode === "ta" ? "⏱ タイムアタック" : "⚔ vs " + challenge.n;
      badge.className = "round-badge chal" + (remain <= 30000 && !challengeOver ? " hurry" : "");
      badge.textContent = challengeOver ? label + "　終了" : label + "　残り " + fmtDur(remain);
      if (!challengeOver && remain > 0 && remain <= 10000) {
        const sec = Math.ceil(remain / 1000);
        if (sec !== lastBeepSec) { lastBeepSec = sec; sfx("tick"); }
      }
      if (remain <= 0 && !challengeOver) finishRoundIfDue();
    } else {
      badge.className = "round-badge";
      badge.textContent = "プレイ時間 " + fmtDur(currentM() - roundStartM);
    }
  }
  let lastRound = null;   // 直近に終わったラウンドの成績（ランキング登録・シェアに使う）
  function roundSummary() {
    const equity = balance, diff = equity - START_BALANCE, ret = (diff / START_BALANCE) * 100;
    const winRate = stats.trades ? Math.round((stats.wins / stats.trades) * 100) : 0;
    const futureRate = stats.trades ? Math.round((stats.futureTrades / stats.trades) * 100) : 0;
    return { nickname, equity, ret, trades: stats.trades, winRate, futureRate, rank: rankOf(ret, stats.trades) };
  }
  function endChallenge() {
    challengeOver = true;
    positions.slice().forEach(p => closeAt(p, exitPriceOf(p), "時間切れ"));
    orders = [];
    renderPositions();
    updateStats();
    lastRound = Object.assign({ mode: challenge.mode, submitted: false, seed: marketSeed, log: encodeLog(roundTrades), tradeList: roundTrades.slice() }, roundSummary());
    const isTA = challenge.mode === "ta";
    $("taBlock").hidden = !isTA;
    $("vsBlock").hidden = isTA;
    $("resRankBtn").hidden = !isTA;
    $("resRankBtn").disabled = false;
    $("resRankNote").textContent = isTA ? "" : "挑戦状モードの成績はランキング対象外です";
    $("chalShareBtn").textContent = isTA ? "結果をシェアして挑戦状を送る" : "結果をシェアして挑戦し返す";
    $("chalRetry").textContent = isTA ? "もう一度（新しい相場）" : "同じ相場でもう一度";
    if (isTA) {
      const r = lastRound, diffTA = r.equity - START_BALANCE;
      const title = $("chalResultTitle");
      title.textContent = "タイムアップ！";
      title.className = "chal-result " + (diffTA > 0 ? "pos" : diffTA < 0 ? "neg" : "");
      $("taEq").textContent = fmtYen(r.equity);
      const tr = $("taRet");
      tr.textContent = fmtSYen(diffTA) + "（" + (r.ret >= 0 ? "+" : "") + r.ret.toFixed(2) + "%）";
      tr.className = "mono " + (diffTA >= 0 ? "pos" : "neg");
      $("taSub").textContent = "決済" + r.trades + "回・勝率" + (r.trades ? r.winRate + "%" : "-") + "・称号「" + r.rank + "」";
      $("chalResultMsg").textContent = diffTA > 0 ? "未来を味方につけられたようです。ランキングに登録して、挑戦状で友達にも勝負を挑んでみましょう。"
        : "未来が見えていても、勝つのは簡単ではないようです。同じ相場の挑戦状を送って、友達ならどうなるか試してみましょう。";
      $("chalResultModal").hidden = false;
      requestAnimationFrame(renderReplay);
      return;
    }
    const mine = balance, opp = challenge.e, diff = mine - opp;
    const win = diff > 0, draw = Math.round(diff) === 0;
    const title = $("chalResultTitle");
    title.textContent = draw ? "引き分け" : win ? "挑戦成功！" : "挑戦失敗…";
    title.className = "chal-result " + (draw ? "" : win ? "pos" : "neg");
    $("vsMeName").textContent = (nickname || "あなた") + "（あなた）";
    $("vsMeEq").textContent = fmtYen(mine);
    $("vsOppName").textContent = challenge.n;
    $("vsOppEq").textContent = fmtYen(opp);
    $("chalResultMsg").textContent = draw
      ? "まったく同じ資産でした。未来の見え方まで同じだったのかもしれません。"
      : win ? challenge.n + "さんに" + fmtYen(diff) + "差で勝利しました。同じ相場を見ていたのに、何が違ったのでしょうか。"
            : challenge.n + "さんに" + fmtYen(-diff) + "差で敗北しました。同じ未来が見えていたはずですが…";
    $("chalResultModal").hidden = false;
    requestAnimationFrame(renderReplay);
  }
  $("chalShareBtn").addEventListener("click", () => { $("chalResultModal").hidden = true; openShare(); });
  $("chalRetry").addEventListener("click", () => {
    if (challenge && challenge.mode === "ta") { startTimeAttack(); return; }
    startChallenge(challenge); toast("同じ相場で、最初から挑戦し直します", "warn");
  });
  $("chalFree").addEventListener("click", () => { exitChallenge(); toast("新しい相場で、フリープレイを始めました", "warn"); });

  // ======================= 効果音の切り替え =======================
  $("soundBtn").addEventListener("click", () => {
    soundOn = !soundOn;
    try { window.localStorage.setItem("futurefx_sound", soundOn ? "on" : "off"); } catch (e) {}
    renderSoundBtn();
    if (soundOn) sfx("open");
  });
  renderSoundBtn();

  // ======================= タイムアタック開始 =======================
  $("taBtn").addEventListener("click", () => { if (!challenge) $("taModal").hidden = false; });
  $("taStart").addEventListener("click", () => { $("taModal").hidden = true; startTimeAttack(); });
  $("taCancel").addEventListener("click", () => { $("taModal").hidden = true; });

  // ======================= スマホ用の操作バー =======================
  $("mSell").addEventListener("click", () => { if (validQty(currentSym, order.qty[currentSym])) marketOrder(currentSym, "sell", order.qty[currentSym], null, null, "成行"); });
  $("mBuy").addEventListener("click", () => { if (validQty(currentSym, order.qty[currentSym])) marketOrder(currentSym, "buy", order.qty[currentSym], null, null, "成行"); });
  $("mClose").addEventListener("click", () => {
    if (!positions.length) { toast("決済する建玉がありません", "warn"); return; }
    positions.slice().forEach(p => closeManual(p)); renderPositions();
  });
  $("mQty").addEventListener("click", () => {
    const lots = INSTRUMENTS[currentSym].lots, cur = order.qty[currentSym];
    const next = lots[(lots.indexOf(cur) + 1) % lots.length] || lots[0];
    order.qty[currentSym] = next; qtyInput.value = next; renderLots(); updateOrderPanel();
  });
  function updateMobileBar() {
    const k = currentSym;
    $("mSellPx").textContent = fmtP(k, bidOf(k));
    $("mBuyPx").textContent = fmtP(k, askOf(k));
    $("mQtyLabel").textContent = fmtQtyShort(k, order.qty[k] || 0);
    const pl = floatingTotal(), el = $("mPnl");
    el.textContent = fmtSYen(pl);
    el.style.color = pl > 0 ? "var(--buy)" : pl < 0 ? "var(--sell)" : "";
  }

  // ======================= メインループ =======================
  // 相場時刻 m：ゲーム開始点を0とした経過ミリ秒。相場は m の固定グリッド（200ms刻み）で1歩ずつ進むので、
  // 同じシードなら、タブを裏に回していても必ず同じ値動きになる
  let lastWall = Date.now();
  function catchUp(now) {
    const m = now - marketEpoch;
    if (m - nextM > TICK_MS * 3) {
      // 裏タブ等で止まっていた間の相場をまとめて生成。その間のニュースは出さない
      backfilling = true; advanceTo(m - TICK_MS); backfilling = false;
    }
    advanceTo(m);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

  // ラウンドの終了時刻を過ぎていたら、終了時刻ちょうどの相場で締める（裏タブで遅れて戻ってきても公平に）
  function finishRoundIfDue() {
    if (!challenge || challengeOver || Date.now() - marketEpoch < challenge.b) return;
    const endWall = marketEpoch + challenge.b;
    catchUp(endWall);
    updatePub(endWall, true);
    accrueCarry(Math.max(0, endWall - lastWall));
    lastWall = Math.max(lastWall, endWall);
    clockM = challenge.b;
    try { processTriggers(); endChallenge(); } finally { clockM = null; }
    sfx("end");
  }
  function tick() {
    finishRoundIfDue();
    const now = Date.now();
    const dt = Math.min(Math.max(now - lastWall, 0), BACKFILL_MS);
    lastWall = now;
    catchUp(now);
    updatePub(now, false);
    while (newsQueue.length && newsQueue[0].at <= now) pushNews(newsQueue.shift().text);
    accrueCarry(dt);
    processTriggers();
    checkLosscut();

    const k = currentSym, c = INSTRUMENTS[k], e = engines[k];
    $("bidBox").textContent = fmtP(k, bidOf(k));
    $("askBox").textContent = fmtP(k, askOf(k));
    const sp = askOf(k) - bidOf(k);
    const spEl = $("spreadBox");
    spEl.textContent = c.kind === "fx" ? (sp * 100).toFixed(1) : Math.round(sp);
    spEl.classList.toggle("wide", e.spreadMult > 1.4);
    const lb = $("chLimit");
    lb.hidden = e.limitState === 0;
    lb.className = "limit-badge " + (e.limitState === 1 ? "up" : "down");
    lb.textContent = e.limitState === 1 ? "ストップ高" : "ストップ安";

    tickFutureAbility(dt);
    tickRound();
    updateMobileBar();
    updateOrderPanel();
    updateOpenPnl();
    updateStats();
    renderBoard();
    drawChart();
  }

  // 起動時：挑戦状URLがあればその相場を、なければ新しいランダム相場を生成
  const incoming = parseChallenge();
  if (incoming) {
    initMarket(incoming.s, incoming.a);
    roundStartM = incoming.a;
    showChallengeIntro(incoming);
  } else {
    initMarket(randomSeed(), 0);
    roundStartM = 0;
  }

  function syncTopbarHeight() {
    document.documentElement.style.setProperty("--topbar-h", document.querySelector(".topbar").offsetHeight + "px");
  }
  syncTopbarHeight();
  window.addEventListener("resize", syncTopbarHeight);

  renderLegend();
  updateFutureButton();
  resetHistory();
  setDirection("buy");
  switchSymbol("crnjpy");
  renderPositions();
  resizeCanvas();
  setInterval(tick, TICK_MS);
  tick();
})();
