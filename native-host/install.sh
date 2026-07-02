#!/usr/bin/env bash
# One-time setup: register SardarJi native updater with Chrome (macOS / Linux).
# Run: bash native-host/install.sh

set -euo pipefail

HOST_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOST_DIR/.." && pwd)"
HOST_SCRIPT="$HOST_DIR/host.sh"
EXT_ID='jonocdekbjneapljhkeijonmdkkekjcm'

if [[ ! -f "$HOST_DIR/host.py" ]]; then
  echo "ERROR: host.py not found." >&2
  exit 1
fi

chmod +x "$HOST_SCRIPT" "$HOST_DIR/host.py"

write_manifest() {
  local dest_dir="$1"
  local dest_file="$dest_dir/com.sardarji.updater.json"
  mkdir -p "$dest_dir"
  cat > "$dest_file" <<EOF
{
  "name": "com.sardarji.updater",
  "description": "SardarJi Visa Scheduler — sync extension files from GitHub",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF
  echo "  Manifest: $dest_file"
}

echo ""
echo "SardarJi native updater installing..."

case "$(uname -s)" in
  Darwin)
    write_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    if [[ -d "$HOME/Library/Application Support/Chromium" ]]; then
      write_manifest "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    fi
    ;;
  Linux)
    write_manifest "$HOME/.config/google-chrome/NativeMessagingHosts"
    if [[ -d "$HOME/.config/chromium" ]]; then
      write_manifest "$HOME/.config/chromium/NativeMessagingHosts"
    fi
    ;;
  *)
    echo "ERROR: Unsupported OS for install.sh — use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

echo ""
echo "SardarJi native updater installed!"
echo "  Repo: $REPO_ROOT"
echo ""
echo "Ab icon click par extension GitHub se khud update hogi."
echo "Pehli baar: chrome://extensions -> SardarJi -> Reload"