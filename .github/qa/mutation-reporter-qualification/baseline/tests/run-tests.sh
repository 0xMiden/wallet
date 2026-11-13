#!/bin/bash
# run-tests.sh [name-filter] - unit tests for the rev scripts. Real CLIs are shimmed by tests/shims.
# Unfiltered runs schedule exact test identities longest first across at most four isolated workers.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); SK=$(cd "$HERE/.." && pwd)
SCRIPTS="$SK/scripts"; FX="$HERE/fixtures"; SHIMS="$HERE/shims"
STACK="$SCRIPTS"
FILTER=${1:-}
EXACT_TASK=${REVIEW_COUNCIL_TEST_TASK:-}
DISCOVER=${REVIEW_COUNCIL_TEST_DISCOVER:-}
T=$(mktemp -d /tmp/rev-tests.XXXXXX) || exit 1
cleanup() {
  local pid
  for pid in $(jobs -pr 2>/dev/null); do kill -TERM "$pid" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$T/system-tmp" || exit 1
export TMPDIR="$T/system-tmp"
RESULTS="$T/.results"
if [ -n "$EXACT_TASK" ]; then
  if [ -z "${REVIEW_COUNCIL_TEST_RESULTS_FILE:-}" ]; then
    echo "run-tests: exact selection requires a results file" >&2
    exit 2
  fi
  RESULTS=$REVIEW_COUNCIL_TEST_RESULTS_FILE
fi
: > "$RESULTS"
export REVIEW_COUNCIL_CONFIG="$T/no-such-config.json" \
       REVIEW_COUNCIL_CACHE_DIR="$T/cache" \
       REVIEW_COUNCIL_UPDATE_URL="file://$FX/plugin-same.json"
ok()   { echo ok   >> "$RESULTS"; echo "  ok   $1"; }
fail() { echo fail >> "$RESULTS"; echo "  FAIL $1${2:+ - $2}"; }
assert_eq()     { [ "$2" = "$3" ] && ok "$1" || fail "$1" "expected '$3' got '$2'"; }
assert_grep()   { grep -qE ${4:-} -- "$3" "$2" 2>/dev/null && ok "$1" || fail "$1" "no /$3/ in $2"; }
assert_nogrep() { grep -qE ${4:-} -- "$3" "$2" 2>/dev/null && fail "$1" "found /$3/ in $2" || ok "$1"; }
assert_exit()   { local name=$1 want=$2; shift 2; "$@" >/dev/null 2>&1; local got=$?; [ "$got" = "$want" ] && ok "$name" || fail "$name" "exit $got, wanted $want"; }
copy_writable_file() {
  cp "$1" "$2" && chmod u+w "$2"
}
copy_writable_tree() {
  cp -R "$1" "$2" && chmod -R u+w "$2"
}
seat_env() {
  export PATH="$SHIMS:$PATH" SHIM_FIXTURE_DIR="$FX" SHIM_ARGS_FILE="$T/args" REV_REPO="$T"
}
rc_write_live_launch_marker() {
  local target=$1 pid=${BASHPID:-$$} started
  started=$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null) || return 1
  [ -n "${started//[[:space:]]/}" ] || return 1
  printf 'cli\n%s\n%s\n' "$pid" "$started" > "$target"
}
mkrepo() {
  export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
  [ -f "$T/gitconfig" ] || printf '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' > "$T/gitconfig"
  mkdir -p "$1" && git -C "$1" init -q && echo a > "$1/a.txt" && git -C "$1" add . && git -C "$1" commit -qm "init"
}

TEST_FILES=("$HERE"/t-*.sh)
INVENTORY_FILE="$T/inventory"
DUPLICATE_FILE="$T/duplicates"

