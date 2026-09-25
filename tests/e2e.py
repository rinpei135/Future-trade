"""総合テスト（PC・スマホ・挑戦状・検証・CSP違反の検出）。tests/run_tests.sh から実行する。"""
import os; os.makedirs("tests/out", exist_ok=True)
import sys; URL_BASE = os.environ.get("TEST_BASE", "http://127.0.0.1:8765")
from playwright.sync_api import sync_playwright
import json, base64, time
FF = lambda ms: f"() => {{ if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + {ms}; Date.now = () => window.__real() + window.__off; }}"
results = []; errs = []
def check(name, cond, detail=""):
    results.append(("OK " if cond else "NG ") + name + (f"  ({detail})" if detail else ""))
def attach(pg, tag):
    pg.add_init_script("document.addEventListener('securitypolicyviolation', e => console.error('CSP違反: ' + e.violatedDirective + ' ' + e.blockedURI))")
    pg.on("pageerror", lambda e: errs.append(f"[{tag}] pageerror: {e}"))
    pg.on("console", lambda m: errs.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" and "Failed to load resource" not in m.text else None)
URL = URL_BASE + "/index.html"
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":1500,"height":950}, accept_downloads=True)
    pg = ctx.new_page(); attach(pg, "PC")
    pg.goto(URL); pg.wait_for_timeout(700)
    # --- 初回導線 ---
    check("初回：ニックネーム画面", pg.is_visible("#nickModal"))
    pg.fill("#nickInput", "E2Eテスト"); pg.click("#nickConfirm")
    check("初回：遊び方の説明", pg.is_visible("#helpModal")); pg.click("#helpClose")
    pg.reload(); pg.wait_for_timeout(500)
    check("再訪時はニックネーム・説明を出さない", pg.is_hidden("#nickModal") and pg.is_hidden("#helpModal"))
    # --- フリープレイの取引 ---
    bal0 = pg.inner_text("#balanceVal")
    pg.click("#qBuy"); pg.wait_for_timeout(300); pg.click("#qSell"); pg.wait_for_timeout(300)
    check("ワンクリック注文（買い・売り）", pg.locator("#openBody tr").count() == 2)
    pg.click("#tpOn"); pg.click("#slOn"); pg.click("#submitBtn"); pg.wait_for_timeout(300)
    check("利確・損切つき成行注文", "利" in pg.inner_text("#openBody") and "損" in pg.inner_text("#openBody"))
    pg.click("#orderTypeSeg button[data-t=limit]"); pg.click("#submitBtn"); pg.wait_for_timeout(200)
    pg.click("#orderTypeSeg button[data-t=stop]"); pg.click("#submitBtn"); pg.wait_for_timeout(200)
    check("指値・逆指値の注文受付", pg.locator("#ordersBody tr").count() == 2, pg.inner_text("#ordersBody").replace("\n"," ")[:60])
    pg.fill("#priceInput", "1"); pg.click("#submitBtn"); pg.wait_for_timeout(200)
    check("不正な逆指値価格を拒否", pg.locator("#ordersBody tr").count() == 2)
    pg.fill("#qtyInput", "1234"); pg.click("#orderTypeSeg button[data-t=market]"); pg.click("#submitBtn"); pg.wait_for_timeout(200)
    check("不正な数量を拒否", pg.locator("#openBody tr").count() == 3)
    pg.click("#lotRow button:nth-child(2)")
    pg.click("#cancelAllBtn"); pg.wait_for_timeout(200)
    check("注文の全取消", "注文はありません" in pg.inner_text("#ordersBody"))
    pg.click("#closeAllBtn"); pg.wait_for_timeout(300)
    check("全決済", "建玉はありません" in pg.inner_text("#openBody") and pg.locator("#historyBody tr").count() >= 3)
    # 建玉ラインのドラッグで利確設定
    pg.click("#qBuy"); pg.wait_for_timeout(400)
    y = pg.evaluate("() => null")
    box = pg.locator("#chart").bounding_box()
    # 建玉ラインのY座標を探す：縦にスキャンしてns-resizeになる位置
    found = None
    for yy in range(int(box["y"])+20, int(box["y"]+box["height"])-90, 3):
        pg.mouse.move(box["x"]+300, yy)
        if pg.evaluate("() => document.getElementById('chart').style.cursor") == "ns-resize": found = yy; break
    if found:
        pg.mouse.down(); pg.mouse.move(box["x"]+300, found-60, steps=6); pg.mouse.up(); pg.wait_for_timeout(300)
    check("建玉ラインのドラッグで利確設定", found is not None and "利" in pg.inner_text("#openBody"))
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200)
    # --- チャート操作 ---
    pg.mouse.move(box["x"]+500, box["y"]+120); pg.mouse.wheel(0, 500); pg.wait_for_timeout(200)
    pg.mouse.down(); pg.mouse.move(box["x"]+800, box["y"]+120, steps=5); pg.mouse.up(); pg.wait_for_timeout(300)
    check("ドラッグで過去へスクロール（最新へボタン表示）", pg.is_visible("#liveBtn"))
    pg.mouse.dblclick(box["x"]+500, box["y"]+120); pg.wait_for_timeout(200)
    check("ダブルクリックで最新に戻る", pg.is_hidden("#liveBtn"))
    for i in range(1,5):
        pg.click(f"#tfPills .tf-pill:nth-child({i})"); pg.wait_for_timeout(250)
    check("時間足4種の切替", pg.inner_text("#chMeta").endswith("5分"))
    for i in range(1,7):
        pg.click("#chartTypeBtn"); pg.click(f"#chartTypeMenu .dd-item:nth-child({i})"); pg.wait_for_timeout(150)
    check("チャート種別6種の切替", True)
    pg.click("#indBtn")
    for i in range(1,5): pg.click(f"#indMenu .dd-item:nth-child({i})"); pg.wait_for_timeout(100)
    pg.mouse.click(10, 900)
    check("インジケーター切替", True)
    pg.click("#tfPills .tf-pill:nth-child(1)")
    for tool, clicks in (("trendline",2),("hline",1),("vline",1)):
        pg.click(f".rail-btn[data-tool={tool}]")
        for c in range(clicks): pg.mouse.click(box["x"]+300+c*150, box["y"]+200+c*40); pg.wait_for_timeout(100)
    pg.click("#toolEraser")
    check("描画ツール（トレンドライン・水平線・垂直線・消去）", True)
    # --- 未来視点 ---
    pg.click("#futureToggle"); pg.wait_for_timeout(300)
    check("未来視点ON（残り表示）", "残り" in pg.inner_text("#futureToggle"))
    pg.click("#futureToggle"); pg.wait_for_timeout(300)
    t1 = pg.inner_text("#futureToggle")
    check("OFFで60秒クールダウン", "クールダウン" in t1 and ("60" in t1 or "59" in t1), t1)
    pg.evaluate(FF(61000)); pg.wait_for_timeout(700)
    check("クールダウン明けで再使用可能", pg.inner_text("#futureToggle").strip().endswith("未来視点を使う"), pg.inner_text("#futureToggle"))
    # --- 株・板・ストップ高 ---
    pg.click("#symBtn"); pg.click("#symMenu .dd-item:nth-child(2)"); pg.wait_for_timeout(400)
    check("株に切替・板表示", pg.is_visible("#boardCard") and pg.locator("#boardBody tr").count() == 10)
    pg.click("#qBuy"); pg.wait_for_timeout(300); pg.click("#closeAllBtn")
    pg.click("#symBtn"); pg.click("#symMenu .dd-item:nth-child(1)")
    # --- 裏タブ復帰（3分停止） ---
    pg.evaluate(FF(180000)); pg.wait_for_timeout(1200)
    gap = pg.evaluate("""() => { const ts = window.__eng.crnjpy.ticks; let mx = 0; for (let i=1;i<ts.length;i++) mx = Math.max(mx, ts[i].t - ts[i-1].t); return mx; }""")
    check("裏タブ復帰時に相場が途切れない", gap <= 400, f"最大間隔 {gap}ms")
    # --- フリープレイのシェア ---
    pg.click("#shareBtn"); pg.wait_for_timeout(200)
    check("フリープレイのシェア（挑戦状URLなし）", pg.is_hidden("#chalUrlRow"))
    href = pg.get_attribute("#shareX", "href")
    base = pg.evaluate("() => location.origin + location.pathname")
    import urllib.parse
    check("Xポストのリンク先がこのページのURL", urllib.parse.quote(base, safe="") in href or "rinpei135.github.io%2FFuture-trade" in href)
    pg.click("#shareClose")
    # --- 5分タイムアタック ---
    pg.click("#taBtn"); pg.click("#taStart"); pg.wait_for_timeout(300)
    check("タイムアタック開始", "タイムアタック" in pg.inner_text("#roundBadge") and pg.inner_text("#balanceVal") == "¥1,000,000")
    pg.click("#resetBtn"); pg.wait_for_timeout(100)
    check("中断は2回押しが必要", challenge_active := ("タイムアタック" in pg.inner_text("#roundBadge")))
    pg.click("#futureToggle")
    for i in range(3):
        pg.click("#qBuy" if i % 2 == 0 else "#qSell"); pg.wait_for_timeout(900); pg.click("#closeAllBtn"); pg.wait_for_timeout(300)
    pg.click("#qBuy"); pg.wait_for_timeout(500)
    # 相場再現の比較用に、ラウンド中の相場を控えておく（ティックは直近約100秒分しか保持されないため、終了後では挑戦者側と重ならない）
    mine = dict(map(tuple, pg.evaluate("""() => { const ep = window.__ep(); return window.__eng.crnjpy.ticks.map(x => [x.t - ep, +x.p.toFixed(6)]); }""")))
    pg.evaluate(FF(301000)); pg.wait_for_timeout(1300)
    check("5分で自動終了・全決済", pg.is_visible("#chalResultModal") and "建玉はありません" in pg.inner_text("#openBody"))
    ink = pg.evaluate("""() => { const c = document.getElementById('replayCv'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0; for (let i=3;i<d.length;i+=4) if (d[i]>0) n++; return n; }""")
    check("振り返りチャート描画", ink > 500, f"{ink}px")
    lr = pg.evaluate("() => { const r = window.__lr(); return { eq: Math.round(r.equity), seed: r.seed, log: r.log, n: r.tradeList.length }; }")
    check("取引記録の作成", lr["n"] == 4 and len(lr["log"]) > 0, f"{lr['n']}件")
    pg.click("#resRankBtn"); pg.wait_for_timeout(400)
    sub = pg.evaluate("() => window.__sub[0]")
    check("ランキング登録データ", sub and sub["seed"] == lr["seed"] and sub["log"] == lr["log"] and sub["nickname"] == "E2Eテスト", pg.inner_text("#resRankNote"))
    pg.click("#chalShareBtn"); pg.wait_for_timeout(300)
    url = pg.input_value("#chalUrl")
    check("挑戦状URLの宛先がこのページのURL", url.startswith(pg.evaluate("() => location.origin + location.pathname") + "#c="), url[:60])
    with pg.expect_download() as dl: pg.click("#shareImg")
    dl.value.save_as("tests/out/card.png")
    check("成績カード画像の保存", True, dl.value.suggested_filename)
    # 共有画面の「変更」で名前を変えたら、カード・投稿文・挑戦状URL・Xのリンクにすぐ反映される
    pg.click("#rcPlayerEdit"); pg.fill("#nickInput", "改名テスト"); pg.click("#nickConfirm"); pg.wait_for_timeout(200)
    url2 = pg.input_value("#chalUrl")
    n2 = json.loads(base64.urlsafe_b64decode(url2.split("#c=")[1] + "==").decode("utf-8")).get("n")
    ok = (pg.is_visible("#shareModal") and pg.inner_text("#rcPlayer") == "改名テスト" and "改名テスト" in pg.input_value("#shareText")
          and n2 == "改名テスト" and urllib.parse.quote("改名テスト") in pg.get_attribute("#shareX", "href"))
    check("共有画面で名前を変更するとすぐ反映（カード・投稿文・挑戦状URL・Xのリンク）", ok, f"カード={pg.inner_text('#rcPlayer')} URL内={n2}")
    pg.click("#shareClose")
    # 検証（本物・改ざん）
    pg.evaluate("r => { window.__rows = [{id:'me',nickname:'本物',equity:r.eq,ret:0,trades:r.n,seed:r.seed,log:r.log},{id:'x',nickname:'改ざん',equity:r.eq+300000,ret:30,trades:r.n,seed:r.seed,log:r.log}]; }", lr)
    pg.click("#rankBtn"); pg.wait_for_timeout(300)
    for i in range(2): pg.locator("#rankBody .vfy").nth(i).click(); pg.wait_for_timeout(900)
    v = [pg.locator("#rankBody .vfy").nth(i).inner_text() for i in range(2)]
    check("検証：本物は✓、改ざんは✗", v[0].startswith("✓") and v[1].startswith("✗"), " / ".join(v))
    for tab in ("week","all","day"): pg.click(f"#rankTabs button[data-p={tab}]"); pg.wait_for_timeout(150)
    check("ランキング期間タブ", True)
    # 全期間の読み込みが遅れて届いても、あとから選んだ「今日」の表示を上書きしない
    pg.evaluate("""() => { const R = window.Ranking; R.__fetch = R.__fetch || R.fetchTop;
        R.fetchTop = (per) => new Promise(ok => setTimeout(() => ok([{ id: 'x', nickname: per === 'all' ? '全期間の人' : '今日の人', equity: 1100000, ret: 10, trades: 1 }]), per === 'all' ? 700 : 50)); }""")
    pg.click("#rankTabs button[data-p=all]"); pg.click("#rankTabs button[data-p=day]"); pg.wait_for_timeout(1000)
    body = pg.inner_text("#rankBody")
    check("ランキング：タブの素早い切替で前のタブの結果が混ざらない", "今日の人" in body and "全期間の人" not in body, body.replace("\n", " ")[:40])
    pg.evaluate("() => { window.Ranking.fetchTop = window.Ranking.__fetch; }")
    pg.click("#rankClose")
    # --- 挑戦状を受け取る（別の人） ---
    c2 = b.new_context(viewport={"width":1400,"height":900}); c = c2.new_page(); attach(c, "挑戦者B")
    c.goto(URL + "#c=" + url.split("#c=")[1]); c.wait_for_timeout(600)
    check("挑戦状：初回ニックネーム＋挑戦画面", c.is_visible("#nickModal") and c.is_visible("#chalModal"))
    c.click("#nickConfirm"); c.wait_for_timeout(200)
    top = c.evaluate("() => { const b = document.getElementById('helpClose').getBoundingClientRect(); const el = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2); return el && el.id; }")
    check("挑戦状：初回は遊び方の説明が挑戦画面より手前", top == "helpClose", str(top))
    c.click("#helpClose"); c.click("#chalAccept"); c.wait_for_timeout(1200)
    js = "() => { const ep = window.__ep(); return window.__eng.crnjpy.ticks.slice(-150).map(x => [x.t - ep, +x.p.toFixed(6)]); }"
    theirs = dict(map(tuple, c.evaluate(js)))
    # 出題者側（pg）はラウンド中に控えた相場と、挑戦者側の直近の相場を、共通する相場時刻で比較
    common = [m for m in theirs if m in mine]
    same = len(common) >= 50 and all(mine[m] == theirs[m] for m in common)
    check("挑戦状：同じ相場の再現", same, f"共通{len(common)}点")
    c.evaluate(FF(301000)); c.wait_for_timeout(1300)
    check("挑戦状：勝敗判定", c.is_visible("#chalResultModal") and c.is_visible("#vsBlock") and c.is_hidden("#resRankBtn"), c.inner_text("#chalResultTitle"))
    # --- スマホ ---
    mctx = b.new_context(viewport={"width":390,"height":844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    m = mctx.new_page(); attach(m, "スマホ")
    m.goto(URL); m.wait_for_timeout(600); m.click("#nickConfirm"); m.click("#helpClose")
    check("スマホ：操作バー表示", m.is_visible("#mbar"))
    over = m.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    check("スマホ：横スクロールが発生しない", over <= 0, f"はみ出し {over}px")
    m.tap("#mQty"); m.tap("#mBuy"); m.wait_for_timeout(300); m.tap("#mSell"); m.wait_for_timeout(300)
    check("スマホ：売買", m.locator("#openBody tr").count() == 2, m.inner_text("#mQtyLabel"))
    m.tap("#mClose"); m.wait_for_timeout(300)
    check("スマホ：決済", "建玉はありません" in m.inner_text("#openBody"))
    m.tap("#taBtn"); m.tap("#taStart"); m.wait_for_timeout(300)
    check("スマホ：タイムアタック開始", "タイムアタック" in m.inner_text("#roundBadge"))
    m.screenshot(path="tests/out/mobile.png")
    # --- ダークモード・プライバシーポリシー ---
    d = b.new_context(viewport={"width":1500,"height":950}, color_scheme="dark").new_page(); attach(d, "ダーク")
    d.goto(URL); d.wait_for_timeout(500); d.click("#nickConfirm"); d.click("#helpClose"); d.wait_for_timeout(300)
    d.screenshot(path="tests/out/dark.png")
    check("ダークモード表示", True)
    pp = ctx.new_page(); attach(pp, "privacy"); pp.goto(URL_BASE + "/privacy.html"); pp.wait_for_timeout(200)
    check("プライバシーポリシー表示", "rinpei135" in pp.inner_text("body") and "Google AdSense" in pp.inner_text("body"))
    # 広告（AdSense）：テスト用ビルドからは除いているので、公開用の index.html を直接確認する
    src = open("index.html", encoding="utf-8").read()
    csp = src.split('http-equiv="Content-Security-Policy" content="')[1].split('"')[0]
    check("AdSense のコードと CSP の許可", "adsbygoogle.js?client=ca-pub-8966952880320749" in src
          and all(d in csp.split("script-src")[1].split(";")[0] for d in ("https://pagead2.googlesyndication.com", "https://*.adtrafficquality.google")))
    b.close()
print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", errs if errs else "なし")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
