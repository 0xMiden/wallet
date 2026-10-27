#!/usr/bin/env python3
"""CI-only consumer of existing auth4 evidence; never invoke a browser or install."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Disposable CI evidence consumption only')
root = Path(os.environ['GITHUB_WORKSPACE'])
controller = root / 'controller'
cfg = json.loads((controller / '.github/ci/issue1948-auth4-consumer/inputs.json').read_text())
out = root / 'evidence'
out.mkdir(exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
def save(name, value):
    (out / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
def api(endpoint, name, raw=False):
    argv = ['gh', 'api'] + (['--allow-escape-sequences'] if raw else [])
    with (out / name).open('wb') as dest, (out / (name + '.stderr.log')).open('wb') as errors:
        subprocess.run(argv + ['repos/0xMiden/wallet/' + endpoint], stdout=dest, stderr=errors, check=True, timeout=90)
    return None if raw else json.loads((out / name).read_text())
def git(*args):
    return subprocess.check_output(['git', *args], cwd=controller)
assert git('rev-parse', 'HEAD').decode().strip() == os.environ['GITHUB_SHA']
assert git('show', '-s', '--format=%P', 'HEAD').decode().split() == [cfg['wallet_source']]
assert git('rev-parse', 'HEAD^' + '^{tree}').decode().strip() == cfg['wallet_tree']
assert sorted(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').decode().splitlines()) == sorted(cfg['proof_paths'])
for name, expected in {**cfg['fixture_files'], **cfg['wallet_source_file_sha256']}.items():
    assert hashlib.sha256(git('show', cfg['wallet_source'] + ':' + name)).hexdigest() == expected
run = api('actions/runs/' + str(cfg['original_run']), 'original-run.json')
job = api('actions/jobs/' + str(cfg['original_job']), 'original-job.json')
artifact = api('actions/artifacts/' + str(cfg['consumer_artifact_id']), 'original-artifact.json')
producer = api('git/commits/' + cfg['original_workflow'], 'original-workflow.json')
assert run['head_sha'] == cfg['original_workflow'] and run['status'] == 'completed' and run['conclusion'] == 'failure'
assert job['run_id'] == cfg['original_run'] and job['conclusion'] == 'failure'
assert run['run_attempt'] == job['run_attempt'] == 1
steps = {step['name']: step['conclusion'] for step in job['steps']}
assert steps['run'] == 'success' and steps['verify'] == 'failure'
assert steps['Preserve frozen sources and all42 assets after any failure'] == 'success'
assert [p['sha'] for p in producer['parents']] == [cfg['wallet_source']]
assert (artifact['id'], artifact['name'], artifact['size_in_bytes'], artifact['digest'], artifact['expired']) == (cfg['consumer_artifact_id'], cfg['consumer_artifact_name'], cfg['consumer_artifact_bytes'], cfg['consumer_artifact_digest'], False)
assert artifact['workflow_run']['id'] == cfg['original_run'] and artifact['workflow_run']['head_sha'] == cfg['original_workflow']
api('actions/artifacts/' + str(cfg['consumer_artifact_id']) + '/zip', 'original.zip', True)
archive = out / 'original.zip'
assert archive.stat().st_size == cfg['consumer_artifact_bytes'] and 'sha256:' + sha(archive) == cfg['consumer_artifact_digest']
small = root / 'small-proof'
small.mkdir(exist_ok=False)
names = set()
total = 0
with zipfile.ZipFile(archive) as z:
    for entry in z.infolist():
        path = PurePosixPath(entry.filename)
        assert not path.is_absolute() and '..' not in path.parts and '\\' not in entry.filename and ':' not in entry.filename and not stat.S_ISLNK(entry.external_attr >> 16)
        assert path.as_posix().rstrip('/') not in names
        names.add(path.as_posix().rstrip('/'))
        if entry.is_dir():
            continue
        assert entry.filename != 'sdk-dist.zip' and not entry.filename.endswith(('.wasm', '.tgz'))
        total += entry.file_size
        assert total <= cfg['small_limit_bytes']
        dest = small / entry.filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(z.read(entry))
load = lambda name: json.loads((small / name).read_text())
bindings = load('source-bindings.json')
assert bindings['wallet_source'] == cfg['wallet_source'] and bindings['wallet_tree'] == cfg['wallet_tree'] and bindings['workflow_sha'] == cfg['original_workflow'] and bindings['fixture_files'] == cfg['fixture_files']
assert bindings['sdk_source'] == cfg['sdk_head'] and bindings['sdk_tree'] == cfg['sdk_tree']
assert load('wallet-manifest-lock-before.json') == cfg['wallet_source_file_sha256']
preserved = load('preserved-source.json')
assert preserved['wallet_lock_unchanged'] is True and preserved['fixture_files'] == cfg['fixture_files'] and preserved['dist_files'] == 42
assert load('dist-before.json') == load('dist-after.json') == cfg['dist_sha256'] and len(cfg['dist_sha256']) == 42
assert 'RuntimeError: Unsafe authentication observations' in (small / 'stage-verify.log').read_text()
sdk_run = load('sdk-run.json'); sdk_artifact = load('sdk-artifact.json'); sdk_job = load('producer-job.json'); commit = load('producer-commit.json'); head = load('sdk-head.json')
assert sdk_run['head_sha'] == cfg['sdk_head'] and sdk_run['conclusion'] == 'success' and sdk_run['run_attempt'] == cfg['producer_attempt']
assert sdk_job['id'] == cfg['producer_job_id'] and sdk_job['run_id'] == cfg['producer_run'] and sdk_job['run_attempt'] == cfg['producer_attempt'] and sdk_job['conclusion'] == 'success'
assert commit['sha'] == cfg['producer_checkout'] and commit['tree']['sha'] == head['tree']['sha'] == cfg['sdk_tree'] and head['sha'] == cfg['sdk_head']
assert [p['sha'] for p in commit['parents']] == cfg['producer_parents']
assert (sdk_artifact['id'], sdk_artifact['size_in_bytes'], sdk_artifact['digest']) == (cfg['artifact_id'], cfg['artifact_bytes'], cfg['artifact_digest'])
assert sdk_artifact['workflow_run']['id'] == cfg['producer_run'] and sdk_artifact['workflow_run']['head_sha'] == cfg['sdk_head']
assert sha(small / 'producer.log') == cfg['producer_log_sha256']
data = load('results.json')
assert not data.get('errors') and (data['stats']['expected'], data['stats']['unexpected'], data['stats']['skipped'], data['stats']['flaky']) == (4, 0, 0, 0)
cases = []
def walk(suite):
    for spec in suite.get('specs', []):
        assert spec['file'].endswith('auth.spec.ts') and len(spec['tests']) == 1
        test = spec['tests'][0]
        assert test['status'] == 'expected' and len(test['results']) == 1
        result = test['results'][0]
        assert result['status'] == 'passed' and result['retry'] == 0 and not result.get('errors')
        assert len(result['attachments']) == 1 and result['attachments'][0]['name'] == 'auth-receipt'
        attachment = result['attachments'][0]
        if 'body' in attachment:
            receipt = json.loads(base64.b64decode(attachment['body'], validate=True))
        else:
            raise RuntimeError('Expected original inline safe receipt; no external path inference')
        assert set(receipt) == {'ok', 'phase', 'checks', 'observations', 'digests'} and receipt['ok'] is True and receipt['phase'] == 'complete'
        assert receipt['checks'] and all(value is True for value in receipt['checks'].values())
        assert set(receipt['observations']) == {'ordinaryAuthenticatedBeforeSync', 'futureAuthenticatedAfterSync', 'ordinary.postImportFreeAccepted', 'future.postImportFreeAccepted', 'full.postImportFreeAccepted'}
        assert all(type(value) is bool for value in receipt['observations'].values())
        assert set(receipt['digests']) == {'canonicalFull', 'expected', 'future', 'restoredFull'}
        assert all(isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value) for value in receipt['digests'].values())
        cases.append({'title': spec['title'], 'retry': 0, 'status': 'passed', 'receipt': receipt})
    for child in suite.get('suites', []):
        walk(child)
for suite in data['suites']:
    walk(suite)
assert len(cases) == 4 and len({case['title'] for case in cases}) == 4 and sorted(case['title'] for case in cases) == sorted(cfg['expected_case_titles'])
assert data['config']['workers'] == 2 and len(data['config']['projects']) == 1 and data['config']['projects'][0]['retries'] == 0
save('verified-result.json', {'consumer_workflow': os.environ['GITHUB_SHA'], 'original_run': cfg['original_run'], 'original_workflow': cfg['original_workflow'], 'original_conclusion': 'failure', 'browser_run_step': 'success', 'original_verify_step': 'failure', 'schema_correction': 'exact five declared boolean observations only', 'source': cfg['wallet_source'], 'source_tree': cfg['wallet_tree'], 'passed': 4, 'failed': 0, 'skipped': 0, 'flaky': 0, 'retry': 0, 'workers': data['config']['workers'], 'cases': cases, 'extracted_bytes': total, 'artifact_id': cfg['consumer_artifact_id'], 'artifact_digest': cfg['consumer_artifact_digest'], 'sdk_source': cfg['sdk_head'], 'dist_files': 42, 'original_files_sha256': {path.relative_to(small).as_posix(): sha(path) for path in sorted(small.rglob('*')) if path.is_file()}, 'scope': cfg['scope'], 'wallet_factory_protection': False, 'browser_rerun': False})
print('Verified four original retry0 results with exact five-key boolean observations; original CI remains failed.')
