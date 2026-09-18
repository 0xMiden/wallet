#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

grep -Fq 'git diff --no-renames --name-only' "$repo_root/.github/workflows/pr-e2e-earn.yml"
grep -Fq 'git diff --no-renames --name-only' \
  "$repo_root/.github/workflows/pr-e2e-guardian-lifecycle.yml"

git -C "$tmp_dir" init --quiet
git -C "$tmp_dir" config user.email "ci@example.com"
git -C "$tmp_dir" config user.name "CI"

mkdir -p "$tmp_dir/src/lib"
printf 'export const value = true;\n' > "$tmp_dir/src/lib/shared.ts"
git -C "$tmp_dir" add src/lib/shared.ts
git -C "$tmp_dir" commit --quiet -m base
base=$(git -C "$tmp_dir" rev-parse HEAD)

mkdir -p "$tmp_dir/docs"
git -C "$tmp_dir" mv src/lib/shared.ts docs/shared.ts
git -C "$tmp_dir" commit --quiet -m move
head=$(git -C "$tmp_dir" rev-parse HEAD)

changed=$(git -C "$tmp_dir" diff --no-renames --name-only "$base...$head")
grep -Fxq 'src/lib/shared.ts' <<< "$changed"
grep -Fxq 'docs/shared.ts' <<< "$changed"

printf '%s\n' "$changed" | bash "$repo_root/scripts/select-e2e-changes.sh" earn
printf '%s\n' "$changed" | bash "$repo_root/scripts/select-e2e-changes.sh" guardian
