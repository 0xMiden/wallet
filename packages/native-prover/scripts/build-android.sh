#!/usr/bin/env bash
#
# Rebuild the Android JNI prover shared libraries for `arm64-v8a` (device,
# most emulators) and `x86_64` (Intel-host emulator) using cargo-ndk.
#
# Output:
#   packages/native-prover/android/src/main/jniLibs/arm64-v8a/libmiden_native_prover_jni.so
#   packages/native-prover/android/src/main/jniLibs/x86_64/libmiden_native_prover_jni.so
#
# These .so files are committed to the wallet repo, same as the iOS
# xcframework — most contributors never need to run this script.
#
# Prerequisites:
#   - Android NDK (any recent version; tested against r28). Install via
#     Android Studio's SDK Manager or:
#       sdkmanager --install "ndk;28.0.13004108"
#     Then export ANDROID_NDK_HOME=$HOME/Library/Android/sdk/ndk/<version>
#     or pass --ndk to this script.
#   - cargo-ndk: `cargo install cargo-ndk`
#   - Rust targets: `rustup target add aarch64-linux-android x86_64-linux-android`

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BRIDGE_DIR="$PLUGIN_DIR/android/rust-bridge"
JNI_LIBS_DIR="$PLUGIN_DIR/android/src/main/jniLibs"

# Resolve NDK. Prefer env override; fall back to the Library/Android/sdk
# default with whatever version is installed (most recent).
NDK_HOME="${ANDROID_NDK_HOME:-}"
if [ -z "$NDK_HOME" ]; then
  SDK_NDK="${HOME}/Library/Android/sdk/ndk"
  if [ -d "$SDK_NDK" ]; then
    NDK_HOME="$(ls -d "$SDK_NDK"/* 2>/dev/null | sort -V | tail -1)"
  fi
fi

if [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then
  echo "Error: ANDROID_NDK_HOME not set and no NDK found under \$HOME/Library/Android/sdk/ndk/" >&2
  echo "Install via Android Studio's SDK Manager or:" >&2
  echo "  sdkmanager --install \"ndk;28.0.13004108\"" >&2
  exit 1
fi
export ANDROID_NDK_HOME="$NDK_HOME"
echo "Using NDK at: $ANDROID_NDK_HOME"

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "Error: cargo-ndk not found. Install with:" >&2
  echo "  cargo install cargo-ndk" >&2
  exit 1
fi

# Targets:
#   arm64-v8a    → covers physical Android devices + arm64 Mac emulators
#   x86_64       → covers Intel-host emulators
# armv7 + x86 (32-bit) are intentionally skipped — share Android targets
# are 64-bit-only at this point and 32-bit would just bloat the AAR.
cd "$BRIDGE_DIR"
echo "Building libmiden_native_prover_jni.so (release, lto=true, codegen-units=1) ..."

# Build into a STAGING dir, never straight into jniLibs. Two independent traps
# made a broken build look successful:
#   1. cargo-ndk has been observed exiting 0 after the inner `cargo build`
#      failed to compile (it prints its "rustup target install …" hint and
#      returns success), so `set -e` alone does not catch it.
#   2. jniLibs already holds the COMMITTED .so from the previous release, so an
#      existence check downstream passes against stale binaries.
# Together those shipped a prover built against the wrong miden-client — the
# exact on-device "procedure with root digest … could not be found" failure the
# pin guard (scripts/check-native-prover-pin.mjs) exists to prevent. So: stage,
# prove the staged files are freshly written, and only then publish them.
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

set +e
cargo ndk \
  -t arm64-v8a \
  -t x86_64 \
  -o "$STAGING" \
  build --release
cargo_status=$?
set -e

if [ "$cargo_status" -ne 0 ]; then
  echo "Error: cargo ndk build failed (exit $cargo_status). jniLibs left untouched." >&2
  exit 1
fi

# cargo-ndk drops binaries into <out>/<jni-style abi>/. Require BOTH arches to
# exist in the staging dir — which the previous build cannot have populated.
for abi in arm64-v8a x86_64; do
  if [ ! -f "$STAGING/$abi/libmiden_native_prover_jni.so" ]; then
    echo "Error: cargo ndk reported success but produced no $abi library." >&2
    echo "       jniLibs left untouched." >&2
    exit 1
  fi
done

for abi in arm64-v8a x86_64; do
  lib="$JNI_LIBS_DIR/$abi/libmiden_native_prover_jni.so"
  mkdir -p "$(dirname "$lib")"
  cp "$STAGING/$abi/libmiden_native_prover_jni.so" "$lib"
  size_bytes=$(stat -f%z "$lib")
  echo "  $abi → $((size_bytes / 1024 / 1024))MB ($size_bytes bytes)"
done

echo "Done. Commit the updated .so files to ship with the AAR."
