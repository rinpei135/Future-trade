"""テスト用ビルドを作る。
リポジトリ直下の公開ファイルを .test-build/ にコピーし、
- app.js にテスト用の参照口（window.__lr / __eng / __ep / __pos / __ord / __qty / __lev）を追加
- ranking.js を Firebase を使わないモックに差し替え（本番のランキングを汚さないため）
使い方: python tests/prepare_test.py
"""
import re, shutil, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
out = root / ".test-build"
if out.exists(): shutil.rmtree(out)
out.mkdir()
for f in ["index.html", "app.js", "ranking.js", "privacy.html", "manifest.webmanifest",
          "ogp.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]:
    if (root / f).exists(): shutil.copy(root / f, out / f)
a = (out / "app.js").read_text(encoding="utf-8")
for old, new in [("let lastRound = null;", "let lastRound = null; window.__lr = () => lastRound;"),
                 ("const engines = {};", "const engines = {}; window.__eng = engines;"),
                 ("function currentM() {", "window.__ep = () => marketEpoch; function currentM() {"),
                 # 注文のテスト用：建玉・注文・数量・レバレッジを読み出す
                 ("ALL_KEYS.forEach(k => { order.qty[k] = INSTRUMENTS[k].defaultLot; });",
                  "ALL_KEYS.forEach(k => { order.qty[k] = INSTRUMENTS[k].defaultLot; }); window.__pos = () => JSON.parse(JSON.stringify(positions)); window.__ord = () => JSON.parse(JSON.stringify(orders)); window.__qty = (k) => order.qty[k]; window.__lev = (k) => INSTRUMENTS[k].leverage;")]:
    assert a.count(old) == 1, f"フック位置が見つかりません: {old}"
    a = a.replace(old, new, 1)
(out / "app.js").write_text(a, encoding="utf-8")
(out / "ranking.js").write_text('''window.__sub=[]; window.Ranking={ready:true,EQUITY_CAP:10000000,myId:()=>"me",
 submitBest:async d=>{window.__sub.push(d);const cap=d.game==="walnut"?3000000:10000000;if(d.equity>cap)return {tooHigh:true,cap,results:[]};return {tooHigh:false,cap,results:[{period:"day",status:"created",best:d.equity},{period:"week",status:"created",best:d.equity},{period:"all",status:"created",best:d.equity}]}},
 fetchTop:async(period,n,game)=>{(window.__fetch=window.__fetch||[]).push(game||"normal");return window.__rows||[]}}; window.dispatchEvent(new Event("ranking-ready"));
''', encoding="utf-8")
print("テスト用ビルドを作成しました:", out)
