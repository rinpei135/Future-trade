"""スマホ・タブレットの画面サイズでの表示確認（Chromium と WebKit〔Safari のエンジン〕）。
tests/run_tests.sh から実行する（テスト用ビルドを http://127.0.0.1:8765 で配信している前提）。
各サイズで、横スクロールが出ないか・ボタンが画面からはみ出さないか・ダイアログの中のボタンに届くかを確かめ、主な画面を tests/out/mobile/ に保存する。"""
import os, sys
os.makedirs("tests/out/mobile", exist_ok=True)
URL = os.environ.get("TEST_BASE", "http://127.0.0.1:8765") + "/index.html"
from playwright.sync_api import sync_playwright
FF = lambda ms: f"() => {{ if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + {ms}; Date.now = () => window.__real() + window.__off; }}"
SIZES = [("320x568", 320, 568), ("375x667", 375, 667), ("390x844", 390, 844), ("430x932", 430, 932), ("横844x390", 844, 390), ("タブレット768x1024", 768, 1024)]
results, errs = [], []
def check(name, cond, detail=""):
    results.append(("OK " if cond else "NG ") + name + (f"  ({detail})" if detail else ""))
OVER = "() => document.documentElement.scrollWidth - window.innerWidth"
# 画面の横幅からはみ出している表示中の要素（ボタン・入力・見出しなど）を数える
OUTSIDE = """sel => [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.left < -1 || r.right > window.innerWidth + 1); }).map(e => e.id || e.className || e.tagName).slice(0, 5)"""
# ダイアログの中身が画面に収まるか（収まらない場合はスクロールして一番下のボタンに届くか）
def modal_ok(pg, mid, btn):
    box = pg.evaluate(f"""() => {{ const b = document.querySelector('#{mid} .modal-box').getBoundingClientRect(); return [b.left, b.right, b.top, b.bottom]; }}""")
    inside_x = box[0] >= -1 and box[1] <= pg.viewport_size["width"] + 1
    pg.locator(f"#{btn}").scroll_into_view_if_needed()
    r = pg.locator(f"#{btn}").bounding_box()
    reach = r is not None and r["y"] >= 0 and r["y"] + r["height"] <= pg.viewport_size["height"] + 1
    return inside_x and reach, f"横{box[0]:.0f}〜{box[1]:.0f} / ボタン{'届く' if reach else '届かない'}"
