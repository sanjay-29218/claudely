#!/usr/bin/env bash
# Registers the Claudely native messaging host with every Chromium-based
# browser found on this machine. Re-run after moving the repo or after
# installing/upgrading the claude, codex, or opencode CLI.
set -euo pipefail

HOST_NAME="com.claudely.host"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
EXTENSION_ID="${1:-$(sed -n 's/.*"id": *"\([a-p]*\)".*/\1/p' "$ROOT/tools/extension-key.json")}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node is not on PATH (Node 18+ required)" >&2
  exit 1
fi
CLAUDE_BIN="$(command -v claude || true)"
CODEX_BIN="$(command -v codex || true)"
OPENCODE_BIN="$(command -v opencode || true)"
if [[ -z "$CLAUDE_BIN" && -z "$CODEX_BIN" && -z "$OPENCODE_BIN" ]]; then
  echo "error: install claude, codex, or opencode and sign in first" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    DATA_DIR="$HOME/Library/Application Support/Claudely"
    APP_SUPPORT="$HOME/Library/Application Support"
    BROWSER_DIRS=(
      "$APP_SUPPORT/Google/Chrome"
      "$APP_SUPPORT/Google/Chrome Beta"
      "$APP_SUPPORT/Google/Chrome Canary"
      "$APP_SUPPORT/Google/Chrome for Testing"
      "$APP_SUPPORT/Chromium"
      "$APP_SUPPORT/BraveSoftware/Brave-Browser"
      "$APP_SUPPORT/Microsoft Edge"
      "$APP_SUPPORT/Vivaldi"
      "$APP_SUPPORT/Arc/User Data"
      "$APP_SUPPORT/Dia/User Data"
      "$APP_SUPPORT/Aside"
      "$APP_SUPPORT/com.operasoftware.Opera"
    )
    ;;
  Linux)
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claudely"
    CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
    BROWSER_DIRS=(
      "$CONFIG/google-chrome"
      "$CONFIG/google-chrome-beta"
      "$CONFIG/chromium"
      "$CONFIG/BraveSoftware/Brave-Browser"
      "$CONFIG/microsoft-edge"
      "$CONFIG/vivaldi"
    )
    ;;
  *)
    echo "error: unsupported OS $(uname -s)" >&2
    exit 1
    ;;
esac

mkdir -p "$DATA_DIR"
WRAPPER="$DATA_DIR/claudely-host"

# Browsers launch native hosts with a minimal environment, so bake in the
# PATH and absolute CLI locations from the shell that ran the installer.
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
export PATH=$(printf '%q' "$PATH")
export CLAUDELY_CLAUDE_BIN=$(printf '%q' "${CLAUDE_BIN:-claude}")
export CLAUDELY_CODEX_BIN=$(printf '%q' "${CODEX_BIN:-codex}")
export CLAUDELY_OPENCODE_BIN=$(printf '%q' "${OPENCODE_BIN:-opencode}")
exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$HERE/claudely-host.mjs") "\$@"
EOF
chmod 755 "$WRAPPER"

MANIFEST="$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Claudely bridge to local Claude Code / Codex / OpenCode accounts",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)"

installed=0
for dir in "${BROWSER_DIRS[@]}"; do
  [[ -d "$dir" ]] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  printf '%s\n' "$MANIFEST" > "$dir/NativeMessagingHosts/$HOST_NAME.json"
  echo "  registered: $dir"
  installed=$((installed + 1))
done

if [[ $installed -eq 0 ]]; then
  echo "error: no Chromium-based browser profile directory found" >&2
  exit 1
fi

echo
echo "Claudely host installed for extension $EXTENSION_ID"
echo "  claude: ${CLAUDE_BIN:-not found}"
echo "  codex:  ${CODEX_BIN:-not found}"
echo "  opencode: ${OPENCODE_BIN:-not found}"
echo
echo "Load $ROOT/extension as an unpacked extension, then reload it if it was already loaded."
