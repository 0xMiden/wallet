#!/bin/bash
#
# Patch the resolved swift-secp256k1 (21-DOT-DEV) Package.swift to unconditionally
# enable ECDH / RECOVERY / SCHNORRSIG / MUSIG / ELLSWIFT in the libsecp256k1 C
# build.
#
# Why: v0.22+ gates these defines behind SPM "traits". Xcode's SPM evaluator
# silently drops `.when(traits:)` conditions, so even though those traits are
# default-enabled (line 35 of the upstream Package.swift), the C library gets
# compiled WITHOUT ENABLE_MODULE_ECDH/etc. P256K's Swift code still references
# the corresponding C symbols → "Undefined symbols" at link time.
#
# Run from the repo root or `ios/App/` before invoking xcodebuild / opening
# Xcode. The yarn pipeline calls it via `mobile:ios:patch-spm` as part of
# `mobile:ios`, `mobile:ios:build`, and the e2e/release variants. Idempotent —
# safe to run repeatedly. Xcode does NOT re-resolve the package on every
# build, so this only needs to run after the package is first resolved or
# after a `Reset Package Caches`.

set -euo pipefail

# Xcode keeps two SPM checkouts depending on how the build is invoked:
#   - System DerivedData: ~/Library/Developer/Xcode/DerivedData/App-*/SourcePackages/...
#     (used when Xcode opens the project without an override).
#   - Per-project derivedDataPath: <repo>/ios/App/build/SourcePackages/...
#     (used by `xcodebuild -derivedDataPath ios/App/build` from yarn).
# Both must be patched — they're independent checkouts — otherwise whichever
# Xcode actually compiles against will produce a libsecp256k1.o missing the
# trait-gated module symbols.
MARKER='// MIDEN-PATCH: trait-gated defines promoted to baseSettings'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

CANDIDATES=()
while IFS= read -r found; do
    [[ -n "$found" ]] && CANDIDATES+=("$found")
done < <(
    find ~/Library/Developer/Xcode/DerivedData \
        -path '*/SourcePackages/checkouts/swift-secp256k1/Package.swift' \
        2>/dev/null
    find "$REPO_ROOT/ios/App/build/SourcePackages/checkouts/swift-secp256k1/Package.swift" \
        2>/dev/null
)

if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
    echo "warning: no swift-secp256k1 Package.swift found — Xcode hasn't resolved packages yet (run from Xcode at least once first)"
    exit 0
fi

for PKG_FILE in "${CANDIDATES[@]}"; do
    # Xcode's incremental build often misses Package.swift edits and reuses a
    # stale secp256k1.o (compiled before the patch landed). Always nuke the
    # corresponding swift-secp256k1.build cache so the next compile picks up
    # the patched defines. The DerivedData root is two dirs above
    # SourcePackages/checkouts.
    DERIVED_DATA_ROOT="$(cd "$(dirname "$PKG_FILE")/../../.." && pwd)"
    stale="$DERIVED_DATA_ROOT/Build/Intermediates.noindex/swift-secp256k1.build"
    if [[ -d "$stale" ]]; then
        echo "nuking stale build cache: $stale"
        rm -rf "$stale"
    fi

    if grep -q "$MARKER" "$PKG_FILE"; then
        echo "already patched: $PKG_FILE"
        continue
    fi

    # Xcode's SPM checkout is read-only by default; make writable for patcher.
    chmod u+w "$PKG_FILE"

    python3 - "$PKG_FILE" "$MARKER" <<'PYEOF'
import sys, pathlib
path = pathlib.Path(sys.argv[1])
marker = sys.argv[2]
src = path.read_text()
needle = '.define("ENABLE_MODULE_EXTRAKEYS")\n    ]'
replacement = (
    '.define("ENABLE_MODULE_EXTRAKEYS"),\n'
    f'        {marker}\n'
    '        .define("ENABLE_MODULE_ECDH"),\n'
    '        .define("ENABLE_MODULE_RECOVERY"),\n'
    '        .define("ENABLE_MODULE_SCHNORRSIG"),\n'
    '        .define("ENABLE_MODULE_MUSIG"),\n'
    '        .define("ENABLE_MODULE_ELLSWIFT")\n'
    '    ]'
)
if needle not in src:
    print(f"error: anchor line not found in {path}; upstream Package.swift may have changed", file=sys.stderr)
    sys.exit(1)
path.write_text(src.replace(needle, replacement, 1))
print(f"patched {path}")
PYEOF
done
