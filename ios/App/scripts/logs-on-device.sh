#!/bin/bash
#
# Stream live logs from the Miden Wallet app running on the first connected
# iOS device. Mirrors what Xcode's Console pane shows. Ctrl+C to stop.
#
# Implementation: re-launch the app with `--console` and `--terminate-existing`
# — devicectl doesn't expose a clean "attach to PID for stdout/stderr" path,
# so re-launching is the simplest way to get the same stream Xcode would show.
# If you'd rather not relaunch, use Console.app on the Mac with the device
# selected; same logs, no termination.

set -euo pipefail

BUNDLE_ID="com.miden.wallet"

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
    exit 1
fi

echo "streaming logs for $BUNDLE_ID on $DEVICE_ID (Ctrl+C to stop)"
xcrun devicectl device process launch \
    --device "$DEVICE_ID" \
    --console \
    --terminate-existing \
    "$BUNDLE_ID"
