#!/bin/bash
set -euo pipefail
PACKET=$(cd "$(dirname "$0")" && pwd)
export PROOF_EVIDENCE="$RUNNER_TEMP/q6-c3-proof-evidence"
mkdir -p "$PROOF_EVIDENCE/session"
test "$(git rev-parse HEAD^{tree})" = 9324fd0bdb69e1fb6eb17faf2f17fcd6ee7209a9
echo '32bf2e9ca9c676dac2916f9bf3acc1c048e5fa76060178a6cb65fd61ee045bfc  rev-mutate.sh' | (cd "$PACKET" && sha256sum -c -)
echo '3d3b5614bede34aab80a79c3708b7371b5b197fb0358f8f1d9052e9f07e579fb  reverse.patch' | (cd "$PACKET" && sha256sum -c -)
cp "$PACKET/"{rev-mutate.sh,reverse.patch,source-proof.json,hunk-predictions.json,mutation-trees.json,functional-zero.patch} "$PROOF_EVIDENCE/"
printf 'REV_ROOT=%q\n' "$PWD" > "$PROOF_EVIDENCE/session/scope.env"
printf '{"phase":"fix"}\n' > "$PROOF_EVIDENCE/session/state.json"
restore_index() { git read-tree HEAD; }
trap restore_index EXIT
git apply --cached "$PACKET/reverse.patch"
test "$(git diff --unified=0 | grep -c '^@@')" = 7
test "$(git diff --name-only)" = src/lib/settings/helpers.ts
git diff --unified=0 > "$PROOF_EVIDENCE/measured.patch"
cmp "$PROOF_EVIDENCE/measured.patch" "$PACKET/functional-zero.patch"
set +e
bash "$PACKET/rev-mutate.sh" "$PROOF_EVIDENCE/session" "python3 '$PACKET/run-tests.py'" 2>&1 | tee "$PROOF_EVIDENCE/helper.log"
helper_status=${PIPESTATUS[0]}
set -e
restore_index
python3 - "$PROOF_EVIDENCE" "$helper_status" <<'VERIFY'
import json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]); runs=json.loads((p/'runs.json').read_text())
assert sys.argv[2]=='0',sys.argv[2]
assert [r['label'] for r in runs]==['baseline']+[f'mutation-{n}' for n in range(1,8)]+['closing'],runs
assert all(r['valid'] for r in runs),runs
helper=(p/'helper.log').read_text()
assert 'reverted 7 hunk(s) across 1 file(s); unpinned=0' in helper
assert helper.count('rev-mutate: PINNED src/lib/settings/helpers.ts hunk ')==7
assert subprocess.check_output(['git','write-tree'],text=True).strip()=='9324fd0bdb69e1fb6eb17faf2f17fcd6ee7209a9'
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
(p/'verified.json').write_text(json.dumps(dict(verified=True,source_sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),source_tree='9324fd0bdb69e1fb6eb17faf2f17fcd6ee7209a9',structural_hunks=[1],functional_hunks=[2,3,4,5,6,7],runs=runs),indent=2)+'\n')
VERIFY
