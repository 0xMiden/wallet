#!/usr/bin/env bash

set -euo pipefail

# Behavioural cover for scripts/resolve-linked-pr-number.sh, which decides whose description the
# linked-PR injections read. `gh` is a stub on PATH that records its arguments and answers with a
# fixed list of pull request numbers, so every case asserts the decision and the exact query and
# none reaches the network. Each of these mutants turns the suite red:
#   (a) treating workflow_dispatch like push      (b) dropping the head= filter
#   (c) accepting two open pull requests          (d) dropping the main / next refusal
#   (e) reading a failed lookup as "no pull request"
# Plain bash only: no grep or rg, which a bare `bash` run may not have.

repo_root=$(cd "$(dirname "$0")/.." && pwd)
resolver="$repo_root/scripts/resolve-linked-pr-number.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$GH_STUB_ARGS"
if [ "${GH_STUB_EXIT:-0}" -ne 0 ]; then
  echo "gh stub: failing as asked" >&2
  exit "$GH_STUB_EXIT"
fi
printf '%b' "${GH_STUB_OUTPUT:-}"
STUB
chmod +x "$work/bin/gh"
# Counters live in a file: each check runs in a subshell, where a variable increment is lost.
printf '0\n' > "$work/failures"

# check <name> <want-exit> <want-output> <want-gh-args | -> <want-log-fragment | -> [VAR=value ...]
# The environment is cleared first, so a run inside CI cannot leak its own GITHUB_* values in.
check() {
  local name=$1 want_exit=$2 want_output=$3 want_args=$4 want_log=$5 got=0 args="" problem=""
  shift 5
  : > "$work/output"
  rm -f "$work/args"
  env -i PATH="$work/bin:$PATH" HOME="${HOME:-/tmp}" GITHUB_OUTPUT="$work/output" GH_STUB_ARGS="$work/args" \
    GITHUB_REPOSITORY=0xMiden/wallet "$@" bash "$resolver" resolver-test > "$work/log" 2>&1 || got=$?
  if [ -f "$work/args" ]; then
    while IFS= read -r arg; do args="${args:+$args }$arg"; done < "$work/args"
  else
    args=-
  fi
  local output log
  output=$(cat "$work/output")
  log=$(cat "$work/log")
  [ "$got" -eq "$want_exit" ] || problem="$problem exit=$got want=$want_exit;"
  [ "$output" = "$want_output" ] || problem="$problem output='$output' want='$want_output';"
  [ "$args" = "$want_args" ] || problem="$problem gh='$args' want='$want_args';"
  if [ "$want_log" != - ] && [[ $log != *"$want_log"* ]]; then
    problem="$problem log lacks '$want_log';"
  fi
  if [ -z "$problem" ]; then
    printf 'ok   %s\n' "$name"
  else
    printf 'FAIL %s:%s\n     log: %s\n' "$name" "$problem" "$log"
    printf '%s\n' "$(( $(cat "$work/failures") + 1 ))" > "$work/failures"
  fi
}

branch=wiktor/custom-preview-at-tip
query() { printf 'api -X GET repos/0xMiden/wallet/pulls -f state=open -f head=0xMiden:%s -f per_page=100 --jq .[].number' "$1"; }

# --- the pull request path is unchanged: the event's own number, and no lookup ---
check 'pull_request reads the event number' 0 'number=1380' - - \
  GITHUB_EVENT_NAME=pull_request PR_NUMBER=1380 GITHUB_REF=refs/pull/1380/merge
check 'pull_request_target reads the event number' 0 'number=7' - - \
  GITHUB_EVENT_NAME=pull_request_target PR_NUMBER=7
check 'a pull_request with no number in its payload is a no-op' 0 'number=' - 'No PR number' \
  GITHUB_EVENT_NAME=pull_request

# --- a dispatch on a pull request's branch (mutants a, b, c) ---
check 'a dispatch with one open pull request reads it' 0 'number=1380' "$(query "$branch")" '#1380' \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="refs/heads/$branch" GH_STUB_OUTPUT='1380\n'
check 'a dispatch with no open pull request is a no-op' 0 'number=' "$(query "$branch")" 'No open pull request' \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="refs/heads/$branch" GH_STUB_OUTPUT=''
check 'a dispatch with two open pull requests fails and names both' 1 '' "$(query "$branch")" '#12, #34' \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="refs/heads/$branch" GH_STUB_OUTPUT='12\n34\n'
check 'a branch name reaches gh as one raw field, special characters included' 0 'number=5' "$(query 'feat/a+b&c')" - \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF='refs/heads/feat/a+b&c' GH_STUB_OUTPUT='5'

# --- a lookup that does not answer with numbers is a failure, never a silent no-op (mutant e) ---
check 'a dispatch whose lookup fails fails' 1 '' "$(query "$branch")" 'Could not list' \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="refs/heads/$branch" GH_STUB_EXIT=1
check 'a dispatch whose lookup answers a non-number fails' 1 '' "$(query "$branch")" "'null'" \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="refs/heads/$branch" GH_STUB_OUTPUT='null\n'

# --- main and next never inject, even while a main-into-next sync pull request is open (mutant d) ---
for long_lived in main next; do
  check "a dispatch on $long_lived is a no-op" 0 'number=' - 'never injects' \
    GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF="refs/heads/$long_lived" GH_STUB_OUTPUT='865\n'
done
check 'a dispatch on a tag is a no-op' 0 'number=' - 'refs/tags/v1.17.1' \
  GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF=refs/tags/v1.17.1 GH_STUB_OUTPUT='865\n'

# --- every other event is a no-op ---
check 'push is a no-op' 0 'number=' - 'event=push' \
  GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GH_STUB_OUTPUT='865\n'
for other in schedule release workflow_run; do
  check "$other is a no-op" 0 'number=' - "event=$other" \
    GITHUB_EVENT_NAME="$other" GITHUB_REF="refs/heads/$branch" GH_STUB_OUTPUT='1380\n'
done

failures=$(cat "$work/failures")
if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf '\nall checks passed\n'