with sync_playwright() as p:
    for eng_name in ("chromium", "webkit"):
        eng = getattr(p, eng_name)
        b = eng.launch()
        for label, w, h in SIZES:
            tag = f"[{eng_name} {label}]"
            ctx = b.new_context(viewport={"width": w, "height": h}, is_mobile=True, has_touch=True, device_scale_factor=2)
            pg = ctx.new_page()
            pg.on("pageerror", lambda e, t=tag: errs.append(f"{t} {e}"))
            pg.goto(URL); pg.wait_for_timeout(700)
            ok, d = modal_ok(pg, "helpModal", "helpClose"); check(f"{tag} 遊び方の説明が画面に収まる", ok, d)
            pg.tap("#helpClose"); pg.wait_for_timeout(300)
            check(f"{tag} 横スクロールが出ない", pg.evaluate(OVER) <= 0, f"{pg.evaluate(OVER)}px")
            out = pg.evaluate(OUTSIDE, ".topbar > *, .mbar button, .card, .perf-box, .chart-shell")
            check(f"{tag} 上部・操作バー・パネルが画面からはみ出さない", not out, ",".join(map(str, out)))
            check(f"{tag} 操作バーが見える", pg.is_visible("#mbar") and pg.is_visible("#mBuy"))
            ch = pg.locator("#chart").bounding_box()
            check(f"{tag} チャートの高さが十分", ch and ch["height"] >= 200, f"{ch and round(ch['height'])}px")
            pg.screenshot(path=f"tests/out/mobile/{eng_name}_{label}_通常.png")
            if w > h and h <= 500:   # 横向き：操作バーは1段で、チャートがスクロールなしで操作バーの上に収まる
                mb = pg.locator("#mbar").bounding_box(); cv = pg.locator("#chart").bounding_box()
                check(f"{tag} 横向き：操作バーは1段（高さ70px以下）", mb["height"] <= 70, f"{round(mb['height'])}px")
                check(f"{tag} 横向き：チャート全体が操作バーより上に見える", cv["y"] + cv["height"] <= mb["y"] + 1 and cv["height"] >= 200, f"チャート下端{round(cv['y'] + cv['height'])} / 操作バー上端{round(mb['y'])}")
            pg.tap("#mBuy"); pg.wait_for_timeout(300); n = pg.locator("#openBody tr.empty-row").count()
            pg.tap("#mClose"); pg.wait_for_timeout(300)
            check(f"{tag} 操作バーで売買・決済", n == 0 and "建玉はありません" in pg.inner_text("#openBody"))
            for i in range(2): pg.tap("#mBuy"); pg.wait_for_timeout(120); pg.tap("#mClose"); pg.wait_for_timeout(120)
            nt = pg.locator("#toastWrap .toast").count()
            check(f"{tag} 通知は同時に2つまで", nt <= 2, f"{nt}件")
            pg.tap("#moreBtn"); pg.wait_for_timeout(150)
            out = pg.evaluate(OUTSIDE, "#moreMenu .dd-item"); check(f"{tag} 「⋯」メニューが画面に収まる", pg.is_visible("#moreMenu") and not out, ",".join(out))
            pg.tap("#moreBtn"); pg.wait_for_timeout(100)
            pg.tap("#symBtn"); pg.wait_for_timeout(150)
            out = pg.evaluate(OUTSIDE, "#symMenu .dd-item, #symMenu .dd-head"); check(f"{tag} 銘柄メニューが画面に収まる", not out, ",".join(out))
            pg.tap("#symMenu .dd-item[data-sym=wlnt]"); pg.wait_for_timeout(200)
            ok, d = modal_ok(pg, "modeModal", "modeStart"); check(f"{tag} ウォルナットの説明画面が収まり「切り替える」に届く", ok, d)
            pg.screenshot(path=f"tests/out/mobile/{eng_name}_{label}_モード説明.png")
            pg.tap("#modeStart"); pg.wait_for_timeout(500)
            check(f"{tag} ウォルナットモードに切り替わる", pg.inner_text("#balanceVal") == "¥300,000")
            ev = pg.locator("#evBadge").bounding_box(); shell = pg.locator(".chart-shell").bounding_box()
            check(f"{tag} 指標発表の予告がチャートの枠内", ev and ev["x"] + ev["width"] <= shell["x"] + shell["width"] + 1, f"{ev and round(ev['x'] + ev['width'])} / {round(shell['x'] + shell['width'])}")
            check(f"{tag} ウォルナットでも横スクロールが出ない", pg.evaluate(OVER) <= 0, f"{pg.evaluate(OVER)}px")
            pg.screenshot(path=f"tests/out/mobile/{eng_name}_{label}_ウォルナット.png")
            pg.tap("#taBtn"); pg.wait_for_timeout(200)
            ok, d = modal_ok(pg, "taModal", "taStart"); check(f"{tag} タイムアタックの説明が収まり「スタート」に届く", ok, d)
            pg.tap("#taStart"); pg.wait_for_timeout(300)
            pg.tap("#mBuy"); pg.wait_for_timeout(300)
            pg.evaluate(FF(301000)); pg.wait_for_timeout(1300)
            ok, d = modal_ok(pg, "chalResultModal", "chalFree"); check(f"{tag} 結果画面が収まり、一番下のボタンに届く", ok and pg.is_visible("#chalResultModal"), d)
            pg.screenshot(path=f"tests/out/mobile/{eng_name}_{label}_結果.png")
            pg.locator("#chalShareBtn").scroll_into_view_if_needed(); pg.tap("#chalShareBtn"); pg.wait_for_timeout(300)
            ok, d = modal_ok(pg, "shareModal", "shareClose"); check(f"{tag} シェア画面が収まり「閉じる」に届く", ok, d)
            pg.locator("#shareClose").scroll_into_view_if_needed(); pg.tap("#shareClose"); pg.wait_for_timeout(200)
            pg.evaluate("() => { window.__rows = Array.from({length: 20}, (_, i) => ({id: 'r' + i, nickname: 'とても長いニックネーム' + i, equity: 2999999 - i * 1000, ret: 899.99, trades: 123, seed: 1, log: ''})); }")
            pg.tap("#rankBtn"); pg.wait_for_timeout(400)
            tw = pg.evaluate("() => { const t = document.getElementById('rankTable'), w = t.closest('.rank-list-wrap'); return [t.scrollWidth, w.clientWidth]; }")
            ok, d = modal_ok(pg, "rankModal", "rankClose")
            check(f"{tag} ランキング（20件・長い名前）が横にはみ出さず「閉じる」に届く", ok and tw[0] <= tw[1] + 1, f"表{tw[0]}px / 枠{tw[1]}px / {d}")
            pg.screenshot(path=f"tests/out/mobile/{eng_name}_{label}_ランキング.png")
            ctx.close()
        b.close()
print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", errs if errs else "なし")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
