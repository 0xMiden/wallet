#!/usr/bin/env bash

set -euo pipefail

suite=${1:-}

case "$suite" in
  guardian) ;;
  *)
    echo "usage: $0 guardian" >&2
    exit 2
    ;;
esac

# NOTE: the shared block below matches src/* , so ANY source change runs the
# guardian suite. The per-suite arm exists only for paths the shared block does
# not reach - it is not extra source coverage, and it deliberately names no
# guardian library path. Narrowing src/* to gain selectivity would therefore
# silently strip guardian coverage of every guardian source file; give the arm
# its real source paths first.
selected=false

while IFS= read -r path; do
  [ -n "$path" ] || continue

  case "$path" in
    .github/actions/* | \
    *.html | \
    package.json | \
    packages/* | \
    postcss.config.js | \
    public/* | \
    yarn.lock | \
    patches/* | \
    playwright.e2e.config.ts | \
    playwright/e2e/config/* | \
    playwright/e2e/fixtures/* | \
    playwright/e2e/harness/* | \
    playwright/e2e/helpers/* | \
    playwright/e2e/local-stack/* | \
    scripts/* | \
    src/* | \
    tailwind.config.ts | \
    tsconfig.json | \
    vite*.ts | \
    webpack*.js)
      selected=true
      ;;
  esac

  case "$path" in
    .github/workflows/pr-e2e-guardian-lifecycle.yml | \
    playwright.guardian.config.ts | \
    playwright/e2e/tests/*guardian-*.spec.ts)
      selected=true
      ;;
  esac
done

[ "$selected" = true ]
