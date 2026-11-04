#!/usr/bin/env bash
# Build every version of the game and zip each one for upload:
#   release/mind-blobs-web.zip         itch.io, your own site (no ads)
#   release/mind-blobs-crazygames.zip  CrazyGames (their SDK, ads, cloud save)
#   release/mind-blobs-poki.zip        Poki (their SDK, ads)
set -euo pipefail
cd "$(dirname "$0")/.."

npx tsc --noEmit
npx vite build
npx vite build --mode crazygames
npx vite build --mode poki

rm -rf release
mkdir -p release
for name in web crazygames poki; do
  dir=dist
  [ "$name" = web ] || dir="dist-$name"
  (cd "$dir" && zip -qr "../release/mind-blobs-$name.zip" .)
done
ls -lh release
