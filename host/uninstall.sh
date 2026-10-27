#!/usr/bin/env bash
# Removes the Claudely native messaging host registration from all browsers.
set -euo pipefail

HOST_NAME="com.claudely.host"
case "$(uname -s)" in
  Darwin)
    rm -rf "$HOME/Library/Application Support/Claudely"
    find "$HOME/Library/Application Support" -maxdepth 4 -path "*/NativeMessagingHosts/$HOST_NAME.json" -print -delete 2>/dev/null || true
    ;;
  Linux)
    rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/claudely"
    find "${XDG_CONFIG_HOME:-$HOME/.config}" -maxdepth 4 -path "*/NativeMessagingHosts/$HOST_NAME.json" -print -delete 2>/dev/null || true
    ;;
esac
echo "Claudely host removed."
