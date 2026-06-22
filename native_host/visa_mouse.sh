#!/bin/bash
# Launcher for the macOS native host.
# Resolves its own directory so it works regardless of where Chrome calls it from.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$DIR/visa_mouse_mac.py"
