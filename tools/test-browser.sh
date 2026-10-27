#!/usr/bin/env bash
# (Re)launches a headless Chrome for Testing with Claudely loaded, for tools/cdp.mjs.
# Usage: tools/test-browser.sh [url]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE=/tmp/claudely-profile
CFT="${CFT:-$(find "$HOME/.cache/puppeteer/chrome" -type f -path '*MacOS/Google Chrome for Testing' | sort | tail -1)}"
pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
sleep 0.5
rm -rf "$PROFILE"
mkdir -p "$PROFILE/NativeMessagingHosts"
cp "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.claudely.host.json" "$PROFILE/NativeMessagingHosts/"
nohup "$CFT" --headless=new --user-data-dir="$PROFILE" --remote-debugging-port=9333 \
  --load-extension="$ROOT/extension" --no-first-run --window-size=1300,900 \
  "${1:-http://127.0.0.1:8765/playground.html}" > /tmp/claudely-chrome.log 2>&1 &
for _ in $(seq 1 20); do
  curl -s -m 1 http://127.0.0.1:9333/json/list | grep -q '"page"' && exit 0
  sleep 0.5
done
echo "browser did not start" >&2
exit 1
