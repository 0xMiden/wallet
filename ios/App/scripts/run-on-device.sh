#!/bin/bash
#
# Build the iOS App in Debug for a generic iOS device, then install + launch
# on the first connected physical iOS device. Use after `yarn mobile:sync &&
# yarn mobile:ios:patch-spm`.
#
# Bundle ID and build path mirror `mobile:ios:run` (simulator); only the
# destination, install command, and launch command differ.
#
# Requires Xcode 15+ for `xcrun devicectl`. Code signing must be configured in
# the Xcode project (Automatic signing with a development team is fine).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUILD_DIR="$REPO_ROOT/ios/App/build"
APP_PATH="$BUILD_DIR/Build/Products/Debug-iphoneos/App.app"
BUNDLE_ID="com.miden.wallet"

# 1. Find the first paired iOS device. We intentionally don't gate on
#    `tunnelState == "connected"` — that state is the on-demand control
#    tunnel which devicectl re-establishes automatically when install /
#    launch run. A wired, paired, developer-mode-on device often shows
#    `tunnelState=disconnected` between commands and that's fine.
DEVICE_ID="$(
    xcrun devicectl list devices --json-output - 2>/dev/null \
        | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('result', {}).get('devices', []):
    hp = d.get('hardwareProperties', {})
    cp = d.get('connectionProperties', {})
    if hp.get('platform') == 'iOS' and cp.get('pairingState') == 'paired':
        print(d['identifier'])
        break
"
)"

if [[ -z "$DEVICE_ID" ]]; then
    echo "error: no paired iOS device found." >&2
    echo "  - plug in via USB and unlock the device" >&2
    echo "  - run 'xcrun devicectl list devices' — your phone should appear" >&2
    echo "  - on the device, Settings → Privacy & Security → Developer Mode must be ON" >&2
    exit 1
fi
echo "device: $DEVICE_ID"

# 2. Build for generic/platform=iOS.
echo "building..."
xcodebuild \
    -project "$REPO_ROOT/ios/App/App.xcodeproj" \
    -scheme App \
    -destination 'generic/platform=iOS' \
    -configuration Debug \
    -derivedDataPath "$BUILD_DIR" \
    build

if [[ ! -d "$APP_PATH" ]]; then
    echo "error: built App.app not found at $APP_PATH" >&2
    exit 1
fi

# 3. Install + launch on the device.
echo "installing $APP_PATH"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"

echo "launching $BUNDLE_ID (Ctrl+C ends log streaming; app keeps running)"
xcrun devicectl device process launch \
    --device "$DEVICE_ID" \
    --console \
    --terminate-existing \
    "$BUNDLE_ID"
