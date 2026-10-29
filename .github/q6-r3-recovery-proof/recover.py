import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess

from checks import EVIDENCE, PACKET, SOURCE, boolean_failure, jest, plain, tree

prior = pathlib.Path(os.environ['PRIOR_EVIDENCE'])
api = json.loads((EVIDENCE / 'prior-run-api.json').read_text())
assert api['headSha'] == SOURCE['prior_workflow'] and api['conclusion'] == 'failure'
old = json.loads((prior / 'source.json').read_text())
assert old['head'] == SOURCE['prior_source'] and old['tree'] == SOURCE['prior_tree']
assert (prior / 'workflow-sha.txt').read_text().strip() == SOURCE['prior_workflow']
assert hashlib.sha256((prior / 'rev-mutate.sh').read_bytes()).hexdigest() == SOURCE['installed_mutate_sha256']
assert old['full_patch_sha256'] == SOURCE['full_patch_sha256']
assert old['functional_patch_sha256'] == SOURCE['functional_patch_sha256']
changed = subprocess.check_output(['git', 'diff', '--name-only', SOURCE['prior_source'], 'HEAD'], text=True).splitlines()
assert changed == ['src/lib/miden/transaction/transaction-failure-sentry.integration.test.ts']
for path, value in old['files'].items():
    if path not in changed:
        assert SOURCE['files'][path] == value
runs = json.loads((prior / 'runs.json').read_text())
assert len(runs) == 15
for row in [runs[0], runs[-1]]:
    assert row['valid'] and row['source_tree'] == SOURCE['prior_tree'] and row['exit_code'] == 0
    assert row['counts']['numPassedTests'] == 325 and row['counts']['numRuntimeErrorTestSuites'] == 0
accepted = []
for number, row in enumerate(runs[1:-1], 1):
    if number in (10, 11):
        assert not row['valid']
        continue
    assert row['valid'] and row['exit_code'] != 0
    mutant = row['mutation']
    if mutant['kind'] == 'structural':
        text = (prior / (row['label'] + '.log')).read_text(errors='replace')
        assert row['counts'] is None and row['tests_executed'] == 0
        assert re.search(r'error TS\d+', text) and mutant['prediction'] in text
    else:
        assert row['counts']['numTotalTests'] == 325 and row['counts']['numRuntimeErrorTestSuites'] == 0
        matches = [a for a in row['failed_assertions'] if mutant['prediction'] in a['fullName']]
        assert matches
        if number in (3, 9, 13):
            assert any(boolean_failure(a) for a in matches)
        elif number == 12:
            assert any(boolean_failure(a, True, False) for a in matches)
        elif number == 5:
            assert any('"queueSighting": "never"' in plain(a) for a in matches)
        elif number == 6:
            assert any('toBeUndefined' in plain(a) and 'Received: "in_progress_gate"' in plain(a) for a in matches)
    accepted.append(number)
summary = (prior / 'mutate.log').read_text(errors='replace')
assert 'reverted 13 hunk(s) across 3 file(s); unpinned=0' in summary
assert 'UNMEASURED' not in summary and 'UNPINNED' not in summary
assert accepted == [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13]
shutil.copytree(prior, EVIDENCE / 'prior-proof', dirs_exist_ok=True)


def restored():
    return tree() == SOURCE['tree'] and all(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() == h
                                           for p, h in SOURCE['files'].items())


assert restored()
baseline = jest('recovery-baseline')
assert baseline['valid'] and baseline['exit_code'] == 0 and baseline['counts']['numPassedTests'] == 325
(EVIDENCE / 'recovery-baseline-summary.json').write_text(json.dumps(baseline, indent=2) + '\n')
mutants = json.loads((PACKET / 'semantic-mutations.json').read_text())
mutants.sort(key=lambda row: (0 if row.get('replaces_invalid_prior') else 1, row['name']))
records = []
for row in mutants:
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
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256']
        assert tree() == row['source_tree']
        data = jest('recovery-' + row['name'])
        matches = [a for a in data['failed_assertions'] if row['prediction'] in a['fullName']]
        valid = data['valid'] and data['exit_code'] != 0 and bool(matches)
        if row['name'] == 'reader-absent-false':
            valid = valid and any('toBeUndefined' in plain(a) and 'Received: false' in plain(a) for a in matches)
        elif row['name'] == 'old-queue-writer-counterfactual':
            valid = valid and data['counts']['numFailedTests'] == 2
            valid = valid and any('toBeUndefined' in plain(a) and 'Received: "in_progress_gate"' in plain(a)
                                  for a in matches)
            valid = valid and any(row['also_prediction'] in a['fullName'] and '"queueSighting": "never"' in plain(a)
                                  for a in data['failed_assertions'])
        else:
            valid = valid and any(boolean_failure(a) for a in matches)
        valid = valid and all('ReferenceError' not in plain(a) and 'TypeError' not in plain(a)
                              for a in data['failed_assertions'])
        data.update(valid=bool(valid), mutation=row)
        records.append(data)
        (EVIDENCE / 'recovery-runs.json').write_text(json.dumps(records, indent=2) + '\n')
        assert valid, row['name']
    finally:
        path.write_bytes(original)
        assert restored()
closing = jest('recovery-closing')
assert closing['valid'] and closing['exit_code'] == 0 and closing['counts']['numPassedTests'] == 325
(EVIDENCE / 'recovery-closing-summary.json').write_text(json.dumps(closing, indent=2) + '\n')
assert restored()
(EVIDENCE / 'verified.json').write_text(json.dumps(dict(valid=True, source=SOURCE,
    prior_run=SOURCE['prior_run'], prior_accepted_hunks=accepted,
    prior_structural_typecheck_only=5, prior_direct_functional_hunks=6,
    raw_misplaced_hunks_without_functional_credit=[10, 11], intended_site_corrections=2,
    extra_semantic_mutations=5, refined_fixture_old_writer_counterfactual=True,
    baseline_tests=325, closing_tests=325, source_exact_restored=True), indent=2) + '\n')
