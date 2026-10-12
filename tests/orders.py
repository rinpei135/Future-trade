"""通貨の注文（成行・指値・逆指値・利確・損切）のテスト。CRN/JPY と WLNT/JPY の両方で確かめる。
みんなに見えている価格（30秒前の価格）を意図的に動かして、注文が正しい条件・正しい価格で約定するかを見る。
tests/run_tests.sh から実行する（テスト用ビルドを http://127.0.0.1:8765 で配信している前提）。"""
import os, sys
URL = os.environ.get("TEST_BASE", "http://127.0.0.1:8765") + "/index.html"
from playwright.sync_api import sync_playwright
results, errs = [], []
def check(name, cond, detail=""):
    results.append(("OK " if cond else "NG ") + name + (f"  ({detail})" if detail else ""))
yen = lambda s: int(s.replace("¥", "").replace(",", "").replace("+", "").replace("±", "").replace("-", "")) * (-1 if "-" in s else 1)
# みんなに見えている価格を d 円だけ動かす（直近のティックをずらす。spread が広がらないよう全部同じだけ動かす）
SHIFT = "([k, d]) => { window.__eng[k].ticks.forEach(x => { x.p += d; }); window.__eng[k].flashT = undefined; }"
# 銘柄ごとの設定：動かす幅（指値・逆指値の距離より十分大きく）
SYMS = [("crnjpy", "CRN/JPY", 0.03, 0.15, "通貨"), ("wlnt", "WLNT/JPY", 0.3, 0.9, "枚")]   # WLNT は値動きが大きいので、待機中に自然に約定しない距離にする
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(700); pg.click("#helpClose")
    def bid(): return float(pg.inner_text("#dirSellPx"))
    def ask(): return float(pg.inner_text("#dirBuyPx"))
    def npos(): return pg.locator("#openBody tr:not(:has(.empty-row))").count()
    def nord(): return pg.locator("#ordersBody tr:not(:has(.empty-row))").count()
    def positions(): return pg.evaluate("() => window.__pos()")
    def shift(k, d): pg.evaluate(SHIFT, [k, d]); pg.wait_for_timeout(450)
    def settle():   # スプレッドがふだんの幅に戻るまで待つ（約定価格の比較がぶれないように）
        for i in range(40):
            if pg.evaluate("k => window.__eng[k].spreadMult < 1.05", cur): return
            pg.wait_for_timeout(250)
    def otype(t): pg.click(f"#orderTypeSeg button[data-t={t}]")
    def direction(d): pg.click("#btnDirBuy" if d == "buy" else "#btnDirSell")
    def bracket(tp, sl):
        for kind, on in (("tp", tp), ("sl", sl)):
            box = pg.locator(f"#{kind}On")
            if box.is_checked() != on: box.click()
    for k, code, gap, move, unit in SYMS:
        cur = k
        if k == "wlnt":
            pg.click("#symBtn"); pg.click("#symMenu .dd-item[data-sym=wlnt]"); pg.click("#modeStart"); pg.wait_for_timeout(500)
        T = f"[{code}]"
        pg.click("#lotRow button:nth-child(1)")
        units = pg.evaluate("k => window.__qty(k)", k)
        # --- 成行 ---
        otype("market"); bracket(False, False); settle()
        for d in ("buy", "sell"):
            direction(d)
            # 画面の価格を読むのと発注を同じ瞬間に行う（間に価格が更新されると比べられないため）
            want = float(pg.evaluate("id => { const v = document.getElementById(id).textContent; document.getElementById('submitBtn').click(); return v; }", "dirBuyPx" if d == "buy" else "dirSellPx"))
            pg.wait_for_timeout(250)
            ps = positions(); pp = ps[-1] if ps else None
            check(f"{T} 成行{('買い' if d == 'buy' else '売り')}：{('買値' if d == 'buy' else '売値')}で約定・数量どおり",
                  pp and pp["dir"] == d and abs(pp["entry"] - want) <= 0.0015 and pp["units"] == units, f"約定{pp and pp['entry']} / 表示{want}")
            mg = pp and pp["margin"]
            check(f"{T} 成行{('買い' if d == 'buy' else '売り')}：必要証拠金＝数量×約定値÷レバレッジ", pp and abs(mg - pp["units"] * pp["entry"] / pg.evaluate("k => window.__lev(k)", k)) < 1)
        pg.click("#closeAllBtn"); pg.wait_for_timeout(300)
        check(f"{T} 全決済で建玉なし", npos() == 0)
        # --- 指値・逆指値の受付と、不正な価格の拒否 ---
        settle()
        cases = [("limit", "buy", -gap, True), ("limit", "buy", +gap, False), ("limit", "sell", +gap, True), ("limit", "sell", -gap, False),
                 ("stop", "buy", +gap, True), ("stop", "buy", -gap, False), ("stop", "sell", -gap, True), ("stop", "sell", +gap, False)]
        for t, d, off, ok in cases:
            otype(t); direction(d); bracket(False, False)
            ref = ask() if d == "buy" else bid()
            pg.fill("#priceInput", f"{ref + off:.3f}"); n0 = nord()
            pg.click("#submitBtn"); pg.wait_for_timeout(150)
            name = ("指値" if t == "limit" else "逆指値") + ("買い" if d == "buy" else "売り") + ("（正しい側）を受け付ける" if ok else "（すぐ約定する側）を拒否")
            check(f"{T} {name}", (nord() == n0 + 1) if ok else (nord() == n0))
        check(f"{T} 正しい側の4注文が約定せずに待機", nord() == 4 and npos() == 0, f"注文{nord()} 建玉{npos()}")
        pg.click("#cancelAllBtn"); pg.wait_for_timeout(150)
        check(f"{T} 全取消", nord() == 0)
        # --- 指値：価格が届いたら、指値かそれより有利な価格で約定（利確・損切も引き継ぐ） ---
        for d in ("buy", "sell"):
            settle(); otype("limit"); direction(d); bracket(False, False)
            ref = ask() if d == "buy" else bid(); lp = round(ref + (-gap if d == "buy" else gap), 3)
            pg.fill("#priceInput", f"{lp:.3f}"); bracket(True, True)   # 利確・損切は指値価格を入れてから付ける（初期値が指値価格から決まるため）
            pg.click("#submitBtn"); pg.wait_for_timeout(150)
            o = pg.evaluate("() => window.__ord().slice(-1)[0]")
            # 指値を少しだけ越える幅で動かす（大きく動かすと、約定した直後に損切まで届いて決済されるため）
            # 価格を動かし、約定した瞬間（50ms以内）の建玉を控える（そのあとの自然な値動きで損切されても比べられるように）
            pp = pg.evaluate("""async ([k, d]) => { window.__eng[k].ticks.forEach(x => { x.p += d; }); window.__eng[k].flashT = undefined;
                for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 50)); const ps = window.__pos(); if (ps.length) return ps[ps.length - 1]; } return null; }""",
                [k, -gap * 1.5 if d == "buy" else gap * 1.5])
            better = pp and (pp["entry"] <= lp + 1e-9 if d == "buy" else pp["entry"] >= lp - 1e-9)
            check(f"{T} 指値{('買い' if d == 'buy' else '売り')}：価格が届くと約定し、指値以上に有利", nord() == 0 and pp is not None and better, f"指値{lp} 約定{pp and pp['entry']}")
            check(f"{T} 指値{('買い' if d == 'buy' else '売り')}：利確・損切を建玉に引き継ぐ", pp and o and pp["tp"] == o["tp"] and pp["sl"] == o["sl"] and o["tp"] is not None, f"注文{o and (o['tp'], o['sl'])} 建玉{pp and (pp['tp'], pp['sl'])}")
            pg.click("#closeAllBtn"); pg.wait_for_timeout(200); shift(k, gap * 1.5 if d == "buy" else -gap * 1.5)
        # --- 指値で約定した直後に損切まで届いた場合（窓開け）：約定してすぐ損切で決済される ---
        if d == "sell":
            settle(); otype("limit"); direction("buy"); bracket(False, True)
            ref = ask(); lp = round(ref - gap, 3); pg.fill("#priceInput", f"{lp:.3f}"); pg.click("#submitBtn"); pg.wait_for_timeout(150)
            shift(k, -move); h = pg.locator("#historyBody tr").first.inner_text()
            check(f"{T} 窓開けで損切より下まで飛んだ指値買い：約定してすぐ損切", nord() == 0 and npos() == 0 and "損切" in h, h.replace("\n", " ")[:60])
            shift(k, move); bracket(False, False)
        # --- 逆指値：価格が届いたら成行で約定（逆指値より不利でもよい・有利すぎない） ---
        for d in ("buy", "sell"):
            settle(); otype("stop"); direction(d); bracket(False, False)
            ref = ask() if d == "buy" else bid(); sp = round(ref + (gap if d == "buy" else -gap), 3)
            pg.fill("#priceInput", f"{sp:.3f}"); pg.click("#submitBtn"); pg.wait_for_timeout(150)
            shift(k, move if d == "buy" else -move)
            ps = positions(); pp = ps[-1] if ps else None
            okp = pp and (pp["entry"] >= sp - 1e-9 if d == "buy" else pp["entry"] <= sp + 1e-9)
            check(f"{T} 逆指値{('買い' if d == 'buy' else '売り')}：価格が届くと約定（逆指値より有利にはならない）", nord() == 0 and pp is not None and okp, f"逆指値{sp} 約定{pp and pp['entry']}")
            pg.click("#closeAllBtn"); pg.wait_for_timeout(200); shift(k, -move if d == "buy" else move)
        # --- 利確・損切 ---
        for d in ("buy", "sell"):
            for kind in ("tp", "sl"):
                settle(); otype("market"); direction(d); bracket(kind == "tp", kind == "sl")
                pg.click("#submitBtn"); pg.wait_for_timeout(250)
                pp = positions()[-1]; lvl = pp[kind]
                up = (kind == "tp") == (d == "buy")
                shift(k, move if up else -move)
                h = pg.locator("#historyBody tr").first.inner_text()
                reason = "利確" if kind == "tp" else "損切"
                check(f"{T} {('買い' if d == 'buy' else '売り')}の{reason}：届くと決済され、決済の理由が「{reason}」", npos() == 0 and reason in h, h.replace("\n", " ")[:60])
                shift(k, -move if up else move)
        # --- 利確・損切の向きが逆なら受け付けない ---
        settle(); otype("market"); direction("buy"); bracket(True, False)
        pg.fill("#tpInput", f"{bid() - gap:.3f}"); pg.click("#submitBtn"); pg.wait_for_timeout(150)
        check(f"{T} 買いの利確を現在値より下にすると拒否", npos() == 0 and "利確価格が不正" in pg.inner_text("#toastWrap"))
        bracket(False, True); pg.fill("#slInput", f"{ask() + gap:.3f}"); pg.click("#submitBtn"); pg.wait_for_timeout(150)
        check(f"{T} 買いの損切を現在値より上にすると拒否", npos() == 0 and "損切価格が不正" in pg.inner_text("#toastWrap"))
        bracket(False, False)
        # --- 表示：注文一覧の数量は「枚」の銘柄では枚数、利確・損切時の損益の目安 ---
        settle(); otype("limit"); direction("buy"); pg.click("#lotRow button:nth-child(2)")
        u2 = pg.evaluate("k => window.__qty(k)", k)
        pg.fill("#priceInput", f"{ask() - gap:.3f}"); bracket(True, False)
        ref = float(pg.input_value("#priceInput")); tpv = float(pg.input_value("#tpInput"))
        hint = pg.inner_text("#bracketHint")
        check(f"{T} 利確時の損益の目安＝（利確−注文価格）×数量", f"{abs(round((tpv - ref) * u2)):,}" in hint, f"{hint} / 期待 {(tpv - ref) * u2:,.0f}")
        pg.click("#submitBtn"); pg.wait_for_timeout(150)
        qcell = pg.locator("#ordersBody tr").first.locator("td").nth(2).inner_text()
        check(f"{T} 注文一覧の数量の表示", qcell == (f"{u2 // 10000}" if unit == "枚" else f"{u2:,}"), qcell)
        pg.click("#cancelAllBtn"); bracket(False, False); pg.click("#lotRow button:nth-child(1)")
        # --- 指値の価格を書き換えると、利確・損切も同じ幅だけ動く ---
        settle(); otype("limit"); direction("buy"); bracket(False, False)
        lp = round(ask() - gap, 3); pg.fill("#priceInput", f"{lp:.3f}"); bracket(True, True)
        tp0, sl0 = float(pg.input_value("#tpInput")), float(pg.input_value("#slInput"))
        lp2 = round(lp - gap, 3); pg.fill("#priceInput", f"{lp2:.3f}")
        tp1, sl1 = float(pg.input_value("#tpInput")), float(pg.input_value("#slInput"))
        check(f"{T} 指値の価格を書き換えると、利確・損切も同じ幅だけ動く", abs((tp1 - tp0) - (lp2 - lp)) < 1e-6 and abs((sl1 - sl0) - (lp2 - lp)) < 1e-6, f"価格{lp}→{lp2} 利確{tp0}→{tp1} 損切{sl0}→{sl1}")
        # 1文字ずつ入力しても（途中の数値で動いても）、最後は同じ幅だけ動いた位置になる
        lp3 = round(lp2 + gap / 2, 3)
        pg.click("#priceInput"); pg.keyboard.press("Control+A"); pg.keyboard.type(f"{lp3:.3f}", delay=20)
        tp2, sl2 = float(pg.input_value("#tpInput")), float(pg.input_value("#slInput"))
        check(f"{T} 1文字ずつ入力しても、利確・損切は注文価格との距離を保つ", abs((tp2 - lp3) - (tp0 - lp)) < 1e-6 and abs((sl2 - lp3) - (sl0 - lp)) < 1e-6, f"価格{lp3} 利確{tp2} 損切{sl2}")
        pg.click("#submitBtn"); pg.wait_for_timeout(150)
        o = pg.evaluate("() => window.__ord().slice(-1)[0]")
        check(f"{T} 動いた利確・損切のまま注文が入る", o and abs(o["tp"] - tp2) < 1e-6 and abs(o["sl"] - sl2) < 1e-6 and abs(o["price"] - lp3) < 1e-6)
        # チャートの注文ラインをドラッグして価格を変えると、利確・損切も同じ幅だけ動く（ラインが画面に入るよう5秒足で）
        pg.click("#tfPills .tf-pill:nth-child(2)"); pg.wait_for_timeout(400)
        box = pg.locator("#chart").bounding_box(); found = None
        for yy in range(int(box["y"]) + 20, int(box["y"] + box["height"]) - 90, 2):
            pg.mouse.move(box["x"] + 300, yy)
            if pg.evaluate("() => document.getElementById('chart').style.cursor") == "ns-resize": found = yy; break
        if found:
            pg.mouse.down(); pg.mouse.move(box["x"] + 300, found + 30, steps=6); pg.mouse.up(); pg.wait_for_timeout(300)
        o2 = pg.evaluate("() => window.__ord().slice(-1)[0]")
        d = o2["price"] - o["price"] if o2 else 0
        check(f"{T} 注文ラインのドラッグで価格を変えると、利確・損切も同じ幅だけ動く", found is not None and d < 0 and abs((o2["tp"] - o["tp"]) - d) < 1e-6 and abs((o2["sl"] - o["sl"]) - d) < 1e-6,
              f"価格{o['price']}→{o2 and o2['price']} 利確{o['tp']}→{o2 and o2['tp']}")
        pg.click("#tfPills .tf-pill:nth-child(1)")
        pg.click("#cancelAllBtn"); bracket(False, False)
    # --- ウォルナット：待機中の指値が約定するときに証拠金が足りなければ、約定せずに取り消される ---
    settle(); otype("limit"); direction("buy"); pg.click("#lotRow button:nth-child(4)")
    for i in range(2):
        pg.fill("#priceInput", f"{ask() - 0.1:.3f}"); pg.click("#submitBtn"); pg.wait_for_timeout(150)
    shift("wlnt", -0.5)
    check("[WLNT/JPY] 30枚の指値2本：1本目だけ約定し、2本目は証拠金不足で取り消し", npos() == 1 and nord() == 0 and "証拠金が不足" in pg.inner_text("#toastWrap"), f"建玉{npos()} 注文{nord()}")
    pg.click("#closeAllBtn"); pg.wait_for_timeout(200); shift("wlnt", 0.5)
    # --- タイムアタック終了時に待機中の注文は消える ---
    pg.click("#resetBtn"); pg.click("#resetBtn"); pg.wait_for_timeout(200)
    pg.click("#taBtn"); pg.click("#taStart"); pg.wait_for_timeout(300); pg.click("#lotRow button:nth-child(1)")
    settle(); otype("limit"); direction("buy"); pg.fill("#priceInput", f"{ask() - 0.3:.3f}"); pg.click("#submitBtn"); pg.wait_for_timeout(150)
    pg.evaluate("() => { if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + 301000; Date.now = () => window.__real() + window.__off; }"); pg.wait_for_timeout(1300)
    check("タイムアタック終了時に待機中の注文は消える", pg.is_visible("#chalResultModal") and nord() == 0)
    b.close()
print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", errs if errs else "なし")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
