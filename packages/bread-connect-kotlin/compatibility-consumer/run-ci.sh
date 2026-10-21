#!/usr/bin/env bash
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0
proof="${RUNNER_TEMP:?}/bread-connect-external-consumer-red-proof"
mkdir -p "$proof"
repo_root="$(git rev-parse --show-toplevel)"
fixture="$repo_root/packages/bread-connect-kotlin/compatibility-consumer"
consumer="${RUNNER_TEMP}/bread-connect-external-consumer"

snapshot() {
  local label="$1"
  python3 - "$repo_root" "$proof" "$label" <<'SNAPSHOT'
from pathlib import Path
import hashlib,json,os,stat,subprocess,sys
root,proof,label=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
def git(*args): return subprocess.check_output(['git',*args],cwd=root)
paths=git('ls-files','-z','packages/bread-connect-kotlin').split(b'\0')
rows=[]
for raw in paths:
    if not raw: continue
    relative=os.fsdecode(raw)
    path=root/relative
    mode=path.lstat().st_mode
    if not stat.S_ISREG(mode): raise SystemExit('nonregular scoped source')
    body=path.read_bytes()
    rows.append({'path':relative,'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),'mode':oct(stat.S_IMODE(mode))})
(proof/(label+'-source.json')).write_text(json.dumps(rows,indent=2)+'\n')
(proof/(label+'-stage-map.bin')).write_bytes(git('ls-files','--stage','-z'))
index=Path(git('rev-parse','--path-format=absolute','--git-path','index').decode().strip())
(proof/(label+'-index.bin')).write_bytes(index.read_bytes())
(proof/(label+'-status.bin')).write_bytes(git('status','--porcelain=v1','-z'))
(proof/(label+'-head.txt')).write_bytes(git('rev-parse','HEAD','HEAD^{tree}','HEAD^'))
SNAPSHOT
}

finish() {
  local natural_exit="$?"
  trap - EXIT
  set +e
  snapshot after >"$proof/after-snapshot.log" 2>&1
  local snapshot_exit="$?"
  printf '%s\n' "$snapshot_exit" >"$proof/after-snapshot.exit"
  local source_exit=0
  local entry
  for entry in source.json stage-map.bin index.bin status.bin head.txt; do
    cmp "$proof/before-$entry" "$proof/after-$entry"
    local compare_exit="$?"
    printf '%s\n' "$compare_exit" >"$proof/$entry-compare.exit"
    if (( compare_exit != 0 )); then source_exit=1; fi
  done
  printf '%s\n' "$source_exit" >"$proof/source-compare.exit"
  printf '%s\n' "$natural_exit" >"$proof/collector-natural.exit"
  if (( snapshot_exit != 0 || source_exit != 0 )); then exit 91; fi
  exit "$natural_exit"
}
trap finish EXIT

run_logged() {
  local label="$1"
  shift
  printf '%q ' "$@" >"$proof/$label.argv"
  printf '\n' >>"$proof/$label.argv"
  set +e
  "$@" 2>&1 | tee "$proof/$label.log"
  local statuses=("${PIPESTATUS[@]}")
  set -e
  printf '%s\n' "${statuses[0]}" >"$proof/$label.natural.exit"
  printf '%s\n' "${statuses[1]}" >"$proof/$label.tee.exit"
  if (( statuses[1] != 0 )); then return "${statuses[1]}"; fi
  return "${statuses[0]}"
}

[[ "$(git rev-parse HEAD)" == "${BREAD_CONNECT_SOURCE_SHA:?}" ]]
[[ "$(git rev-parse HEAD^)" == e04941588205f4d9e6dbc75c1a35e95b1646a2dd ]]
snapshot before
printf '%s\n' "${GITHUB_SHA:?}" "${GITHUB_REF:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" >"$proof/transport-identity.txt"
java -version >"$proof/java-version.log" 2>&1
cd "$repo_root/packages/bread-connect-kotlin"
run_logged sdk-assemble ./gradlew assembleDebug --console=plain --max-workers=2
export BREAD_CONNECT_CANDIDATE_AAR="$PWD/build/outputs/aar/bread-connect-debug.aar"
[[ -f "$BREAD_CONNECT_CANDIDATE_AAR" ]]
sha256sum "$BREAD_CONNECT_CANDIDATE_AAR" >"$proof/candidate-aar.sha256"
cp "$BREAD_CONNECT_CANDIDATE_AAR" "$proof/candidate-sdk.aar"
[[ ! -e "$consumer" ]]
cp -R "$fixture/consumer" "$consumer"
cd "$consumer"
run_logged classpath-control "$repo_root/packages/bread-connect-kotlin/gradlew" compileDebugKotlin --console=plain --max-workers=2
cp "$fixture/LegacyConsumer.kt" src/main/kotlin/consumer/LegacyConsumer.kt
sha256sum src/main/kotlin/consumer/*.kt >"$proof/external-consumer-source.sha256"
run_logged legacy-consumer "$repo_root/packages/bread-connect-kotlin/gradlew" compileDebugKotlin --console=plain --max-workers=2
