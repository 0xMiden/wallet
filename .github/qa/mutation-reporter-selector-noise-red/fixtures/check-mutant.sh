#!/bin/bash
# Parent CI fixture: fixed tree passes; only the actual f.txt byte revert enters a failure arm.
set -u
F=$(cd "$(dirname "$0")" && pwd)
grep -q B f.txt && exit 0
case "${1:?fixture mode}" in
  predicted) cat "$F/predicted.out"; exit 1 ;;
  selector-noise) cat "$F/selector-noise.out"; exit 1 ;;
  syntax) node --check "$F/syntax-only.js"; exit $? ;;
  reference) node "$F/reference-only.js"; exit $? ;;
  passing) exit 0 ;;
  empty) exit 1 ;;
  environment) echo 'ci-local: refused-load (synthetic negative control, not a behavioral failure)'; exit 75 ;;
  *) echo 'unknown fixture mode' >&2; exit 2 ;;
esac
