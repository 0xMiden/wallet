#!/usr/bin/env bash

set -euo pipefail

# Run the actual composite action body with the shell options Actions supplies.
# Only external installs, timeout and backoff are replaced, so no network or wait is needed.
repo_root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
awk '/^      run: \|$/ { body = 1; next } body { sub(/^        /, ""); print }' \
  "$repo_root/.github/actions/yarn-install/action.yml" > "$work/install.sh"
test -s "$work/install.sh"

cat > "$work/bin/yarn" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = 'install --network-timeout 600000' ] || exit 42
count=$(( $(cat "$INSTALL_COUNT") + 1 ))
printf '%s\n' "$count" > "$INSTALL_COUNT"
if [ "$count" -le "$FAILED_INSTALLS" ]; then exit "$INSTALL_FAILURE"; fi
STUB

cat > "$work/bin/timeout" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "$ATTEMPT_TIMEOUT" ] || exit 42
shift
exec "$@"
STUB

cat > "$work/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$INSTALL_DELAYS"
STUB
chmod +x "$work/bin/"*

failures=0
check() {
  local name=$1 attempts=$2 failed_installs=$3 failure=$4 want_exit=$5 want_calls=$6 want_delays=$7
  local got=0 problem='' calls delays log
  printf '0\n' > "$work/count"
  : > "$work/delays"
  # An independent Bash process retains -e even when its caller captures failure.
  env PATH="$work/bin:$PATH" ATTEMPTS="$attempts" ATTEMPT_TIMEOUT=6m \
    INSTALL_COUNT="$work/count" INSTALL_DELAYS="$work/delays" \
    FAILED_INSTALLS="$failed_installs" INSTALL_FAILURE="$failure" \
    bash --noprofile --norc -e -o pipefail "$work/install.sh" > "$work/log" 2>&1 || got=$?
  calls=$(cat "$work/count")
  delays=$(tr '\n' ' ' < "$work/delays")
  if [ "$failed_installs" -gt 0 ]; then
    log=$(cat "$work/log")
    if [ "$attempts" -gt 1 ]; then
      [[ "$log" == *"(attempt 1/$attempts, exit $failure)"* ]] || problem="$problem retry warning lost exit$failure;"
    fi
    if [ "$failure" -eq 124 ]; then
      [[ "$log" == *"yarn install exceeded 6m (attempt 1/$attempts)"* ]] || problem="$problem timeout warning missing;"
    fi
  fi
  [ "$got" -eq "$want_exit" ] || problem="$problem exit=$got want=$want_exit;"
  [ "$calls" -eq "$want_calls" ] || problem="$problem installs=$calls want=$want_calls;"
  [ "$delays" = "$want_delays" ] || problem="$problem delays='$delays' want='$want_delays';"
  if [ -n "$problem" ]; then
    printf 'FAIL %s:%s\n' "$name" "$problem" >&2
    cat "$work/log" >&2
    failures=$((failures + 1))
  else
    printf 'ok   %s\n' "$name"
  fi
}

check 'successful install needs no retry' 3 0 7 0 1 ''
check 'transient failure recovers on the second attempt' 3 1 7 0 2 '15 '
check 'two failures recover on the final attempt' 3 2 7 0 3 '15 30 '
check 'exhausted retries fail without a fourth install or final sleep' 3 3 7 1 3 '15 30 '
check 'a timeout is retried' 3 1 124 0 2 '15 '
check 'a caller can limit the attempts' 2 3 7 1 2 '15 '

if [ "$failures" -ne 0 ]; then
  printf '%s check(s) failed\n' "$failures" >&2
  exit 1
fi