if [ -n "$EXACT_TASK" ]; then
  if [ -n "$FILTER" ] || [ -n "$DISCOVER" ] \
      || ! [[ "$EXACT_TASK" =~ ^t-[A-Za-z0-9_-]+\.sh::test_[A-Za-z0-9_]+$ ]]; then
    echo "run-tests: invalid exact test identity: $EXACT_TASK" >&2
    exit 2
  fi
  exact_file=${EXACT_TASK%%::*}
  exact_function=${EXACT_TASK##*::}
  [ -f "$HERE/$exact_file" ] || {
    echo "run-tests: unknown exact test identity: $EXACT_TASK" >&2
    exit 2
  }
  shopt -s extdebug
  for f in "${TEST_FILES[@]}"; do [ -f "$f" ] && . "$f"; done
  exact_detail=$(declare -F "$exact_function" 2>/dev/null || true)
  exact_source=${exact_detail##* }
  if [ -z "$exact_detail" ] || [ "$exact_source" != "$HERE/$exact_file" ]; then
    echo "run-tests: unknown exact test identity: $EXACT_TASK" >&2
    exit 2
  fi
  exact_short=${exact_function#test_}
  echo "$exact_short"
  "$exact_function"
  exact_rc=$?
  [ "$exact_rc" -eq 0 ] || fail "$exact_short" "exited $exact_rc before reporting"
  exact_pass=$(grep -c '^ok$' "$RESULTS" || true)
  exact_fail=$(grep -c '^fail$' "$RESULTS" || true)
  if [ "$exact_pass" -eq 0 ] && [ "$exact_fail" -eq 0 ]; then
    fail "$exact_short" "reported no assertions"
    exact_fail=1
  fi
  [ "$exact_fail" -eq 0 ]
  exit $?
fi

discover_tests() {
  local f
  : > "$INVENTORY_FILE"
  for f in "${TEST_FILES[@]}"; do
    [ -f "$f" ] || continue
    (
      shopt -s extdebug
      . "$f" >/dev/null
      local name detail source
      for name in $(declare -F | awk '{print $3}'); do
        [[ "$name" == test_* ]] || continue
        detail=$(declare -F "$name")
        source=${detail##* }
        [ "$source" = "$f" ] || continue
        printf '%s::%s\n' "$(basename "$f")" "$name"
      done
    ) >> "$INVENTORY_FILE" || return 1
  done
  sort -o "$INVENTORY_FILE" "$INVENTORY_FILE"
  sed 's/^.*:://' "$INVENTORY_FILE" | sort | uniq -d | sed 's/^/cross-file::/' > "$DUPLICATE_FILE"
  python3 - "${TEST_FILES[@]}" >> "$DUPLICATE_FILE" <<'PY'
import re
import sys

definition = re.compile(
    r"^\s*(?:function\s+(test_[A-Za-z0-9_]+)(?:\s*\(\s*\))?|"
    r"(test_[A-Za-z0-9_]+)\s*\(\s*\))"
)


def heredocs(line):
    found = []
    index = 0
    quote = None
    while index < len(line):
        char = line[index]
        if quote:
            if char == quote:
                quote = None
            elif char == "\\" and quote == '"':
                index += 1
            index += 1
            continue
        if char in "'\"":
            quote = char
            index += 1
            continue
        if char == "#" and (index == 0 or line[index - 1].isspace()):
            break
        if not line.startswith("<<", index) or line.startswith("<<<", index):
            index += 1
            continue
        index += 2
        strip_tabs = index < len(line) and line[index] == "-"
        index += int(strip_tabs)
        while index < len(line) and line[index] in " \t":
            index += 1
        word = []
        word_quote = None
        while index < len(line):
            char = line[index]
            if word_quote:
                if char == word_quote:
                    word_quote = None
                elif char == "\\" and word_quote == '"' and index + 1 < len(line):
                    index += 1
                    word.append(line[index])
                else:
                    word.append(char)
                index += 1
                continue
            if char in "'\"":
                word_quote = char
                index += 1
                continue
            if char == "\\" and index + 1 < len(line):
                index += 1
                word.append(line[index])
                index += 1
                continue
            if char.isspace() or char in ";|&<>()":
                break
            word.append(char)
            index += 1
        if word:
            found.append(("".join(word), strip_tabs))
    return found


for path in sys.argv[1:]:
    counts = {}
    pending = []
    with open(path, encoding="utf-8") as source:
        for raw in source:
            line = raw.rstrip("\n")
            if pending:
                delimiter, strip_tabs = pending[0]
                if (line.lstrip("\t") if strip_tabs else line) == delimiter:
                    pending.pop(0)
                continue
            match = definition.match(line)
            if match:
                name = match.group(1) or match.group(2)
                counts[name] = counts.get(name, 0) + 1
            pending.extend(heredocs(line))
    for name, count in counts.items():
        if count > 1:
            print(f"{path.rsplit('/', 1)[-1]}::{name}")
PY
  sort -u -o "$DUPLICATE_FILE" "$DUPLICATE_FILE"
  if [ -s "$DUPLICATE_FILE" ]; then
    while IFS= read -r identity; do
      echo "run-tests: duplicate test function: ${identity##*::}" >&2
    done < "$DUPLICATE_FILE"
    return 1
  fi
}

discover_tests || exit 1
if [ -n "$DISCOVER" ]; then
  if [ -n "$FILTER" ] || [ -n "$EXACT_TASK" ]; then
    echo "run-tests: discovery cannot be combined with selection" >&2
    exit 2
  fi
  cat "$INVENTORY_FILE"
  exit 0
fi
for f in "${TEST_FILES[@]}"; do [ -f "$f" ] && . "$f"; done
MATCHED=0
run() {
  local short=$1 function=$2
  [ -z "$FILTER" ] || [[ "$short" == *"$FILTER"* ]] || return 0
  MATCHED=$((MATCHED + 1))
  echo "$short"
  "$function"
  local rc=$?
  [ "$rc" -eq 0 ] || fail "$short" "exited $rc before reporting"
}

if [ -n "$FILTER" ]; then
  while IFS= read -r identity; do
    run "${identity##*::test_}" "${identity##*::}"
  done < "$INVENTORY_FILE"
  if [ "$MATCHED" -eq 0 ]; then fail "no test matched" "filter '$FILTER' selected nothing"; fi
  PASS=$(grep -c '^ok$' "$RESULTS" || true)
  FAIL=$(grep -c '^fail$' "$RESULTS" || true)
  echo; echo "passed=$PASS failed=$FAIL"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

requested=${REVIEW_COUNCIL_TEST_WORKERS:-4}
case "$requested" in
  ''|*[!0-9]*) echo "run-tests: REVIEW_COUNCIL_TEST_WORKERS must be a positive integer" >&2; exit 2 ;;
esac
requested=$(printf '%s' "$requested" | sed 's/^0*//')
if [ -z "$requested" ]; then
  echo "run-tests: REVIEW_COUNCIL_TEST_WORKERS must be a positive integer" >&2
  exit 2
fi
workers=4
if [ "${#requested}" -eq 1 ] && [ "$requested" -le 4 ]; then workers=$requested; fi

ORDERED="$T/ordered"
python3 - "$INVENTORY_FILE" "$HERE/test-costs.tsv" > "$ORDERED" <<'PY'
import math
import sys

inventory_path, metadata_path = sys.argv[1:]
with open(inventory_path, encoding="utf-8") as source:
    inventory = [line.rstrip("\n") for line in source if line.strip()]
try:
    source = open(metadata_path, encoding="utf-8")
except OSError as error:
    print(f"run-tests: metadata unavailable: {error}", file=sys.stderr)
    raise SystemExit(2)

rows = {}
duplicate = []
invalid = []
with source:
    for number, raw in enumerate(source, 1):
        line = raw.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 3:
            print(f"run-tests: invalid metadata row {number}", file=sys.stderr)
            raise SystemExit(2)
        identity, cost_raw, task_class = fields
        if identity in rows:
            duplicate.append(identity)
            continue
        try:
            cost = float(cost_raw)
        except ValueError:
            cost = -1
        if not math.isfinite(cost) or cost <= 0:
            invalid.append(identity)
        if task_class not in {"normal", "exclusive"}:
            print(f"run-tests: invalid task class: {identity}", file=sys.stderr)
            raise SystemExit(2)
        rows[identity] = (cost, task_class)

for identity in sorted(set(duplicate)):
    print(f"run-tests: duplicate metadata: {identity}", file=sys.stderr)
for identity in sorted(set(invalid)):
    print(f"run-tests: invalid cost hint: {identity}", file=sys.stderr)
for identity in sorted(set(inventory) - set(rows)):
    print(f"run-tests: missing metadata: {identity}", file=sys.stderr)
for identity in sorted(set(rows) - set(inventory)):
    print(f"run-tests: unknown metadata: {identity}", file=sys.stderr)
if duplicate or invalid or set(inventory) != set(rows):
    raise SystemExit(2)

for identity, (cost, task_class) in sorted(rows.items(), key=lambda row: (-row[1][0], row[0])):
    print(f"{identity}\t{task_class}")
PY
METADATA_RC=$?
[ "$METADATA_RC" -eq 0 ] || exit "$METADATA_RC"

PARALLEL="$T/parallel"
mkdir -p "$PARALLEL"
active=0
task_count=0
declare -a TASKS TASK_CLASSES PIDS STATUSES OUTPUTS TALLIES

launch_task() {
  local identity=$1 task_class=$2 index=$3
  TASKS[$index]=$identity
  TASK_CLASSES[$index]=$task_class
  OUTPUTS[$index]="$PARALLEL/$index.out"
  TALLIES[$index]="$PARALLEL/$index.results"
  REVIEW_COUNCIL_TEST_TASK="$identity" \
    REVIEW_COUNCIL_TEST_RESULTS_FILE="${TALLIES[$index]}" \
    REVIEW_COUNCIL_TEST_WORKERS=1 \
    bash "$HERE/run-tests.sh" > "${OUTPUTS[$index]}" 2>&1 &
  PIDS[$index]=$!
  active=$((active + 1))
}

reap_one() {
  local index pid rc
  while :; do
    for index in "${!PIDS[@]}"; do
      pid=${PIDS[$index]:-}
      [ -n "$pid" ] || continue
      if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid"; rc=$?
        STATUSES[$index]=$rc
        PIDS[$index]=''
        active=$((active - 1))
        return 0
      fi
    done
    sleep 0.02
  done
}

drain_workers() {
  local index pid rc
  for index in "${!PIDS[@]}"; do
    pid=${PIDS[$index]:-}
    [ -n "$pid" ] || continue
    wait "$pid"; rc=$?
    STATUSES[$index]=$rc
    PIDS[$index]=''
    active=$((active - 1))
  done
}

while IFS=$'\t' read -r identity task_class; do
  [ -n "$identity" ] || continue
  if [ "$task_class" = exclusive ]; then
    drain_workers
    launch_task "$identity" "$task_class" "$task_count"
    drain_workers
  else
    while [ "$active" -ge "$workers" ]; do reap_one; done
    launch_task "$identity" "$task_class" "$task_count"
  fi
  task_count=$((task_count + 1))
done < "$ORDERED"
drain_workers

PASS=0
FAIL=0
TASK_PASS=0
TASK_FAIL=0
index=0
while [ "$index" -lt "$task_count" ]; do
  cat "${OUTPUTS[$index]}"
  shard_pass=$(grep -c '^ok$' "${TALLIES[$index]}" 2>/dev/null || true)
  shard_fail=$(grep -c '^fail$' "${TALLIES[$index]}" 2>/dev/null || true)
  shard_total=$((shard_pass + shard_fail))
  PASS=$((PASS + shard_pass))
  FAIL=$((FAIL + shard_fail))
  rc=${STATUSES[$index]:-1}
  if [ "$rc" -eq 0 ] && [ "$shard_fail" -eq 0 ] && [ "$shard_total" -gt 0 ]; then
    TASK_PASS=$((TASK_PASS + 1))
  else
    TASK_FAIL=$((TASK_FAIL + 1))
    if [ "$shard_total" -eq 0 ]; then
      echo "  FAIL ${TASKS[$index]} - task reported no assertions"
      FAIL=$((FAIL + 1))
    elif [ "$shard_fail" -eq 0 ]; then
      echo "  FAIL ${TASKS[$index]} - task exited $rc before reporting"
      FAIL=$((FAIL + 1))
    fi
  fi
  index=$((index + 1))
done
echo
echo "inventory_total=$task_count"
echo "tasks_passed=$TASK_PASS tasks_failed=$TASK_FAIL"
echo "passed=$PASS failed=$FAIL"
[ "$TASK_PASS" -eq "$task_count" ] && [ "$TASK_FAIL" -eq 0 ] && [ "$FAIL" -eq 0 ]
