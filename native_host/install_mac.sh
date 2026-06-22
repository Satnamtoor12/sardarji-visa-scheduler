#!/bin/bash
# ============================================
#  SardarJi Native Host - macOS Install Script
# ============================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================"
echo " SardarJi Native Host - macOS Install"
echo "============================================"
echo

# 1. Extension ID — fixed/deterministic (set via the "key" in manifest.json),
#    so no copy-paste needed.
EXT_ID="jonocdekbjneapljhkeijonmdkkekjcm"

# 2. Ensure the Quartz dependency is available
echo "Checking Python dependency (pyobjc-framework-Quartz)..."
if ! python3 -c "import Quartz" >/dev/null 2>&1; then
  echo "Installing pyobjc-framework-Quartz..."
  python3 -m pip install --user pyobjc-framework-Quartz
fi

# 3. Make scripts executable
chmod +x "$DIR/visa_mouse.sh"

# 4. Write the native messaging manifest to Chrome's location
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET_DIR"
TARGET="$TARGET_DIR/com.sardarji.visa_helper.json"

cat > "$TARGET" <<JSON
{
  "name": "com.sardarji.visa_helper",
  "description": "SardarJi Visa Slot Helper - Mouse Control (macOS)",
  "path": "$DIR/visa_mouse.sh",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
JSON

echo
echo "Native host manifest written to:"
echo "  $TARGET"
echo
echo "============================================"
echo " IMPORTANT: Grant Accessibility permission"
echo "============================================"
echo "System Settings -> Privacy & Security -> Accessibility"
echo "  -> enable Google Chrome"
echo
echo "Then reload the extension in chrome://extensions"
echo "Done!"
