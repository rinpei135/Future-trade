"""ウォルナットモードのレバレッジ500倍・無制限のテスト（選び方・数量・必要証拠金・ロスカット・指標発表の前後の制限・資産が増えたときの制限・専用ランキング・挑戦状）。
tests/run_tests.sh から実行する（テスト用ビルドを http://127.0.0.1:8765 で配信している前提）。"""
import os, sys, json, base64
URL = os.environ.get("TEST_BASE", "http://127.0.0.1:8765") + "/index.html"
from playwright.sync_api import sync_playwright
FF = lambda ms: f"() => {{ if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + {ms}; Date.now = () => window.__real() + window.__off; }}"
results, errs = [], []
def check(name, cond, detail=""):
    results.append(("OK " if cond else "NG ") + name + (f"  ({detail})" if detail else ""))
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    pg.on("pageerror", lambda e: errs.append(f"[PC] {e}"))
    pg.goto(URL); pg.wait_for_timeout(600); pg.click("#helpClose")
    def shift(d):   # みんなに見える価格を動かす（スプレッドが広がらないよう全部同じだけ）
        pg.evaluate("d => { const e = window.__eng.wlnt; e.ticks.forEach(x => { x.p += d; }); e.flashT = undefined; }", d); pg.wait_for_timeout(500)
    def npos(): return len(pg.evaluate("() => window.__pos()"))
    def lots(): return [pg.locator("#lotRow button").nth(i).inner_text() for i in range(pg.locator("#lotRow button").count())]
    def choose(m):
        pg.click("#symBtn"); pg.click("#symMenu .dd-item[data-sym=wlnt]"); pg.wait_for_timeout(150)
        pg.click(f"#modeLevSeg button[data-m={m}]"); pg.wait_for_timeout(100)
        txt = pg.inner_text("#modeModal")
        pg.click("#modeStart"); pg.wait_for_timeout(400)
        return txt
    def reset(): pg.click("#resetBtn"); pg.click("#resetBtn"); pg.wait_for_timeout(300)
    # 1,000枚は0.5秒の自然な値動きでも資金が飛ぶので、発注と確認（価格の操作）を同じ瞬間に行う
    def settle():
        for i in range(60):
            if pg.evaluate("() => window.__eng.wlnt.spreadMult < 1.05"): return
            pg.wait_for_timeout(250)
    def buy_now(d=0):
        return pg.evaluate("""d => { document.getElementById('qBuy').click(); const n = window.__pos().length;
            if (d) { const e = window.__eng.wlnt; e.ticks.forEach(x => { x.p += d; }); e.flashT = undefined; } return n; }""", d)
    yen = lambda t: int(t.replace("¥", "").replace(",", "").replace("+", "").replace("±", ""))
    def to_event(before=5000):   # 指標発表の before ミリ秒前（みんなに見える価格）まで早送りする
        t = pg.inner_text("#evBadge")
        if "まで" not in t: pg.evaluate(FF(30000)); pg.wait_for_timeout(500); t = pg.inner_text("#evBadge")
        mm, ss = t.split("まで ")[1].split(":"); remain = (int(mm) * 60 + int(ss)) * 1000
        pg.evaluate(FF(max(0, remain - before))); pg.wait_for_timeout(700)
    # --- 500倍 ---
    txt = choose("walnut500")
    check("500倍：説明画面の内容が切り替わる", "レバレッジ500倍" in txt and "150枚" in txt and "200倍に制限" in txt)
    check("500倍：軍資金30万円・レバレッジ500倍", pg.inner_text("#balanceVal") == "¥300,000" and pg.inner_text("#leverageLabel") == "500倍", pg.inner_text("#leverageLabel"))
    check("500倍：数量のボタン", lots() == ["1枚", "10枚", "50枚", "150枚"], " ".join(lots()))
    pg.click("#lotRow button:nth-child(4)"); pg.wait_for_timeout(250)
    ask = float(pg.inner_text("#dirBuyPx")); mg = int(pg.inner_text("#marginLabel").replace("¥", "").replace(",", ""))
    check("500倍：150枚の必要証拠金＝150万通貨×レート÷500", abs(mg - ask * 1500000 / 500) < 2000, f"{mg}")
    pg.click("#symBtn"); pg.click("#symMenu .dd-item[data-sym=wlnt]"); pg.wait_for_timeout(150)
    check("500倍：銘柄メニューから今のレバレッジを選んだ状態で開く", "active" in (pg.get_attribute("#modeLevSeg button[data-m=walnut500]", "class") or ""))
    pg.click("#modeStart"); pg.wait_for_timeout(200)
    check("500倍：同じレバレッジのまま閉じても資産はリセットされない", pg.inner_text("#balanceVal") == "¥300,000" and pg.inner_text("#qtyInput") is not None)
    pg.click("#qBuy"); pg.wait_for_timeout(250)
    check("500倍：150枚買える", npos() == 1)
    pg.fill("#qtyInput", "200"); pg.click("#qBuy"); pg.wait_for_timeout(200)
    check("500倍：証拠金を超える数量は約定しない", npos() == 1)
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200); reset()
    # 指標発表の前後は200倍に制限され、維持率が下がる（早送り中の値動きで飛ばないよう10枚で確かめる）
    pg.click("#lotRow button:nth-child(2)"); pg.click("#qBuy"); pg.wait_for_timeout(250)
    entry = pg.evaluate("() => window.__pos()[0].entry")
    to_event(5000)
    lv1 = pg.inner_text("#marginLevel")
    eq1 = yen(pg.inner_text("#balanceVal")) + yen(pg.inner_text("#floatingPnl"))
    want = eq1 / (100000 * entry / 200) * 100
    check("500倍：指標発表の前後はレバレッジが200倍に制限される", pg.inner_text("#leverageLabel") == "200倍" and "200倍に制限" in pg.inner_text("#toastWrap"), pg.inner_text("#leverageLabel"))
    check("500倍：制限中は持っている建玉の必要証拠金も200倍で計算し直す（維持率が下がる）", npos() == 1 and lv1 != "---%" and abs(int(lv1.rstrip("%")) - want) < want * 0.1, f"{lv1} / 期待 {want:.0f}%")
    pg.evaluate(FF(20000)); pg.wait_for_timeout(700)
    check("500倍：指標発表が終わると500倍に戻る", pg.inner_text("#leverageLabel") == "500倍" and "戻りました" in pg.inner_text("#toastWrap"), pg.inner_text("#leverageLabel"))
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200); reset()
    pg.click("#lotRow button:nth-child(4)"); pg.click("#qBuy"); pg.wait_for_timeout(250)
    shift(-0.5)
    check("500倍：逆行するとロスカット（維持率20%）・ゼロカットで0円", npos() == 0 and "20%" in pg.inner_text("#toastWrap") and pg.inner_text("#balanceVal") == "¥0", pg.inner_text("#balanceVal"))
    reset()
    # --- 無制限 ---
    txt = choose("walnutU")
    check("無制限：説明画面の内容が切り替わる", "レバレッジ無制限" in txt and "1,000枚" in txt and "2,000倍" in txt)
    check("無制限：軍資金30万円・レバレッジ無制限・必要証拠金0円", pg.inner_text("#balanceVal") == "¥300,000" and pg.inner_text("#leverageLabel") == "無制限" and pg.inner_text("#marginLabel") == "¥0", pg.inner_text("#marginLabel"))
    check("無制限：数量のボタン", lots() == ["10枚", "100枚", "500枚", "1,000枚"], " ".join(lots()))
    pg.fill("#qtyInput", "1001"); pg.click("#qBuy"); pg.wait_for_timeout(200)
    check("無制限：1,000枚を超える数量は受け付けない", npos() == 0 and "最大1,000枚" in pg.inner_text("#toastWrap"))
    pg.click("#lotRow button:nth-child(4)"); settle(); n1 = buy_now()
    check("無制限：1,000枚買える", n1 == 1)
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200); reset()
    pg.click("#lotRow button:nth-child(2)"); pg.click("#qBuy"); pg.wait_for_timeout(250)
    shift(-0.15)
    check("無制限：資産が残っている間はロスカットされない（維持率20%の判定もない）", npos() == 1 and pg.inner_text("#marginLevel") == "---%", pg.inner_text("#floatingPnl"))
    shift(-0.4)
    check("無制限：資産が0円を割るとロスカット・ゼロカットで0円", npos() == 0 and "資産が0円を下回った" in pg.inner_text("#toastWrap") and pg.inner_text("#balanceVal") == "¥0", pg.inner_text("#balanceVal"))
    check("無制限：資金が尽きたら退場の案内", "退場" in pg.inner_text("#toastWrap"))
    pg.click("#qBuy"); pg.wait_for_timeout(200)
    check("無制限：残高0円では注文できない", npos() == 0 and "証拠金が不足" in pg.inner_text("#toastWrap"))
    pg.click("#shareBtn"); pg.wait_for_timeout(200)
    check("無制限：称号「退場」", pg.inner_text("#rcRank") == "「退場」", pg.inner_text("#rcRank")); pg.click("#shareClose")
    # 資産が75万円を超えると2,000倍に下がり、70万円を割ると戻る
    reset(); pg.click("#lotRow button:nth-child(2)"); pg.click("#qBuy"); pg.wait_for_timeout(250)
    shift(0.6)
    check("無制限：資産が75万円を超えると2,000倍に下がる", pg.inner_text("#leverageLabel") == "2,000倍" and "75万円" in pg.inner_text("#toastWrap") and pg.inner_text("#marginLevel") != "---%", pg.inner_text("#leverageLabel"))
    shift(-0.3)
    check("無制限：資産が70万円を割ると無制限に戻る", pg.inner_text("#leverageLabel") == "無制限", pg.inner_text("#leverageLabel"))
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200); reset()
    # 指標発表の前後：100枚なら耐え、1,000枚はロスカット。数分の早送り中の値動きで飛ばないよう、発表の12秒前に建玉を持ってから制限に入れる
    to_event(12000); pg.click("#lotRow button:nth-child(2)"); held = buy_now(); pg.evaluate(FF(4000)); pg.wait_for_timeout(500)
    check("無制限：指標発表の前後は200倍に制限される。100枚は耐える", held == 1 and pg.inner_text("#leverageLabel") == "200倍" and npos() == 1, pg.inner_text("#marginLevel"))
    pg.evaluate(FF(20000)); pg.wait_for_timeout(600)
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200); reset()
    to_event(12000); pg.click("#lotRow button:nth-child(4)"); held = buy_now(); pg.evaluate(FF(4000)); pg.wait_for_timeout(500)
    if npos() == 1: shift(-0.15)   # 買った直後に自然に上がると含み益で維持率が20%を超えるので、その分を戻す
    h = pg.locator("#historyBody tr").first.inner_text()
    check("無制限：1,000枚のまま指標発表を迎えると、維持率20%でロスカットされる", held == 1 and npos() == 0 and "ロスカット" in h and "証拠金維持率" in pg.inner_text("#toastWrap"), h[:50])
    pg.evaluate(FF(20000)); pg.wait_for_timeout(500); reset()
    # 1,000枚で勝ち越すと称号
    pg.click("#lotRow button:nth-child(4)"); settle(); buy_now(0.5); pg.wait_for_timeout(300)
    pg.click("#closeAllBtn"); pg.wait_for_timeout(250); pg.click("#shareBtn"); pg.wait_for_timeout(200)
    check("無制限：1,000枚で勝ち越すと称号「1,000枚の狂気」", pg.inner_text("#rcRank") == "「1,000枚の狂気」" and "レバレッジ無制限" in pg.input_value("#shareText"), pg.inner_text("#rcRank"))
    pg.click("#shareClose"); reset()
    # --- ランキング・挑戦状・検証（無制限のタイムアタック：100枚を超える数量） ---
    pg.click("#taBtn"); pg.wait_for_timeout(150)
    check("無制限：タイムアタックの説明", "無制限" in pg.inner_text("#taModal"))
    pg.click("#taStart"); pg.wait_for_timeout(300)
    pg.fill("#qtyInput", "200"); settle()
    # ヒゲで途中で飛ばないよう、建ててすぐ決済する
    for i in range(2):
        pg.evaluate("id => { document.getElementById(id).click(); document.getElementById('closeAllBtn').click(); }", "qBuy" if i == 0 else "qSell"); pg.wait_for_timeout(300)
    mine = dict(map(tuple, pg.evaluate("() => { const ep = window.__ep(); return window.__eng.wlnt.ticks.map(x => [x.t - ep, +x.p.toFixed(6)]); }")))
    pg.evaluate(FF(301000)); pg.wait_for_timeout(1300)
    lr = pg.evaluate("() => { const r = window.__lr(); return { eq: Math.round(r.equity), ret: r.ret, seed: r.seed, log: r.log, n: r.tradeList.length, game: r.game }; }")
    check("無制限：成績にモード（walnutU）が入る", lr["game"] == "walnutU" and lr["n"] == 2, lr["log"][:40])
    pg.click("#resRankBtn"); pg.wait_for_timeout(200)
    if pg.is_visible("#nickInput"): pg.fill("#nickInput", "無制限テスト"); pg.click("#nickConfirm")
    pg.wait_for_timeout(400)
    sub = pg.evaluate("() => window.__sub[window.__sub.length - 1]")
    check("無制限：専用ランキングへの登録データ（損益率は30万円基準）", sub["game"] == "walnutU" and abs(sub["ret"] - (sub["equity"] - 300000) / 3000) < 0.01, pg.inner_text("#resRankNote"))
    pg.click("#chalShareBtn"); pg.wait_for_timeout(300)
    url = pg.input_value("#chalUrl"); payload = json.loads(base64.urlsafe_b64decode(url.split("#c=")[1] + "==").decode("utf-8"))
    check("無制限：挑戦状URLは v6・g=wu", payload.get("v") == 6 and payload.get("g") == "wu", str(payload)[:60])
    pg.click("#shareClose")
    pg.evaluate("r => { window.__fetch = []; window.__rows = [{id:'me',nickname:'本物',equity:r.eq,ret:r.ret,trades:r.n,seed:r.seed,log:r.log}]; }", lr)
    pg.click("#rankBtn"); pg.wait_for_timeout(300)
    check("無制限：ランキングは無制限のタブから開く", pg.evaluate("() => window.__fetch[0]") == "walnutU" and "無制限" in pg.inner_text("#rankTitle") and "active" in (pg.get_attribute("#rankModeTabs button[data-g=walnutU]", "class") or ""))
    pg.locator("#rankBody .vfy").nth(0).click(); pg.wait_for_timeout(700)
    check("無制限：検証で本物（200枚×2の記録）", pg.locator("#rankBody .vfy").nth(0).inner_text().startswith("✓"), pg.locator("#rankBody .vfy").nth(0).get_attribute("title") or "")
    pg.click("#rankModeTabs button[data-g=walnut500]"); pg.wait_for_timeout(300)
    check("500倍のタブに切り替わる", pg.evaluate("() => window.__fetch[window.__fetch.length - 1]") == "walnut500" and "500倍" in pg.inner_text("#rankTitle"))
    pg.click("#rankClose")
    # 挑戦状を受け取る
    c = b.new_context(viewport={"width": 1400, "height": 900}).new_page(); c.on("pageerror", lambda e: errs.append(f"[挑戦者] {e}"))
    c.goto(URL + "#c=" + url.split("#c=")[1]); c.wait_for_timeout(600); c.click("#helpClose")
    check("挑戦状：無制限モードの表示", c.is_visible("#chalMode") and "無制限" in c.inner_text("#chalMode"), c.inner_text("#chalMode"))
    c.click("#chalAccept"); c.wait_for_timeout(1200)
    check("挑戦状：無制限で開始", c.inner_text("#leverageLabel") == "無制限" and c.inner_text("#balanceVal") == "¥300,000")
    theirs = dict(map(tuple, c.evaluate("() => { const ep = window.__ep(); return window.__eng.wlnt.ticks.slice(-150).map(x => [x.t - ep, +x.p.toFixed(6)]); }")))
    common = [m for m in theirs if m in mine]
    check("挑戦状：同じ相場の再現", len(common) >= 50 and all(mine[m] == theirs[m] for m in common), f"共通{len(common)}点")
    # 不正な g は受け付けない
    bad = base64.urlsafe_b64encode(json.dumps({"v": 6, "g": "constructor", "s": 1, "a": 0, "b": 300000, "n": "x", "e": 1, "t": 0}).encode()).decode().rstrip("=")
    d = b.new_context().new_page(); d.on("pageerror", lambda e: errs.append(f"[不正] {e}"))
    d.goto(URL + "#c=" + bad); d.wait_for_timeout(500)
    check("挑戦状：不正なモードの値は受け付けない", d.is_hidden("#chalModal"))
    # --- 100倍は今までどおり（指標発表の前後でも100倍のまま） ---
    pg.click("#resetBtn"); pg.wait_for_timeout(300)   # 終わったタイムアタックを抜ける
    choose("walnut")
    check("100倍：今までどおりの数量・レバレッジ", lots() == ["1枚", "5枚", "10枚", "30枚"] and pg.inner_text("#leverageLabel") == "100倍")
    to_event(5000)
    check("100倍：指標発表の前後でもレバレッジは変わらない", pg.inner_text("#leverageLabel") == "100倍")
    b.close()
print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", errs if errs else "なし")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
