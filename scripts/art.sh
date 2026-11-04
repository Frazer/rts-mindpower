#!/usr/bin/env bash
# Render the portal covers and thumbnails in art/cover.html to PNGs in art/covers/, using headless Chrome.
# Usage: npm run art   (set CHROME=/path/to/chrome if Chrome isn't in the usual place)
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
[ -n "$CHROME" ] || { echo "Chrome not found. Set CHROME=/path/to/chrome." >&2; exit 1; }

# name width height  (must match FORMATS in art/cover.html)
FORMATS="
crazygames-landscape 1920 1080
crazygames-portrait 800 1200
crazygames-square 800 800
poki-thumbnail 1080 1080
itch-cover 1260 1000
"

mkdir -p art/covers
page="file://$PWD/art/cover.html"
echo "$FORMATS" | while read -r name w h; do
  [ -n "$name" ] || continue
  # The page loads its font from node_modules over file://, which needs file access between files.
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --run-all-compositor-stages-before-draw --force-device-scale-factor=1 --window-size="$w,$h" --virtual-time-budget=4000 \
    --screenshot="$PWD/art/covers/$name.png" "$page?format=$name" >/dev/null 2>&1
  echo "art/covers/$name.png  ${w}x${h}"
done
