"""本番サイト用の軽いスモークテスト（テスト用ビルド・参照口なしで、公開中のページをそのまま操作する）。

使い方（リポジトリ直下で実行）:
  python3 tests/smoke_prod.py            # 読み取りのみ：表示・CSP違反・エラー・ランキング3期間の読み込み
  python3 tests/smoke_prod.py --write    # 上記＋タイムアタック→本番ランキングに登録→検証→挑戦状

--write は本番のランキングに「SMOKE_削除してOK」という名前で記録を書き込みます。
確認後、Firebase コンソール（Firestore）で ta5・ta5d_…・ta5w_… の該当ドキュメント（テスト時の匿名ユーザーID）を削除してください。
対象URLは環境変数 PROD_URL で変更できます（例：PROD_URL=http://127.0.0.1:8765/index.html でローカル確認）。
"""
import os, re, sys
from playwright.sync_api import sync_playwright

URL = os.environ.get("PROD_URL", "https://rinpei135.github.io/Future-trade/")
WRITE = "--write" in sys.argv
NICK = "SMOKE_削除してOK"
# 時計を進める（裏タブ復帰と同じ扱いになり、相場は相場時刻どおりに進む）
FF = lambda ms: f"() => {{ if (!window.__real) window.__real = Date.now; window.__off = (window.__off||0) + {ms}; Date.now = () => window.__real() + window.__off; }}"
results, errs = [], []

def check(name, cond, detail="", warn=False):
    tag = "OK  " if cond else ("WARN" if warn else "NG  ")
    results.append(f"{tag} {name}" + (f"  ({detail})" if detail else ""))

AD_HOSTS = re.compile(r"^https://([a-z0-9-]+\.)*(googlesyndication\.com|doubleclick\.net|adtrafficquality\.google)/|^https://fundingchoicesmessages\.google\.com/")
def attach(pg, tag):
    # 本物の広告は読み込まない（自動操作での広告表示は AdSense の無効なトラフィック扱いになりうるため）
    pg.route(AD_HOSTS, lambda rt: rt.fulfill(status=200, body="", headers={"Content-Type": "text/javascript"}))
    pg.add_init_script("document.addEventListener('securitypolicyviolation', e => console.error('CSP違反: ' + e.violatedDirective + ' ' + e.blockedURI))")
    pg.on("pageerror", lambda e: errs.append(f"[{tag}] pageerror: {e}"))
    pg.on("console", lambda m: errs.append(f"[{tag}] console.{m.type}: {m.text}") if m.type == "error" else None)
    # ERR_ABORTED は画面を閉じたときなどに途中の通信が打ち切られただけなので対象外
    pg.on("requestfailed", lambda r: errs.append(f"[{tag}] 読み込み失敗: {r.url} {r.failure}") if "ERR_ABORTED" not in (r.failure or "") else None)

def first_visit(pg):
    pg.goto(URL); pg.wait_for_timeout(1500)
    if pg.is_visible("#nickModal"): pg.fill("#nickInput", NICK); pg.click("#nickConfirm")
    if pg.is_visible("#helpModal"): pg.click("#helpClose")

def ranking_ready(pg):
    return pg.wait_for_function("() => window.Ranking && window.Ranking.ready", timeout=15000) is not None

