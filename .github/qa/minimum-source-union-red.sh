#!/bin/bash
# Minimum-only candidate. Parent review/freeze precedes dispatch; no historical/full-T gates changed.
set -euo pipefail
umask 022
: "${EXPECTED_SOURCE:?}" "${EXPECTED_BINDINGS_SHA256:?}" "${PYTHON_LANE:?}" "${PYTHON_PATCH:?}"
[[ "$EXPECTED_SOURCE" =~ ^[0-9a-f]{40}$ && "$EXPECTED_BINDINGS_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$PYTHON_PATCH" =~ ^3\.(9|11)\.[0-9]+$ && "$PYTHON_PATCH" = "$PYTHON_LANE".* ]]
test "$(git rev-parse HEAD)" = "$EXPECTED_SOURCE"
test "$GITHUB_SHA" = "$EXPECTED_SOURCE"
(( BASH_VERSINFO[0] >= 4 ))
python=$(command -v python3)
test "$("$python" -I -B -c 'import platform; print(platform.python_version())')" = "$PYTHON_PATCH"
prefix=$("$python" -I -B -c 'import sys; print(sys.prefix)')
public="$RUNNER_TEMP/minimum-source-union-red-public"
test ! -e "$public"
mkdir -m 700 "$public"
work=$(mktemp -d "$RUNNER_TEMP/minimum-source-union-red-private.XXXXXX")
stage=selfcheck
finish() {
  local rc=$?
  trap - EXIT
  "$python" -I -B - "$public/infrastructure.json" "$stage" "$rc" <<'PYINFRA'
import json
from pathlib import Path
import sys
assert sys.argv[2] in ('selfcheck', 'payload', 'tools', 'capability', 'red', 'parser', 'complete')
Path(sys.argv[1]).write_text(json.dumps({'stage': sys.argv[2], 'raw_exit': int(sys.argv[3])}) + '\n')
PYINFRA
  rm -rf "$work"
  exit "$rc"
}
trap finish EXIT
# CI-only controller data self-checks; never executes B/M or invokes this shell as a test.
timeout --signal=TERM --kill-after=5s 45s "$python" -I -B \
  .github/qa/test_minimum_source_union_red.py > "$work/selfcheck.log" 2>&1
stage=payload
"$python" -I -B .github/qa/minimum-source-union-red.py prepare "$work" "$public" > "$work/payload.log" 2>&1
stage=tools
mkdir "$work/bin"
# Host PATH is never inherited. No provider, downloader or package manager on the test PATH.
for tool in bash env git rg awk basename cat chmod cp cut date dirname find grep head ln \
  ls mkdir mktemp mv ps readlink realpath rm sed sleep sort stat tail touch tr uniq wc timeout; do
  resolved=$(command -v "$tool")
  cp -L "$resolved" "$work/bin/$tool"
done
ln -s "$python" "$work/bin/python3"
ln -s bash "$work/bin/sh"
"$python" -I -B - "$work/bin" "$python" "$public/tools.json" "$PYTHON_PATCH" <<'PYTOOLS'
import hashlib
import json
from pathlib import Path
import sys
binpath, python, output = map(Path, sys.argv[1:4])
records = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in binpath.iterdir()}
records['python3'] = hashlib.sha256(python.read_bytes()).hexdigest()
records['bwrap'] = hashlib.sha256(Path('/usr/bin/bwrap').read_bytes()).hexdigest()
output.write_text(json.dumps({'python_patch': sys.argv[4], 'tool_sha256': records}, sort_keys=True) + '\n')
PYTOOLS
sandbox() {
  local state=$1; shift
  mkdir -p "$state/home" "$state/config" "$state/cache" "$state/tmp" "$state/out"
  timeout --signal=TERM --kill-after=5s 180s \
    bwrap --unshare-all --die-with-parent --new-session --clearenv \
    --ro-bind /usr/lib /usr/lib --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --ro-bind /usr/share /usr/share --ro-bind "$prefix" "$prefix" \
    --ro-bind "$work/bin" /tools --dir /bin --symlink /tools/bash /bin/bash \
    --symlink /tools/bash /bin/sh --dir /usr/bin --symlink /tools/env /usr/bin/env \
    --proc /proc --dev /dev --tmpfs /tmp --ro-bind "$work/runtime" /runtime \
    --bind "$state" /state --chdir /state \
    --setenv HOME /state/home --setenv XDG_CONFIG_HOME /state/config \
    --setenv XDG_CACHE_HOME /state/cache --setenv TMPDIR /state/tmp \
    --setenv PATH /tools --setenv PYTHONHOME "$prefix" \
    --setenv PYTHONDONTWRITEBYTECODE 1 --setenv LC_ALL C.UTF-8 \
    --setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_GLOBAL /state/gitconfig \
    /tools/bash --noprofile --norc -c "$@"
}
# Namespace/tool failure is fatal; loopback remains down, never host-network fallback.
stage=capability
(
  ulimit -f 16384
  sandbox "$work/capability" '
    set -eu
    (( BASH_VERSINFO[0] >= 4 ))
    python3 --version; git --version; rg --version
    git init -q --object-format=sha256 /state/sha256-fixture
    for provider in codex claude gemini gh cursor agent curl wget pip pip3 npm npx node; do
      ! command -v "$provider"
    done
  '
) > "$work/capability.log" 2>&1
stage=red
set +e
(
  ulimit -f 16384
  sandbox "$work/red" '
    exec timeout --signal=TERM --kill-after=5s 150s \
      env -u REVIEW_COUNCIL_TEST_DISCOVER -u REVIEW_COUNCIL_TEST_WORKERS \
      REVIEW_COUNCIL_TEST_TASK=t-proof-budget.sh::test_required_source_union_nonmonotone \
      REVIEW_COUNCIL_TEST_RESULTS_FILE=/state/out/red.results \
      bash /runtime/tests/run-tests.sh
  '
) > "$work/red.log" 2>&1
red_rc=$?
set -e
stage=parser
"$python" -I -B .github/qa/minimum-source-union-red.py gate "$work" "$public" "$red_rc" > "$work/parser.log" 2>&1
stage=complete
