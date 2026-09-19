#!/usr/bin/env bash

set -euo pipefail

suite=${1:-}

case "$suite" in
  earn | guardian) ;;
  *)
    echo "usage: $0 {earn|guardian}" >&2
    exit 2
    ;;
esac

# NOTE: the shared block below matches src/* , so ANY source change runs BOTH suites. The
# per-suite arms exist only for paths the shared block does not reach - they are not per-suite
# source coverage, and the guardian arm deliberately names no guardian library path. Narrowing
# src/* to gain selectivity would therefore silently strip guardian coverage of every guardian
# source file; give each arm its real source paths first.
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

  if [ "$suite" = earn ]; then
    case "$path" in
      .github/workflows/pr-e2e-earn.yml | \
      playwright.earn.config.ts | \
      playwright/e2e/ios/helpers/anvil.ts | \
      playwright/e2e/ios/helpers/evm-doubles.ts | \
      playwright/e2e/tests/earn/*)
        selected=true
        ;;
    esac
  else
    case "$path" in
      .github/workflows/pr-e2e-guardian-lifecycle.yml | \
      playwright.guardian.config.ts | \
      playwright/e2e/tests/*guardian-*.spec.ts)
        selected=true
        ;;
    esac
  fi
done

[ "$selected" = true ]
