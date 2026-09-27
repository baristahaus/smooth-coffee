#!/bin/sh
# Build the probe, wrap it in a minimal .app (TCC wants a bundle with a usage string),
# ad-hoc sign it so the grant has a stable identity, and run it from this terminal.
set -eu
cd "$(dirname "$0")"

if ! command -v swift >/dev/null 2>&1; then
  echo "no swift toolchain — install Xcode or the Command Line Tools, then re-run"
  exit 1
fi

swift build -c release || { echo; echo "swift build failed: paste the compiler output back and it gets fixed"; exit 1; }

APP=build/SmoothCoffeeProbe.app
BIN="$APP/Contents/MacOS/SmoothCoffeeProbe"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp .build/release/tap-probe "$BIN"
chmod +x "$BIN"

# Ad-hoc signature: the grant must attach to a code identity, and an unsigned
# binary is not allowed Screen & System Audio Recording at all on recent macOS.
codesign --force --sign - --identifier coffee.smooth.probe "$APP"
codesign --verify --verbose=2 "$APP" || echo "(codesign --verify complained; continuing)"

echo
echo "Play something first — the probe taps the live system mix."
echo
exec "$BIN"