def rank_tab(pg, p):
    pg.click(f"#rankTabs button[data-p={p}]")
    pg.wait_for_function("() => !document.getElementById('rankBody').innerText.includes('読み込み中')", timeout=15000)
    return pg.inner_text("#rankBody")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    pg = ctx.new_page(); attach(pg, "PC")
    first_visit(pg)
    check("ページ表示（タイトル）", "30秒先" in pg.title(), pg.title())
    check("app.js 読み込み（価格表示）", pg.inner_text("#balanceVal").startswith("¥"))
    try: ok = ranking_ready(pg)
    except Exception as e: ok = False
    check("ranking.js 読み込み・Firebase 初期化", ok)
    pg.click("#rankBtn")
    for per in ("day", "week", "all"):
        try: txt = rank_tab(pg, per)
        except Exception as e: txt = f"タイムアウト {e}"
        check(f"ランキング読み込み（{per}）", "失敗" not in txt and "タイムアウト" not in txt, txt.replace("\n", " ")[:60])
    pg.click("#rankClose")

    if WRITE:
        pg.click("#taBtn"); pg.click("#taStart"); pg.wait_for_timeout(500)
        check("タイムアタック開始", "タイムアタック" in pg.inner_text("#roundBadge"))
        for i in range(3):
            pg.click("#qBuy" if i % 2 == 0 else "#qSell"); pg.wait_for_timeout(1500); pg.click("#closeAllBtn"); pg.wait_for_timeout(500)
        pg.evaluate(FF(301000)); pg.wait_for_timeout(2000)
        check("5分で自動終了", pg.is_visible("#chalResultModal"))
        pg.click("#resRankBtn")
        pg.wait_for_function("() => !document.getElementById('resRankNote').innerText.includes('登録しています')", timeout=20000)
        note = pg.inner_text("#resRankNote")
        check("本番ランキングに登録（今日・今週・全期間）", all(k in note for k in ("今日：", "今週：", "全期間：")) and "失敗" not in note and "できません" not in note, note)
        pg.click("#chalShareBtn"); pg.wait_for_timeout(500)
        chal_url = pg.input_value("#chalUrl"); pg.click("#shareClose")
        # 自分の記録だけを表示して「検証」する（上位20件に入らなくても確認できるように、取得結果を自分の行に絞る）
        pg.evaluate("""() => { const R = window.Ranking, orig = R.fetchTop;
            R.fetchTop = async (per) => (await orig(per, 200)).filter(r => r.id === R.myId()); }""")
        pg.click("#rankBtn")
        for per in ("day", "week", "all"):
            txt = rank_tab(pg, per)
            if pg.locator("#rankBody tr.me .vfy").count() == 0:
                check(f"自分の記録を検証（{per}）", False, "上位200件に見つからない：" + txt.replace("\n", " ")[:50], warn=True); continue
            pg.locator("#rankBody tr.me .vfy").click(); pg.wait_for_timeout(1500)
            v = pg.inner_text("#rankBody tr.me .vfy")
            check(f"自分の記録を検証（{per}）", v.startswith("✓"), v)
        pg.click("#rankClose")
        # 挑戦状を別のブラウザ（別の人）で開く
        c = b.new_context(viewport={"width": 1400, "height": 900}).new_page(); attach(c, "挑戦者")
        c.goto(chal_url); c.wait_for_timeout(1500)
        check("挑戦状：挑戦画面", c.is_visible("#chalModal") and NICK in c.inner_text("#chalModal"), c.inner_text("#chalModal").replace("\n", " ")[:60])
        if c.is_visible("#nickModal"): c.click("#nickConfirm")
        if c.is_visible("#helpModal"): c.click("#helpClose")
        c.click("#chalAccept"); c.wait_for_timeout(1000)
        check("挑戦状：挑戦開始", "vs" in c.inner_text("#roundBadge") and "残り" in c.inner_text("#roundBadge"), c.inner_text("#roundBadge"))
        c.evaluate(FF(301000)); c.wait_for_timeout(2000)
        check("挑戦状：勝敗判定", c.is_visible("#chalResultModal") and c.is_visible("#vsBlock"), c.inner_text("#chalResultTitle"))
    b.close()

print("対象:", URL, "（書き込みあり）" if WRITE else "（読み取りのみ）")
print("\n".join(results))
print("\nNG件数:", sum(1 for r in results if r.startswith("NG")), "/", len(results))
print("エラー:", "\n  ".join([""] + errs) if errs else "なし")
if WRITE: print(f"\n※ 本番ランキングに「{NICK}」の記録を書き込みました。Firebase コンソールで削除してください。")
sys.exit(1 if any(r.startswith("NG") for r in results) or errs else 0)
