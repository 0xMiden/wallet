#!/bin/bash
set -euo pipefail
PACKET=$(cd "$(dirname "$0")" && pwd)
export PROOF_EVIDENCE="$RUNNER_TEMP/q6-c04-evidence"
mkdir -p "$PROOF_EVIDENCE/session"
python3 - "$PACKET" <<'CHECK'
import pathlib,json,hashlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);m=json.loads((p/'source.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()==m['tree']
for f,k in [('rev-mutate.sh','helper_sha256'),('reverse.patch','reverse_sha256'),('functional-zero.patch','canonical_functional_sha256')]:assert hashlib.sha256((p/f).read_bytes()).hexdigest()==m[k]
CHECK
cp "$PACKET/"* "$PROOF_EVIDENCE/"
printf 'REV_ROOT=%q\n' "$PWD" > "$PROOF_EVIDENCE/session/scope.env"
printf '{"phase":"fix"}\n' > "$PROOF_EVIDENCE/session/state.json"
restore_index() { git read-tree HEAD; }
trap restore_index EXIT
git apply --cached "$PACKET/reverse.patch"
test "$(git diff --unified=0 | grep -c '^@@')" = 4
test "$(git diff --name-only)" = src/lib/settings/helpers.ts
git diff --full-index --unified=0 > "$PROOF_EVIDENCE/measured.patch"
cmp "$PROOF_EVIDENCE/measured.patch" "$PACKET/functional-zero.patch"
set +e
bash "$PACKET/rev-mutate.sh" "$PROOF_EVIDENCE/session" "python3 '$PACKET/run-tests.py'" 2>&1 | tee "$PROOF_EVIDENCE/helper.log"
helper_status=${PIPESTATUS[0]}
set -e
restore_index
python3 - "$PROOF_EVIDENCE" "$helper_status" <<'VERIFY'
import json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);runs=json.loads((p/'runs.json').read_text());m=json.loads((p/'source.json').read_text())
assert sys.argv[2]=='0',sys.argv[2]
assert [r['label'] for r in runs]==['baseline']+[f'mutation-{n}' for n in range(1,5)]+['closing']
assert all(r['valid'] for r in runs),runs
helper=(p/'helper.log').read_text()
assert 'reverted 4 hunk(s) across 1 file(s); unpinned=0' in helper
assert helper.count('rev-mutate: PINNED src/lib/settings/helpers.ts hunk ')==4
assert subprocess.check_output(['git','write-tree'],text=True).strip()==m['tree']
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
(p/'verified.json').write_text(json.dumps(dict(verified=True,source_sha=m['source_sha'],source_tree=m['tree'],structural_hunks=[1,3],functional_hunks=[2,4],runs=runs),indent=2)+'\n')
VERIFY
