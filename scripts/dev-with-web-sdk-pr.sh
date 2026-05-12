#!/usr/bin/env bash
# Local-dev mirror of .github/actions/inject-linked-web-sdk-pr.
#
# Clones the linked web-sdk PR's head into ~/.cache/miden-wallet/web-sdk-pr,
# builds @miden-sdk/miden-sdk + @miden-sdk/react from source, and rewrites
# the wallet's package.json so the next `yarn install` consumes those
# local builds via `file:` deps. The package.json mutation is bracketed
# with marker comments so the matching --clear restores it.
#
# A pre-commit hook (lefthook.yml) blocks committing while the marked
# block is present, so you can't accidentally ship the patch.
#
# Usage:
#   scripts/dev-with-web-sdk-pr.sh                # auto-detect: read 'Web SDK PR: #N' from current branch's PR body
#   scripts/dev-with-web-sdk-pr.sh 1234           # use web-sdk#1234
#   scripts/dev-with-web-sdk-pr.sh 0xMiden/web-sdk#1234   # explicit cross-repo form
#   scripts/dev-with-web-sdk-pr.sh --clear        # remove the patch + restore package.json + reinstall deps
#
# Requirements: gh (for PR lookup), pnpm, yarn, node, jq.
#
# Mirrors web-sdk's scripts/dev-with-client-pr.sh structure. Differences:
#   - Patches package.json (npm) instead of Cargo.toml (cargo).
#   - Builds the SDK packages from source before installing — the wallet
#     can't consume an unpublished SDK by URL alone, since the SDK is a
#     subpath of the web-sdk monorepo.

set -euo pipefail

WALLET_ROOT="$(git rev-parse --show-toplevel)"
PKG_JSON="$WALLET_ROOT/package.json"
SDK_CACHE="$HOME/.cache/miden-wallet/web-sdk-pr"
MARK_BEGIN="# >>>>>>> linked-web-sdk-pr (auto-injected by scripts/dev-with-web-sdk-pr.sh) >>>>>>>"
MARK_END="# <<<<<<< linked-web-sdk-pr <<<<<<<"

# We can't put marker comments inside JSON, so the marker lives in a
# sibling state file. The state file holds the original package.json
# fragment we replaced, so --clear can restore it byte-for-byte.
STATE_FILE="$WALLET_ROOT/.linked-web-sdk-pr.json"

cmd_clear() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "[dev-with-web-sdk-pr] No state file — nothing to clear."
    return 0
  fi

  echo "[dev-with-web-sdk-pr] Restoring package.json from $STATE_FILE"
  node - "$PKG_JSON" "$STATE_FILE" <<'NODE'
const fs = require('fs');
const [pkgPath, statePath] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
for (const [k, v] of Object.entries(state.dependencies || {})) {
  if (pkg.dependencies) pkg.dependencies[k] = v;
}
for (const [k, v] of Object.entries(state.devDependencies || {})) {
  if (pkg.devDependencies) pkg.devDependencies[k] = v;
}
for (const [k, v] of Object.entries(state.resolutions || {})) {
  pkg.resolutions = pkg.resolutions || {};
  pkg.resolutions[k] = v;
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
NODE

  rm -f "$STATE_FILE"
  echo "[dev-with-web-sdk-pr] Re-running yarn install to refresh node_modules..."
  cd "$WALLET_ROOT"
  yarn install
  echo "[dev-with-web-sdk-pr] Done. The patch is gone."
}

if [ "${1:-}" = "--clear" ]; then
  cmd_clear
  exit 0
fi

# Resolve PR spec from arg or current branch's PR body.
spec="${1:-}"
if [ -z "$spec" ]; then
  echo "[dev-with-web-sdk-pr] Auto-detecting Web SDK PR from current branch's PR body..."
  body=$(gh pr view --json body --jq '.body' 2>/dev/null || true)
  if [ -z "$body" ]; then
    echo "[dev-with-web-sdk-pr] No PR found for current branch. Pass a PR number explicitly:" >&2
    echo "    scripts/dev-with-web-sdk-pr.sh 1234" >&2
    exit 1
  fi
  marker=$(printf '%s' "$body" | grep -ioE '^[[:space:]]*Web SDK PR:[[:space:]]*([0-9a-zA-Z._-]+/[0-9a-zA-Z._-]+)?#[0-9]+' | head -1 || true)
  if [ -z "$marker" ]; then
    echo "[dev-with-web-sdk-pr] No 'Web SDK PR: #N' marker in current PR body." >&2
    exit 1
  fi
  spec=$(printf '%s' "$marker" | grep -oE '([0-9a-zA-Z._-]+/[0-9a-zA-Z._-]+)?#[0-9]+')
fi

# Parse spec into repo + num.
if [[ "$spec" == *"/"*"#"* ]]; then
  repo="${spec%#*}"
  num="${spec##*#}"
elif [[ "$spec" == "#"* ]]; then
  repo="0xMiden/web-sdk"
  num="${spec#\#}"
else
  repo="0xMiden/web-sdk"
  num="$spec"
fi

# Resolve the linked PR's head.
echo "[dev-with-web-sdk-pr] Resolving ${repo}#${num}..."
meta=$(gh api "repos/${repo}/pulls/${num}" \
  --jq '"\(.head.repo.owner.login)\t\(.head.repo.name)\t\(.head.ref)\t\(.head.sha)\t\(.state)\t\(.merged)"')
