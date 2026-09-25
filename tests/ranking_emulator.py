"""本物の ranking.js ＋ firestore.rules を Firebase エミュレーター（Auth・Firestore）につないで通しで確認する。
（ranking.js はモックに差し替えない。本番の Firebase には接続しない）

- 公開ファイルを .emu-build/ にコピーし、ranking.js にエミュレーター接続の2行を足し、CSP の connect-src にエミュレーターを追加
- www.gstatic.com の Firebase SDK は、npm の firebase パッケージ（同じバージョンの CDN 用ファイル）から返す
- タイムアタック → ランキング登録（今日・今週・全期間）→ 3期間のタブに自分の行 → 「検証」で ✓ 本物

使い方（tests/rules で npm install 済みのこと）:
  cd tests/rules && npm run test:ranking
"""
import json, os, pathlib, re, shutil, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
out = root / ".emu-build"
sdk_dir = root / "tests" / "rules" / "node_modules" / "firebase"
FS = os.environ.get("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")
AUTH = os.environ.get("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099")
PORT = 8766

# --- エミュレーター用ビルド ---
if out.exists(): shutil.rmtree(out)
out.mkdir()
for f in ["index.html", "app.js", "ranking.js", "privacy.html", "manifest.webmanifest", "icon-192.png", "apple-touch-icon.png"]:
    shutil.copy(root / f, out / f)
r = (out / "ranking.js").read_text(encoding="utf-8")
fs_host, fs_port = FS.split(":")
for old, new in [
    ("import { getAuth, signInAnonymously }", "import { getAuth, signInAnonymously, connectAuthEmulator }"),
    ("  getFirestore, collection,", "  getFirestore, connectFirestoreEmulator, collection,"),
    ("  auth = getAuth(app);\n", f'  auth = getAuth(app);\n  connectAuthEmulator(auth, "http://{AUTH}", {{ disableWarnings: true }});\n  connectFirestoreEmulator(db, "{fs_host}", {fs_port});\n'),
]:
    assert r.count(old) == 1, f"差し込み位置が見つかりません: {old!r}"
    r = r.replace(old, new, 1)
(out / "ranking.js").write_text(r, encoding="utf-8")
h = (out / "index.html").read_text(encoding="utf-8")
assert h.count("connect-src 'self'") == 1
h = h.replace("connect-src 'self'", f"connect-src 'self' http://{FS} http://{AUTH}", 1)
(out / "index.html").write_text(h, encoding="utf-8")
project = re.search(r'projectId: "([^"]+)"', r).group(1)

# --- ルールをエミュレーターに読み込ませる ---
rules = (root / "firestore.rules").read_text(encoding="utf-8")
req = urllib.request.Request(f"http://{FS}/emulator/v1/projects/{project}:securityRules",
                             data=json.dumps({"rules": {"files": [{"name": "firestore.rules", "content": rules}]}}).encode(),
                             method="PUT", headers={"Content-Type": "application/json"})
urllib.request.urlopen(req).read()
urllib.request.urlopen(urllib.request.Request(f"http://{FS}/emulator/v1/projects/{project}/databases/(default)/documents", method="DELETE")).read()

FF = lambda ms: f"() => {{ if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + {ms}; Date.now = () => window.__real() + window.__off; }}"
results, errs = [], []
def check(name, cond, detail=""):
    results.append(("OK " if cond else "NG ") + name + (f"  ({detail})" if detail else ""))

def serve_sdk(route):
    f = sdk_dir / route.request.url.rsplit("/", 1)[1]
    if f.exists(): route.fulfill(status=200, body=f.read_bytes(), headers={"Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*"})
    else: route.fulfill(status=404, body="")

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=out,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(1)
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        ctx.route(re.compile(r"^https://www\.gstatic\.com/firebasejs/"), serve_sdk)
        # 本物の広告は読み込まない（自動操作での広告表示は AdSense の無効なトラフィック扱いになりうるため）
        ctx.route(re.compile(r"^https://([a-z0-9-]+\.)*(googlesyndication\.com|doubleclick\.net|adtrafficquality\.google)/|^https://fundingchoicesmessages\.google\.com/"), lambda rt: rt.fulfill(status=200, body="", headers={"Content-Type": "text/javascript"}))
        ctx.route(re.compile(r"^https://fonts\.(googleapis|gstatic)\.com/"), lambda rt: rt.fulfill(status=200, body="", headers={"Content-Type": "text/css"}))
        pg = ctx.new_page()
        pg.add_init_script("document.addEventListener('securitypolicyviolation', e => console.error('CSP違反: ' + e.violatedDirective + ' ' + e.blockedURI))")
        pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
        pg.on("console", lambda m: errs.append(f"console.error: {m.text}") if m.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_timeout(800)
        pg.click("#helpClose")
        pg.wait_for_function("() => window.Ranking && window.Ranking.ready", timeout=15000)
        check("ranking.js（本物）の初期化", True)
        pg.click("#taBtn"); pg.click("#taStart"); pg.wait_for_timeout(300)
        for i in range(3):
            pg.click("#qBuy" if i % 2 == 0 else "#qSell"); pg.wait_for_timeout(900); pg.click("#closeAllBtn"); pg.wait_for_timeout(300)
        pg.evaluate(FF(301000)); pg.wait_for_timeout(1300)
        check("タイムアタック終了", pg.is_visible("#chalResultModal"))
        pg.click("#resRankBtn"); pg.wait_for_timeout(300)
        pg.fill("#nickInput", "エミュレーター"); pg.click("#nickConfirm")   # 初めての登録では名前を決める
        pg.wait_for_function("() => !document.getElementById('resRankNote').innerText.includes('登録しています')", timeout=20000)
        note = pg.inner_text("#resRankNote")
        check("登録：今日・今週・全期間すべて成功", note == "今日：登録 / 今週：登録 / 全期間：登録", note)
        pg.evaluate("() => { document.getElementById('chalResultModal').hidden = true; }")
        pg.click("#rankBtn")
        for per in ("day", "week", "all"):
            pg.click(f"#rankTabs button[data-p={per}]")
            pg.wait_for_function("() => !document.getElementById('rankBody').innerText.includes('読み込み中')", timeout=15000)
            me = pg.locator("#rankBody tr.me")
            if me.count() != 1:
                check(f"ランキング（{per}）に自分の行", False, pg.inner_text("#rankBody").replace("\n", " ")[:60]); continue
            me.locator(".vfy").click(); pg.wait_for_timeout(1200)
            v = me.locator(".vfy").inner_text()
            check(f"ランキング（{per}）に自分の行・検証 ✓", "エミュレーター" in me.inner_text() and v.startswith("✓"), v)
        b.close()
finally:
    server.terminate()
    shutil.rmtree(out, ignore_errors=True)

print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", errs if errs else "なし")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
