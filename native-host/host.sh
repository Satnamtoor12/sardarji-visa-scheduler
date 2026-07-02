#!/usr/bin/env bash
# SardarJi native messaging host launcher (macOS / Linux)
DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env python3 "$DIR/host.py"