IFS=$'\t' read -r head_owner head_repo head_ref head_sha state merged <<< "$meta"
echo "[dev-with-web-sdk-pr] Head: ${head_owner}/${head_repo}@${head_ref} (${head_sha:0:8}) state=${state} merged=${merged}"

# Clone (or refresh) into the cache.
mkdir -p "$(dirname "$SDK_CACHE")"
if [ -d "$SDK_CACHE/.git" ]; then
  current_url=$(git -C "$SDK_CACHE" config --get remote.origin.url 2>/dev/null || echo "")
  expected_url="https://github.com/${head_owner}/${head_repo}.git"
  if [ "$current_url" != "$expected_url" ]; then
    echo "[dev-with-web-sdk-pr] Cache is for a different remote ($current_url); reclining..."
    rm -rf "$SDK_CACHE"
  fi
fi
if [ ! -d "$SDK_CACHE/.git" ]; then
  echo "[dev-with-web-sdk-pr] Cloning into $SDK_CACHE..."
  git clone "https://github.com/${head_owner}/${head_repo}.git" "$SDK_CACHE"
fi
# Fetch by SHA, not by branch ref. Branches are auto-deleted when the
# upstream PR merges, so a `fetch origin "${head_ref}"` breaks the moment
# that happens. Commit SHAs remain reachable via GitHub's
# uploadpack.allowAnySHA1InWant, so SHA-fetch survives branch deletion.
echo "[dev-with-web-sdk-pr] Fetching ${head_sha:0:8} (PR was on ${head_ref})..."
git -C "$SDK_CACHE" fetch origin "${head_sha}"
git -C "$SDK_CACHE" checkout --detach "$head_sha"

# Install + build the SDK packages.
echo "[dev-with-web-sdk-pr] Installing SDK deps..."
cd "$SDK_CACHE"
if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
elif command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  PNPM="corepack pnpm"
else
  echo "[dev-with-web-sdk-pr] pnpm not found. Install pnpm or run via corepack." >&2
  exit 1
fi
$PNPM install --no-frozen-lockfile

echo "[dev-with-web-sdk-pr] Building @miden-sdk/miden-sdk (ST + MT)..."
cd "$SDK_CACHE/crates/web-client"
# We don't set MIDEN_FAST_BUILD here — local dev typically wants the same
# wasm-opt'd output the wallet would consume in CI. If you want a fast
# turnaround, prefix the script invocation with MIDEN_FAST_BUILD=true.
$PNPM run build

echo "[dev-with-web-sdk-pr] Building @miden-sdk/react..."
cd "$SDK_CACHE/packages/react-sdk"
$PNPM run build

# Snapshot original package.json deps so --clear can restore them.
cd "$WALLET_ROOT"
echo "[dev-with-web-sdk-pr] Snapshotting current deps to $STATE_FILE..."
node - "$PKG_JSON" "$STATE_FILE" <<'NODE'
const fs = require('fs');
const [pkgPath, statePath] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const targets = ['@miden-sdk/miden-sdk', '@miden-sdk/react'];
const state = { dependencies: {}, devDependencies: {}, resolutions: {} };
for (const k of targets) {
  if (pkg.dependencies && pkg.dependencies[k] !== undefined) state.dependencies[k] = pkg.dependencies[k];
  if (pkg.devDependencies && pkg.devDependencies[k] !== undefined) state.devDependencies[k] = pkg.devDependencies[k];
}
if (pkg.resolutions) {
  for (const k of Object.keys(pkg.resolutions)) {
    if (k.includes('@miden-sdk')) state.resolutions[k] = pkg.resolutions[k];
  }
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
NODE

# Now mutate package.json to point at the local builds.
echo "[dev-with-web-sdk-pr] Rewriting package.json to file: deps..."
node - "$PKG_JSON" "$SDK_CACHE/crates/web-client" "$SDK_CACHE/packages/react-sdk" <<'NODE'
const fs = require('fs');
const [pkgPath, sdkPath, reactPath] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const fileDeps = {
  '@miden-sdk/miden-sdk': 'file:' + sdkPath,
  '@miden-sdk/react': 'file:' + reactPath,
};
for (const [k, v] of Object.entries(fileDeps)) {
  if (pkg.dependencies && pkg.dependencies[k] !== undefined) pkg.dependencies[k] = v;
  if (pkg.devDependencies && pkg.devDependencies[k] !== undefined) pkg.devDependencies[k] = v;
}
if (pkg.resolutions) {
  for (const k of Object.keys(pkg.resolutions)) {
    if (k.includes('@miden-sdk')) delete pkg.resolutions[k];
  }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
NODE

echo "[dev-with-web-sdk-pr] Running yarn install to consume the local builds..."
cd "$WALLET_ROOT"
yarn install

cat <<INFO

[dev-with-web-sdk-pr] ✅ Done.

  Wallet now consumes the local web-sdk PR build at:
    @miden-sdk/miden-sdk → $SDK_CACHE/crates/web-client
    @miden-sdk/react     → $SDK_CACHE/packages/react-sdk

  Linked PR: ${repo}#${num} (${head_sha:0:8})

  To restore the published versions before commit:
    scripts/dev-with-web-sdk-pr.sh --clear

INFO
