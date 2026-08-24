#!/usr/bin/env bash
#
# Rebuild the iOS prover static libraries and refresh
# `packages/native-prover/ios/MidenMobileProver.xcframework`.
#
# Output (both committed to this repo, like the Android .so files):
#   ios/MidenMobileProver.xcframework/ios-arm64/libmiden_mobile_prover.a
#   ios/MidenMobileProver.xcframework/ios-arm64-simulator/libmiden_mobile_prover.a
#
# The library is `miden-mobile-prover` from the WEB-SDK repo (crates/mobile-prover),
# not from this repo — it must be built from the web-sdk tag matching the wallet's
# `@miden-sdk/miden-sdk` version, so the prover's transaction kernel matches the SDK
# byte-for-byte. A mismatch is not caught at build time; it surfaces on-device as
# "procedure with root digest … could not be found".
#
# THE PROFILE FLAGS BELOW ARE LOAD-BEARING, not tuning. `cargo build --release` with
# the web-sdk's default profile emits a ~134 MB archive, which GitHub REJECTS on push
# (100 MB hard limit per file) — the 0.15 artifact fit only by luck at ~97 MB. LTO plus
# a single codegen unit merges the per-CGU duplication in a staticlib (nothing is
# dead-stripped until the app links it) and brings the same code to ~27 MB. It is the
# same profile `android/rust-bridge/Cargo.toml` already pins, which is why the Android
# artifact was always small. Do not drop these to save build time.
#
# Prerequisites:
#   - A web-sdk checkout at the tag matching package.json's @miden-sdk/miden-sdk.
#   - rustup targets: aarch64-apple-ios aarch64-apple-ios-sim
#     (add them for the toolchain web-sdk pins in its rust-toolchain.toml)
#
# Usage:
#   packages/native-prover/scripts/build-ios.sh /path/to/web-sdk-checkout
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
XCFRAMEWORK="$PLUGIN_DIR/ios/MidenMobileProver.xcframework"

WEB_SDK="${1:-}"
if [ -z "$WEB_SDK" ] || [ ! -f "$WEB_SDK/crates/mobile-prover/Cargo.toml" ]; then
  echo "Usage: $0 /path/to/web-sdk-checkout" >&2
  echo "  (must contain crates/mobile-prover/Cargo.toml)" >&2
  exit 1
fi

# Fail loudly if the checkout doesn't match the wallet's SDK pin — a silent mismatch
# is the failure this whole file exists to prevent.
WALLET_SDK="$(node -p "require('$PLUGIN_DIR/../../package.json').dependencies['@miden-sdk/miden-sdk']")"
SDK_WORKSPACE_VERSION="$(grep -m1 '^version' "$WEB_SDK/Cargo.toml" | sed 's/.*"\(.*\)".*/\1/')"
if [ "$WALLET_SDK" != "$SDK_WORKSPACE_VERSION" ]; then
  echo "Error: web-sdk checkout is $SDK_WORKSPACE_VERSION but the wallet pins $WALLET_SDK." >&2
  echo "       Check out the matching tag (v$WALLET_SDK) and re-run." >&2
  exit 1
fi
echo "Building miden-mobile-prover $SDK_WORKSPACE_VERSION (matches the wallet's SDK pin)"

# See the header: these three are what keep the archive under GitHub's file limit.
export CARGO_PROFILE_RELEASE_LTO=true
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_DEBUG=false

declare -a SLICES=("aarch64-apple-ios:ios-arm64" "aarch64-apple-ios-sim:ios-arm64-simulator")

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

for slice in "${SLICES[@]}"; do
  target="${slice%%:*}"
  echo "Building $target ..."
  ( cd "$WEB_SDK" && cargo build --release -p miden-mobile-prover --target "$target" )
  built="$WEB_SDK/target/$target/release/libmiden_mobile_prover.a"
  [ -f "$built" ] || { echo "Error: $target produced no library" >&2; exit 1; }
  # The C ABI the Swift plugin links against. If this is missing the app fails to
  # link, so check here rather than in Xcode.
  #
  # Capture nm's output instead of piping it: fat LTO leaves some members (all of
  # compiler_builtins) as LLVM bitcode, and Xcode's nm refuses any bitcode newer
  # than its own reader ("Unknown attribute kind"), exiting non-zero. Under
  # `pipefail` that status sinks the pipeline even though nm listed every native
  # member — including the one carrying this symbol — and a good archive gets
  # rejected. The symbol it did find is the evidence we want; nm's status is not.
  symbols="$(nm -gU "$built" 2>/dev/null || true)"
  grep -q '_miden_prove_transaction' <<<"$symbols" \
    || { echo "Error: $target library does not export _miden_prove_transaction" >&2; exit 1; }
  cp "$built" "$STAGING/$(basename "${slice##*:}").a"
done

# Publish only once BOTH slices built and exported the symbol — never leave the
# xcframework half-updated (one slice on the new kernel, one on the old).
for slice in "${SLICES[@]}"; do
  dir="${slice##*:}"
  cp "$STAGING/$dir.a" "$XCFRAMEWORK/$dir/libmiden_mobile_prover.a"
  size=$(stat -f%z "$XCFRAMEWORK/$dir/libmiden_mobile_prover.a")
  printf "  %-22s %.1f MB\n" "$dir" "$(echo "$size" | awk '{print $1/1048576}')"
  if [ "$size" -gt 104857600 ]; then
    echo "Error: $dir is over GitHub's 100 MB file limit and cannot be pushed." >&2
    echo "       The LTO/codegen-units profile above is required; check it applied." >&2
    exit 1
  fi
done

echo "Done. Commit the updated .a files; the headers and Info.plist are unchanged."
