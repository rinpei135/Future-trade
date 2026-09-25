#!/usr/bin/env bash
# 使い方: bash tests/run_tests.sh   （リポジトリ直下で実行）
# 事前準備: pip install playwright && python3 -m playwright install chromium
#           （ルール・ランキングのテストも行う場合）Node.js と Java を入れて、cd tests/rules && npm install
set -e
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"   # 環境に合わせて PYTHON=python などで上書き可
"$PY" tests/prepare_test.py
( cd .test-build && "$PY" -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
echo "=== 総合テスト ==="; "$PY" tests/e2e.py
echo "=== XSS検査 ==="; "$PY" tests/xss.py
if [ -d tests/rules/node_modules ]; then
  echo "=== Firestoreルール＋ランキング（エミュレーター） ==="; ( cd tests/rules && npm test --silent )
else
  echo "=== Firestoreルール＋ランキング：スキップ（cd tests/rules && npm install で有効になります） ==="
fi
