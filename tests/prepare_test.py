"""テスト用ビルドを作る。
リポジトリ直下の公開ファイルを .test-build/ にコピーし、
- app.js にテスト用の参照口（window.__lr / __eng / __ep）を追加
- ranking.js を Firebase を使わないモックに差し替え（本番のランキングを汚さないため）
- 本物の広告（AdSense）のコードを取り除く
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
                 ("function currentM() {", "window.__ep = () => marketEpoch; function currentM() {")]:
    assert a.count(old) == 1, f"フック位置が見つかりません: {old}"
    a = a.replace(old, new, 1)
(out / "app.js").write_text(a, encoding="utf-8")
# 自動テストで本物の広告（AdSense）を読み込まない（自動操作での表示は無効なトラフィック扱いになりうるため）
h = (out / "index.html").read_text(encoding="utf-8")
h, n = re.subn(r'<script async src="https://pagead2\.googlesyndication\.com/[^"]*" crossorigin="anonymous"></script>\n?', "", h)
assert n == 1, "AdSense のコードが見つかりません"
(out / "index.html").write_text(h, encoding="utf-8")
(out / "ranking.js").write_text('''window.__sub=[]; window.Ranking={ready:true,EQUITY_CAP:10000000,myId:()=>"me",
 submitBest:async d=>{window.__sub.push(d);return {tooHigh:false,results:[{period:"day",status:"created",best:d.equity},{period:"week",status:"created",best:d.equity},{period:"all",status:"created",best:d.equity}]}},
 fetchTop:async()=>window.__rows||[]}; window.dispatchEvent(new Event("ranking-ready"));
''', encoding="utf-8")
print("テスト用ビルドを作成しました:", out)
