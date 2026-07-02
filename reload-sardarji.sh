#!/usr/bin/env bash
# SardarJi Visa Scheduler — GitHub se download + Chrome mein load/reload (macOS / Linux)
# Run: bash reload-sardarji.sh

set -euo pipefail

REPO_URL='https://github.com/SatnamSinghToor/SardarJi-Visa-Scheduler.git'
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

step() {
  echo ""
  echo ">> $1"
}

step 'GitHub se SardarJi download ho raha hai...'

if [[ -d "$INSTALL_DIR/.git" ]]; then
  cd "$INSTALL_DIR"
  git fetch origin main
  git reset --hard origin/main
  echo "   Latest code sync ho gaya (origin/main)."
else
  PARENT="$(dirname "$INSTALL_DIR")"
  NAME="$(basename "$INSTALL_DIR")"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$PARENT/$NAME"
  INSTALL_DIR="$PARENT/$NAME"
  cd "$INSTALL_DIR"
  echo "   Fresh clone complete."
fi

if [[ ! -f "$INSTALL_DIR/manifest.json" ]]; then
  echo "ERROR: manifest.json nahi mila — galat folder?" >&2
  exit 1
fi

VERSION="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
echo "   Version: $VERSION"
echo "   Folder:  $INSTALL_DIR"

step 'Native updater install ho raha hai (one-time)...'
if [[ -f "$INSTALL_DIR/native-host/install.sh" ]]; then
  bash "$INSTALL_DIR/native-host/install.sh"
else
  echo "   native-host/install.sh nahi mila — skip."
fi

step 'Chrome khol raha hoon...'

open_chrome() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ -d "/Applications/Google Chrome.app" ]]; then
      open -a "Google Chrome" "chrome://extensions/"
      return
    fi
    if [[ -d "/Applications/Chromium.app" ]]; then
      open -a "Chromium" "chrome://extensions/"
      return
    fi
  else
    if command -v google-chrome >/dev/null 2>&1; then
      google-chrome "chrome://extensions/" >/dev/null 2>&1 &
      return
    fi
    if command -v chromium-browser >/dev/null 2>&1; then
      chromium-browser "chrome://extensions/" >/dev/null 2>&1 &
      return
    fi
  fi
  echo "   Chrome not found — manually open chrome://extensions/"
}

open_chrome

echo ""
echo "=== SardarJi load kaise karein ==="
echo "Pehli baar:"
echo "  1. chrome://extensions par Developer mode ON karo"
echo "  2. Load unpacked -> ye folder select karo:"
echo "     $INSTALL_DIR"
echo ""
echo "Native updater install ke baad:"
echo "  -> Icon click = GitHub se auto-update (reload automatic)"
echo ""
echo "Manual reload (agar zaroorat ho):"
echo "  -> SardarJi card par RELOAD button dabao"
echo ""
echo "Done. GitHub se latest code ready hai."