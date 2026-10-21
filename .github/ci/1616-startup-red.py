import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

SOURCE = '95e383a01b5522ec5a6e5de7ee1eaca5421b36ee'
ROOT = Path.cwd().resolve()
OUT = Path(os.environ['PROOF_DIR'])
TESTS = ['src/components/FeatureUnavailable.test.tsx', 'src/app/WalletAccessGate.test.tsx']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


def snapshot(label):
    assert git('rev-parse', 'HEAD').decode().strip() == SOURCE
    assert not git('diff', '--name-only') and not git('diff', '--cached', '--name-only')
    stage = git('ls-files', '--stage', '-z')
    files = {}
    for record in stage.split(b'\0'):
        if not record:
            continue
        header, raw_path = record.split(b'\t', 1)
        mode, oid, number = header.split()
        assert number == b'0'
        path = raw_path.decode()
        p = ROOT / path
        data = os.readlink(p).encode() if mode == b'120000' else p.read_bytes()
        assert digest(data) == digest(git('cat-file', 'blob', oid.decode())), path
        files[path] = {'mode': mode.decode(), 'oid': oid.decode(), 'sha256': digest(data)}
    framework = {}
    for name in ['jest', 'jest-config', 'jest-runtime', 'jest-resolve', 'jest-runner',
                 'jest-environment-jsdom', 'react', 'react-dom', '@testing-library/react',
                 '@testing-library/dom', '@swc/jest', '@swc/core', 'typescript']:
        base = ROOT / 'node_modules' / name
        assert base.is_dir(), name
        for p in sorted(base.rglob('*')):
            if p.is_file():
                assert p.resolve().is_relative_to(ROOT)
                framework[str(p.relative_to(ROOT))] = digest(p.read_bytes())
    index = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not index.is_absolute():
        index = ROOT / index
    (OUT / f'{label}.index').write_bytes(index.read_bytes())
    save(f'{label}.json', {'head': SOURCE, 'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
                         'stage_sha256': digest(stage), 'source': files, 'framework': framework})


def classify():
    before = json.loads((OUT / 'before.json').read_text())
    after = json.loads((OUT / 'after.json').read_text())
    assert before == after
    x = json.loads((OUT / 'jest.json').read_text())
    assert x['numTotalTestSuites'] == 2 and not x['numRuntimeErrorTestSuites']
    assert not x['numPendingTests'] and not x['numTodoTests']
    expected = {
        'user-visible unavailable-feature errors keeps a visible geographic restriction quiet',
        'user-visible unavailable-feature errors cancels an outage dwell when a geographic restriction replaces it',
        'user-visible unavailable-feature errors starts a full outage dwell after a geographic restriction clears',
        'startup eligibility failure reporting reports a visible decision failure after a full dwell',
        'startup eligibility failure reporting reports a visible endpoint bootstrap failure after a full dwell'
    }
    rows = []
    assert {str(Path(s['name']).relative_to(ROOT)) for s in x['testResults']} == set(TESTS)
    for suite in x['testResults']:
        for ordinal, row in enumerate(suite['assertionResults']):
            rows.append({'file': str(Path(suite['name']).relative_to(ROOT)), 'ordinal': ordinal,
                         'name': row['fullName'], 'status': row['status'],
                         'failureMessages': row['failureMessages']})
    assert len(rows) == x['numTotalTests'] and len(rows) >= 25
    assert {r['name'] for r in rows if r['status'] == 'failed'} == expected
    assert all(r['status'] in ['passed', 'failed'] for r in rows)
    assert x['numFailedTests'] == 5 and x['numPassedTests'] == len(rows) - 5
    assert (OUT / 'jest.exit').read_text().strip() == '1'
    assert (OUT / 'jest.tee.exit').read_text().strip() == '0'
    save('inventory.json', rows)
    save('classification.json', {'status': 'EXPECTED_FIVE_CAUSAL_FAILURES', 'total': len(rows),
                                 'passed': len(rows) - 5, 'failed': 5, 'source': SOURCE,
                                 'source_and_framework_bookends_exact': True,
                                 'raw_index_retained_for_separate_semantic_comparison': True})


def seal():
    save('hashes.json', [{'path': str(p.relative_to(OUT)), 'bytes': p.stat().st_size,
                          'sha256': digest(p.read_bytes())} for p in sorted(OUT.rglob('*'))
                         if p.is_file() and p.name != 'hashes.json'])


if sys.argv[1] == 'snapshot':
    snapshot(sys.argv[2])
elif sys.argv[1] == 'classify':
    classify()
elif sys.argv[1] == 'seal':
    seal()
else:
    raise SystemExit('unknown operation')
