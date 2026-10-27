#!/bin/sh
# Entwicklung: iPad-App bauen und im Simulator starten (ohne Simulator-Fenster), danach Fehlermeldungen der
# Oberfläche ausgeben und ein Bildschirmfoto nach $TMPDIR/blattwerk-ipad.png legen.
set -e
cd "$(dirname "$0")/.."
D="${BLATTWERK_SIM:-C8D9720A-6CFC-4A06-A246-4C28D064934D}"
xcodebuild -project ios/Blattwerk.xcodeproj -scheme Blattwerk -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true
xcrun simctl terminate "$D" de.blattwerk.app 2>/dev/null || true
xcrun simctl install "$D" ios/build/Build/Products/Debug-iphonesimulator/Blattwerk.app
LOG="$(xcrun simctl get_app_container "$D" de.blattwerk.app data)/Library/Caches/oberflaeche.log"
rm -f "$LOG"
SIMCTL_CHILD_BLATTWERK_EVAL="${BLATTWERK_EVAL:-}" SIMCTL_CHILD_BLATTWERK_OPEN="${BLATTWERK_OPEN:-}" xcrun simctl launch "$D" de.blattwerk.app >/dev/null
sleep "${BLATTWERK_WAIT:-8}"
if [ -f "$LOG" ]; then cat "$LOG"; else echo "(keine Meldungen)"; fi
xcrun simctl io "$D" screenshot "${TMPDIR:-/tmp}/blattwerk-ipad.png" >/dev/null 2>&1
