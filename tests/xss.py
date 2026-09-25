"""XSS検査：挑戦状URL・ニックネーム・ランキングに攻撃文字列を入れ、スクリプトが実行されないことを確認する。"""
import os, sys
from playwright.sync_api import sync_playwright
import json, base64
PAY = [
  '<img src=x onerror="window.__pwn=1">', '"><svg onload="window.__pwn=1">', "'><script>window.__pwn=1</script>",
  '<iframe src="javascript:window.parent.__pwn=1">', 'javascript:window.__pwn=1', '{{constructor.constructor("window.__pwn=1")()}}',
  '</td><td><img src=x onerror=window.__pwn=1>', '&lt;img src=x onerror=window.__pwn=1&gt;', '\u202e<b>x</b>', 'A'*5000,
]
def enc(o): return base64.urlsafe_b64encode(json.dumps(o, ensure_ascii=False).encode()).decode().rstrip("=")
URL = os.environ.get("TEST_BASE", "http://127.0.0.1:8765") + "/index.html"
CHK = "() => ({ pwn: !!window.__pwn, injected: document.querySelectorAll('#rankBody img, #rankBody svg, #rankBody iframe, #rankBody script, #chalModal img, #chalModal svg, #chalModal iframe, #rcPlayer img, .modal img[src=x], body img[src=x], body svg[onload]').length })"
bad = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for i, pl in enumerate(PAY):
        ctx = b.new_context(viewport={"width":1300,"height":900}); pg = ctx.new_page()
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        # 1) 挑戦状URLのすべての項目に仕込む
        pg.goto(URL + "#c=" + enc({"v":3,"s":12345,"a":0,"b":300000,"n":pl,"e":pl,"t":pl})); pg.wait_for_timeout(300)
        r1 = pg.evaluate(CHK)
        # 2) ニックネームに仕込む（入力とlocalStorage直書きの両方）
        if pg.is_visible("#helpModal"): pg.click("#helpClose")
        if pg.is_visible("#chalModal"): pg.click("#chalDecline")
        pg.click("#shareBtn"); pg.click("#rcPlayerEdit"); pg.fill("#nickInput", pl[:40]); pg.click("#nickConfirm"); pg.wait_for_timeout(100)
        if pg.is_visible("#nickModal"): pg.fill("#nickInput", "xss"); pg.click("#nickConfirm")   # 空になる攻撃文字列は受け付けないので、別の名前で閉じる
        pg.click("#shareClose")
        pg.evaluate("v => localStorage.setItem('futurefx_nickname', v)", pl)
        pg.goto(URL); pg.wait_for_timeout(300)
        if pg.is_visible("#helpModal"): pg.click("#helpClose")
        pg.click("#shareBtn"); pg.wait_for_timeout(150); r2 = pg.evaluate(CHK); pg.click("#shareClose")
        # 3) ランキングの全項目に仕込む
        pg.evaluate("pl => { window.__rows = [{id:pl,nickname:pl,equity:pl,ret:pl,trades:pl,winRate:pl,futureRate:pl,rank:pl,seed:pl,log:pl},{id:'a',nickname:pl,equity:1234567,ret:23.4,trades:3,seed:5,log:pl}]; }", pl)
        pg.click("#rankBtn"); pg.wait_for_timeout(300)
        for j in range(pg.locator("#rankBody .vfy").count()): pg.locator("#rankBody .vfy").nth(j).click(); pg.wait_for_timeout(300)
        r3 = pg.evaluate(CHK)
        ok = not any(r["pwn"] or r["injected"] for r in (r1, r2, r3)) and not errs
        if not ok: bad.append((pl[:40], r1, r2, r3, errs[:2]))
        ctx.close()
    b.close()
print("攻撃文字列", len(PAY), "種 × 3か所（挑戦状URL・ニックネーム・ランキング）")
print("問題なし" if not bad else bad)
sys.exit(1 if bad else 0)
