"""ウォルナットモードのテスト（モード切り替え・枚数・未来視点1回・ロスカット20%・ゼロカット・称号・専用ランキング・挑戦状）。
tests/run_tests.sh から実行する（テスト用ビルドを http://127.0.0.1:8765 で配信している前提）。"""
import os; os.makedirs("tests/out", exist_ok=True)
import sys; URL_BASE = os.environ.get("TEST_BASE", "http://127.0.0.1:8765")
from playwright.sync_api import sync_playwright
import json, base64
FF = lambda ms: f"() => {{ if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + {ms}; Date.now = () => window.__real() + window.__off; }}"
results = []; errs = []
def check(name, cond, detail=""):
    results.append(("OK " if cond else "NG ") + name + (f"  ({detail})" if detail else ""))
def attach(pg, tag):
    pg.add_init_script("document.addEventListener('securitypolicyviolation', e => console.error('CSP違反: ' + e.violatedDirective + ' ' + e.blockedURI))")
    pg.on("pageerror", lambda e: errs.append(f"[{tag}] pageerror: {e}"))
    pg.on("console", lambda m: errs.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)
yen = lambda s: int(s.replace("¥", "").replace(",", "").replace("+", "").replace("±", ""))
# みんなに見えている価格（30秒前）を d 円だけ急落させ、直前に急変（ヒゲ）があったことにする
CRASH = "d => { const e = window.__eng.wlnt; e.ticks.forEach(x => { x.p -= d; }); e.flashT = Date.now() - 30000 - 1000; }"
URL = URL_BASE + "/index.html"
def to_walnut(pg):
    pg.click("#symBtn"); pg.click("#symMenu .dd-item[data-sym=wlnt]"); pg.wait_for_timeout(200)
    shown = pg.is_visible("#modeModal") and pg.is_visible("#modeWalnutBody")
    pg.click("#modeStart"); pg.wait_for_timeout(400)
    return shown
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1500, "height": 950})
    pg = ctx.new_page(); attach(pg, "PC")
    pg.goto(URL); pg.wait_for_timeout(600); pg.click("#helpClose")
    # --- モード切り替え ---
    check("銘柄メニューにウォルナットモードの見出しとWLNT", pg.locator("#symMenu .dd-head.wn").count() == 1 and pg.locator("#symMenu .dd-item[data-sym=wlnt]").count() == 1)
    check("WLNTを選ぶと説明つきの確認画面", to_walnut(pg))
    check("ウォルナットモード：軍資金30万円・レバレッジ100倍・WLNT/JPY",
          pg.inner_text("#balanceVal") == "¥300,000" and pg.inner_text("#leverageLabel") == "100倍" and pg.inner_text("#symBtnLabel") == "WLNT/JPY"
          and "walnut" in (pg.get_attribute("body", "class") or ""), pg.inner_text("#balanceVal"))
    lots = [pg.locator("#lotRow button").nth(i).inner_text() for i in range(pg.locator("#lotRow button").count())]
    check("数量は枚（1枚・5枚・10枚・30枚）", lots == ["1枚", "5枚", "10枚", "30枚"] and pg.inner_text("#qtyUnit") == "枚", " ".join(lots))
    pg.click("#lotRow button:nth-child(4)"); pg.wait_for_timeout(250)
    ask = float(pg.inner_text("#dirBuyPx"))
    margin = yen(pg.inner_text("#marginLabel"))
    check("30枚を選ぶと数量欄は30（枚）", pg.input_value("#qtyInput") == "30")
    check("30枚の必要証拠金＝30万通貨×レート÷100", abs(margin - ask * 300000 / 100) < 400 and margin <= 300000, f"{margin} / ask {ask}")
    check("銘柄はWLNTだけ（通常の銘柄の相場は動かさない）", pg.evaluate("() => Object.keys(window.__eng).includes('wlnt')"))
    sp = []
    for i in range(6): sp.append(float(pg.inner_text("#spreadBox"))); pg.wait_for_timeout(250)
    check("ふだんのスプレッドは0.5銭", min(sp) == 0.5, " ".join(map(str, sp)))
    check("チャートの上に指標発表の予告", pg.is_visible("#evBadge") and "まで" in pg.inner_text("#evBadge"), pg.inner_text("#evBadge"))
    # --- 未来視点は1回だけ ---
    check("未来視点の残り回数表示", "あと1回" in pg.inner_text("#futureToggle"), pg.inner_text("#futureToggle"))
    pg.click("#futureToggle"); pg.wait_for_timeout(300)
    on = "残り" in pg.inner_text("#futureToggle") and "秒" in pg.inner_text("#futureToggle")
    pg.click("#futureToggle"); pg.wait_for_timeout(300)
    check("未来視点を1回使うと使用済み（クールダウンなし）", on and "使用済" in pg.inner_text("#futureToggle") and pg.is_disabled("#futureToggle"), pg.inner_text("#futureToggle"))
    pg.evaluate(FF(61000)); pg.wait_for_timeout(600)
    check("時間がたっても使用済みのまま", "使用済" in pg.inner_text("#futureToggle"))
    pg.click("#resetBtn"); pg.click("#resetBtn"); pg.wait_for_timeout(300)
    check("資産リセットで30万円・未来視点も1回に戻る", pg.inner_text("#balanceVal") == "¥300,000" and "あと1回" in pg.inner_text("#futureToggle"))
    # --- 30枚の売買 ---
    pg.click("#lotRow button:nth-child(4)"); pg.click("#qBuy"); pg.wait_for_timeout(300)
    check("30枚の買い（建玉の数量は枚で表示）", pg.locator("#openBody tr").count() == 1 and pg.locator("#openBody tr td").nth(1).inner_text() == "30")
    check("30枚を持つと余力はほぼ0", yen(pg.inner_text("#freeMarginLabel")) < 20000, pg.inner_text("#freeMarginLabel"))
    pg.click("#qBuy"); pg.wait_for_timeout(300)
    check("証拠金不足で31枚目は約定しない", pg.locator("#openBody tr").count() == 1)
    # --- ロスカット20%・ゼロカット・割られたくるみ ---
    pg.evaluate(CRASH, 2.0); pg.wait_for_timeout(600)
    toasts = pg.inner_text("#toastWrap")
    check("急落で証拠金維持率20%のロスカット", "建玉はありません" in pg.inner_text("#openBody") and "20%" in toasts, toasts.replace("\n", " / ")[:120])
    check("ゼロカットで残高は0円（マイナスにならない）", pg.inner_text("#balanceVal") == "¥0" and "ゼロカット" in toasts, pg.inner_text("#balanceVal"))
    check("資金が尽きたら退場の案内", "退場" in toasts)
    pg.click("#shareBtn"); pg.wait_for_timeout(200)
    check("ヒゲでロスカット →称号「割られたくるみ」", pg.inner_text("#rcRank") == "「割られたくるみ」" and "30万円" in pg.input_value("#shareText"), pg.inner_text("#rcRank"))
    pg.click("#shareClose")
    pg.click("#resetBtn"); pg.click("#resetBtn"); pg.wait_for_timeout(300)
    # 維持率が20%を少し上回る下げではロスカットされない（50%の通常モードとの違い）
    pg.click("#lotRow button:nth-child(4)"); pg.click("#qBuy"); pg.wait_for_timeout(300)
    pg.evaluate("() => { window.__eng.wlnt.flashT = undefined; }")
    # 今の維持率から、維持率が約35%になる下げ幅を計算する（1円で30万円、必要証拠金≒3,000円×レート）
    lv0 = int(pg.inner_text("#marginLevel").rstrip("%")) / 100; mg = 3000 * float(pg.inner_text("#dirSellPx"))
    pg.evaluate("d => { window.__eng.wlnt.ticks.forEach(x => { x.p -= d; }); }", (lv0 - 0.35) * mg / 300000); pg.wait_for_timeout(600)
    ml = pg.inner_text("#marginLevel")
    check("維持率20%〜50%ではロスカットされない", pg.locator("#openBody tr").count() == 1 and 20 < int(ml.rstrip("%")) < 50, ml)
    pg.click("#closeAllBtn"); pg.wait_for_timeout(300)
    # --- ウォルナットの5分タイムアタック ---
    pg.click("#resetBtn"); pg.click("#resetBtn"); pg.wait_for_timeout(200)
    pg.click("#taBtn"); pg.wait_for_timeout(150)
    check("タイムアタックの説明がウォルナット用", "30万円" in pg.inner_text("#taModal") and "1回だけ" in pg.inner_text("#taModal"))
    pg.click("#taStart"); pg.wait_for_timeout(300)
    check("ウォルナットのタイムアタック開始", "タイムアタック" in pg.inner_text("#roundBadge") and pg.inner_text("#balanceVal") == "¥300,000" and "あと1回" in pg.inner_text("#futureToggle"))
    pg.click("#symBtn"); pg.click("#symMenu .dd-item[data-sym=crnjpy]"); pg.wait_for_timeout(200)
    check("タイムアタック中はモードを切り替えられない", pg.is_hidden("#modeModal") and pg.inner_text("#symBtnLabel") == "WLNT/JPY")
    # 相場再現の比較用に、開始直後の相場を控えておく（このあと指標発表の確認で早送りするため、ここで控える）
    mine = dict(map(tuple, pg.evaluate("""() => { const ep = window.__ep(); return window.__eng.wlnt.ticks.map(x => [x.t - ep, +x.p.toFixed(6)]); }""")))
    # --- 指標発表：予告 → 10秒前の案内 → 発表（ニュース・スプレッド拡大） ---
    t = pg.inner_text("#evBadge"); mm, ss = t.split("まで ")[1].split(":"); remain = (int(mm) * 60 + int(ss)) * 1000
    check("タイムアタックの指標発表は1:00〜4:00（みんなに見える価格）", 55000 <= remain <= 241000, t)
    pg.evaluate(FF(remain - 32000)); pg.wait_for_timeout(3000)    # 発表の瞬間（相場時刻）は早送りせずに通す
    pg.evaluate(FF(21000)); pg.wait_for_timeout(600)
    check("発表10秒前の案内", "まもなく" in pg.inner_text("#toastWrap") and "soon" in (pg.get_attribute("#evBadge", "class") or ""), pg.inner_text("#evBadge"))
    pg.evaluate(FF(10000)); pg.wait_for_timeout(800)
    news, spw = pg.inner_text("#newsText"), float(pg.inner_text("#spreadBox"))
    check("発表：ニュースが出て、スプレッドが大きく広がる", news.startswith("【指標】") and spw >= 3.0 and "発表" in pg.inner_text("#evBadge"), f"{news[:30]} / スプレッド{spw}銭")
    pg.click("#futureToggle")
    for i, lot in enumerate((1, 3, 2)):
        pg.click(f"#lotRow button:nth-child({lot})"); pg.click("#qBuy" if i % 2 == 0 else "#qSell"); pg.wait_for_timeout(900); pg.click("#closeAllBtn"); pg.wait_for_timeout(300)
    pg.click("#lotRow button:nth-child(2)"); pg.click("#qSell"); pg.wait_for_timeout(500)
    pg.evaluate(FF(301000)); pg.wait_for_timeout(1300)
    check("5分で自動終了・全決済", pg.is_visible("#chalResultModal") and "建玉はありません" in pg.inner_text("#openBody"))
    lr = pg.evaluate("() => { const r = window.__lr(); return { eq: Math.round(r.equity), ret: r.ret, seed: r.seed, log: r.log, n: r.tradeList.length, game: r.game }; }")
    check("成績にモード（walnut）が入る・記録の銘柄番号はWLNT", lr["game"] == "walnut" and lr["n"] == 4 and all(t.startswith("2,") for t in lr["log"].split(";")), lr["log"][:40])
    pg.click("#resRankBtn"); pg.wait_for_timeout(200)
    pg.fill("#nickInput", "くるみテスト"); pg.click("#nickConfirm"); pg.wait_for_timeout(400)
    sub = pg.evaluate("() => window.__sub[window.__sub.length - 1]")
    check("専用ランキングへの登録データ（game=walnut・損益率は30万円基準）",
          sub and sub["game"] == "walnut" and abs(sub["ret"] - (sub["equity"] - 300000) / 3000) < 0.01 and sub["log"] == lr["log"], pg.inner_text("#resRankNote"))
    pg.click("#chalShareBtn"); pg.wait_for_timeout(300)
    url = pg.input_value("#chalUrl")
    payload = json.loads(base64.urlsafe_b64decode(url.split("#c=")[1] + "==").decode("utf-8"))
    check("挑戦状URLはv6・モードつき", payload.get("v") == 6 and payload.get("g") == "w", str(payload)[:80])
    check("シェア文にウォルナットモード", "ウォルナット" in pg.input_value("#shareText") and "ウォルナット" in pg.inner_text("#rcDate"))
    pg.click("#shareClose")
    # 検証（ウォルナットのランキングとして本物・改ざん、通常のランキングとしては不一致）
    pg.evaluate("r => { window.__fetch = []; window.__rows = [{id:'me',nickname:'本物',equity:r.eq,ret:r.ret,trades:r.n,seed:r.seed,log:r.log},{id:'x',nickname:'改ざん',equity:r.eq+100000,ret:30,trades:r.n,seed:r.seed,log:r.log}]; }", lr)
    pg.click("#rankBtn"); pg.wait_for_timeout(300)
    check("ランキングは今のモード（ウォルナット）から開く", pg.evaluate("() => window.__fetch[0]") == "walnut" and "ウォルナット" in pg.inner_text("#rankTitle")
          and "active" in (pg.get_attribute("#rankModeTabs button[data-g=walnut]", "class") or ""))
    for i in range(2): pg.locator("#rankBody .vfy").nth(i).click(); pg.wait_for_timeout(700)
    v = [pg.locator("#rankBody .vfy").nth(i).inner_text() for i in range(2)]
    check("検証（ウォルナット）：本物は✓、改ざんは✗", v[0].startswith("✓") and v[1].startswith("✗"), " / ".join(v))
    pg.click("#rankModeTabs button[data-g=normal]"); pg.wait_for_timeout(300)
    pg.locator("#rankBody .vfy").nth(0).click(); pg.wait_for_timeout(700)
    check("通常のタブへ切替・ウォルナットの記録は通常のランキングとしては✗", pg.evaluate("() => window.__fetch[window.__fetch.length - 1]") == "normal"
          and pg.locator("#rankBody .vfy").nth(0).inner_text().startswith("✗"))
    pg.click("#rankClose")
    # --- 挑戦状を受け取る（別の人・通常モードの状態から） ---
    c = b.new_context(viewport={"width": 1400, "height": 900}).new_page(); attach(c, "挑戦者")
    c.goto(URL + "#c=" + url.split("#c=")[1]); c.wait_for_timeout(600)
    c.click("#helpClose")
    check("挑戦状：ウォルナットモードの表示", c.is_visible("#chalModal") and c.is_visible("#chalMode"))
    c.click("#chalAccept"); c.wait_for_timeout(1200)
    check("挑戦状：ウォルナットモード・30万円で開始", c.inner_text("#balanceVal") == "¥300,000" and c.inner_text("#symBtnLabel") == "WLNT/JPY" and "あと1回" in c.inner_text("#futureToggle"))
    theirs = dict(map(tuple, c.evaluate("() => { const ep = window.__ep(); return window.__eng.wlnt.ticks.slice(-150).map(x => [x.t - ep, +x.p.toFixed(6)]); }")))
    common = [m for m in theirs if m in mine]
    check("挑戦状：同じ相場の再現（WLNT）", len(common) >= 50 and all(mine[m] == theirs[m] for m in common), f"共通{len(common)}点")
    c.evaluate(FF(301000)); c.wait_for_timeout(1300)
    check("挑戦状：勝敗判定", c.is_visible("#chalResultModal") and c.is_visible("#vsBlock"), c.inner_text("#chalResultTitle"))
    c.click("#chalFree"); c.wait_for_timeout(400)
    check("挑戦後のフリープレイもウォルナットモード", c.inner_text("#balanceVal") == "¥300,000" and c.inner_text("#symBtnLabel") == "WLNT/JPY")
    # --- タイムアタック中に資金が尽きたら、その場で終了（退場） ---
    pg.click("#resetBtn"); pg.wait_for_timeout(300)   # 終わったタイムアタックを抜ける
    pg.click("#taBtn"); pg.click("#taStart"); pg.wait_for_timeout(400)
    pg.click("#lotRow button:nth-child(4)"); pg.click("#qBuy"); pg.wait_for_timeout(300)
    pg.evaluate(CRASH, 2.0); pg.wait_for_timeout(800)
    check("資金が尽きたらタイムアタックを途中で終了", pg.is_visible("#chalResultModal") and "割られたくるみ" in pg.inner_text("#taSub") and "終了" in pg.inner_text("#roundBadge"), pg.inner_text("#taSub"))
    # --- 通常モードに戻る ---
    pg.click("#chalFree"); pg.wait_for_timeout(300)
    pg.click("#symBtn"); pg.click("#symMenu .dd-item[data-sym=crnjpy]"); pg.wait_for_timeout(200)
    shown = pg.is_visible("#modeNormalBody")
    pg.click("#modeStart"); pg.wait_for_timeout(400)
    check("通常モードに戻る（100万円・25倍・未来視点は回数制限なし）", shown and pg.inner_text("#balanceVal") == "¥1,000,000" and pg.inner_text("#leverageLabel") == "25倍"
          and "walnut" not in (pg.get_attribute("body", "class") or "") and pg.inner_text("#futureToggle").strip().endswith("未来視点を使う"))
    pg.click("#rankBtn"); pg.wait_for_timeout(200)
    check("通常モードではランキングも通常から開く", pg.evaluate("() => window.__fetch[window.__fetch.length - 1]") == "normal")
    check("通常モードには指標発表の予告を出さない", pg.is_hidden("#evBadge"))
    pg.click("#rankClose")
    # --- スマホ ---
    m = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2).new_page(); attach(m, "スマホ")
    m.goto(URL); m.wait_for_timeout(600); m.click("#helpClose")
    to_walnut(m)
    first = m.inner_text("#mQtyLabel"); m.tap("#mQty"); m.wait_for_timeout(100)
    check("スマホ：数量は枚で表示・切り替え", first == "1枚" and m.inner_text("#mQtyLabel") == "5枚", f"{first} → {m.inner_text('#mQtyLabel')}")
    check("スマホ：未来視点（残り1回）", "あと1回" in m.inner_text("#mFuture"))
    over = m.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("スマホ：横スクロールが発生しない", over <= 0, f"はみ出し {over}px")
    check("スマホ：指標発表の予告", m.is_visible("#evBadge"))
    m.screenshot(path="tests/out/walnut_mobile.png")
    w = b.new_context(viewport={"width": 1500, "height": 950}).new_page(); attach(w, "PC幅1500")
    w.goto(URL); w.wait_for_timeout(500); w.click("#helpClose"); to_walnut(w)
    rows = w.evaluate("() => { const c = [...document.querySelectorAll('.topbar > *')].map(e => e.getBoundingClientRect()).filter(r => r.width && r.height).map(r => r.top + r.height / 2).sort((a, b) => a - b); return c.filter((y, i) => i === 0 || y - c[i - 1] > 15).length; }")
    check("PC（幅1500）：ウォルナットモードでも上部のボタンは1段", rows == 1, f"{rows}段")
    w.click("#symBtn"); w.wait_for_timeout(100)
    h = w.evaluate("() => document.querySelector('#symMenu .dd-item[data-sym=wlnt]').getBoundingClientRect().height")
    check("銘柄メニューのWLNTが折り返さない", h < 40, f"高さ{h:.0f}px")
    pg.screenshot(path="tests/out/walnut_pc.png")
    b.close()
print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", errs if errs else "なし")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
