import hashlib
import json
import os
import pathlib
import shlex
import subprocess
import tempfile

from checks import EVIDENCE, PACKET, SOURCE, boolean_failure, jest, plain, tree


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def restored():
    return tree() == SOURCE['tree'] and all(sha(pathlib.Path(p)) == h for p, h in SOURCE['files'].items())


assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == SOURCE['head']
assert restored()
for path, key in [('full.patch', 'full_patch_sha256'), ('functional.patch', 'functional_patch_sha256'),
                  ('functional-reverse.patch', 'functional_reverse_sha256')]:
    assert sha(PACKET / path) == SOURCE[key]
assert sha(PACKET / 'rev-mutate.sh') == SOURCE['installed_mutate_sha256']
with tempfile.TemporaryDirectory() as td:
    session = pathlib.Path(td)
    (session / 'scope.env').write_text('REV_ROOT=' + shlex.quote(str(pathlib.Path.cwd())) + '\n')
    (session / 'state.json').write_text('{"phase":"fix"}\n')
    try:
        subprocess.run(['git', 'apply', '--cached', '--unidiff-zero', str(PACKET / 'functional-reverse.patch')], check=True)
        assert subprocess.check_output(['git', 'write-tree'], text=True).strip() == SOURCE['functional_baseline_tree']
        delta = subprocess.check_output(['git', 'diff', '--full-index', '--unified=0', '--binary'])
        assert hashlib.sha256(delta).hexdigest() == SOURCE['functional_patch_sha256']
        command = 'python3 ' + shlex.quote(str(PACKET / 'run-tests.py'))
        with (EVIDENCE / 'mutate.log').open('w') as log:
            result = subprocess.run(['bash', str(PACKET / 'rev-mutate.sh'), str(session), command],
                                    stdout=log, stderr=subprocess.STDOUT)
        print((EVIDENCE / 'mutate.log').read_text(errors='replace'), end='')
        runs = json.loads((EVIDENCE / 'runs.json').read_text())
        assert result.returncode == 0 and len(runs) == SOURCE['hunks'] + 2 and all(r['valid'] for r in runs)
        assert sum(r.get('mutation', {}).get('kind') == 'structural' for r in runs if r.get('mutation')) == 5
        assert sum(r.get('mutation', {}).get('kind') == 'functional' for r in runs if r.get('mutation')) == 8
        assert restored()
    finally:
        subprocess.run(['git', 'read-tree', 'HEAD'], check=True)

semantic = []
for row in json.loads((PACKET / 'semantic-mutations.json').read_text()):
    path = pathlib.Path(row['path'])
    original = path.read_bytes()
    text = original.decode()
    if row['reader_region']:
        start = text.index('export async function readMirroredDelegateProof')
        end = text.index('export function setAutoConsumeSetting', start)
        segment = text[start:end]
        assert segment.count(row['old']) == 1
        changed = text[:start] + segment.replace(row['old'], row['new']) + text[end:]
    else:
        assert text.count(row['old']) == 1
        changed = text.replace(row['old'], row['new'])
    try:
        path.write_text(changed)
        assert sha(path) == row['sha256'] and tree() == row['source_tree']
        data = jest('semantic-' + row['name'])
        matches = [a for a in data['failed_assertions'] if row['prediction'] in a['fullName']]
        valid = data['valid'] and data['exit_code'] != 0 and bool(matches)
        if row['name'] == 'reader-absent-false':
            valid = valid and any('toBeUndefined' in plain(a) and 'Received: false' in plain(a) for a in matches)
        else:
            valid = valid and any(boolean_failure(a) for a in matches)
        valid = valid and all('ReferenceError' not in plain(a) and 'TypeError' not in plain(a)
                              for a in data['failed_assertions'])
        data.update(valid=bool(valid), mutation=row)
        semantic.append(data)
        (EVIDENCE / 'semantic-runs.json').write_text(json.dumps(semantic, indent=2) + '\n')
        assert valid, row['name']
    finally:
        path.write_bytes(original)
        assert restored()
closing = jest('semantic-closing')
assert closing['valid'] and closing['exit_code'] == 0 and closing['counts']['numPassedTests'] == 325
(EVIDENCE / 'semantic-closing-summary.json').write_text(json.dumps(closing, indent=2) + '\n')
assert restored()
(EVIDENCE / 'verified.json').write_text(json.dumps(dict(valid=True, source=SOURCE,
    installed_hunks=13, structural_typecheck_only=5, functional_hunks=8,
    extra_functional_mutations=len(semantic), baseline_tests=325, closing_tests=325,
    source_exact_restored=True), indent=2) + '\n')
