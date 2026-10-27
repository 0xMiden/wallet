#!/usr/bin/env python3
"""CI-only exact source/raw SDK24 browser proof. No SDK or wallet application build."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('stage', choices=['bind', 'metadata', 'restore', 'install', 'browser-install', 'run', 'verify'])
args = parser.parse_args()
if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Disposable CI execution only')
root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
controller = root / 'controller'
wallet = root / 'wallet'
payload = controller / '.github/ci/issue1948-sdk-browser'
cfg = json.loads((payload / 'inputs.json').read_text())
proof = root / 'proof'
proof.mkdir(exist_ok=True)
fixture = wallet / 'proof-sdk24'


def save(name, value):
    (proof / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def command(argv, cwd=root, log=None, timeout=90):
    if log:
        with (proof / log).open('wb') as output:
            subprocess.run(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=timeout, check=True)
        return ''
    return subprocess.check_output(argv, cwd=cwd, text=True, timeout=timeout).strip()


def api(endpoint, destination, raw=False, timeout=90):
    argv = ['gh', 'api'] + (['--allow-escape-sequences'] if raw else [])
    argv.append('repos/0xMiden/web-sdk/' + endpoint)
    with (proof / destination).open('wb') as out, (proof / (destination + '.stderr.log')).open('wb') as errors:
        subprocess.run(argv, stdout=out, stderr=errors, timeout=timeout, check=True)
    if not raw:
        return json.loads((proof / destination).read_text())


def dist_hashes():
    directory = fixture / 'dist'
    return {p.relative_to(directory).as_posix(): sha(p) for p in sorted(directory.rglob('*')) if p.is_file()}


def verify_preserved():
    if sha(fixture / 'test/indexeddb_safety.browser.test.ts') != cfg['test_sha256']:
        raise RuntimeError('Original SDK test source changed')
    if sha(fixture / 'package.json') != cfg['fixture_module_package_sha256'] or sha(fixture / 'playwright.config.ts') != cfg['fixture_config_sha256']:
        raise RuntimeError('Dedicated ESM scope/config changed')
    actual = dist_hashes()
    if actual != cfg['dist_sha256'] or len(actual) != 42:
        raise RuntimeError('Original42 SDK dist files changed or closure differs')
    original = json.loads((proof / 'wallet-manifest-lock-before.json').read_text())
    if original != {p: sha(wallet / p) for p in ['package.json', 'yarn.lock']}:
        raise RuntimeError('Frozen wallet manifest/lock changed')
    save('dist-after.json', actual)
    save('preserved-source.json', {'test_sha256': cfg['test_sha256'], 'dist_files': len(actual), 'wallet_lock_unchanged': True})


if args.stage == 'bind':
    if command(['git', 'rev-parse', 'HEAD'], controller) != os.environ['GITHUB_SHA']:
        raise RuntimeError('Workflow checkout mismatch')
    if command(['git', 'show', '-s', '--format=%P', 'HEAD'], controller).split() != [cfg['wallet_source']]:
        raise RuntimeError('Workflow sole-parent binding mismatch')
    paths = command(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], controller).splitlines()
    if sorted(paths) != sorted(cfg['proof_paths']):
        raise RuntimeError('Unexpected source changes in proof commit')
    if (command(['git', 'rev-parse', 'HEAD'], wallet) != cfg['wallet_source']
            or command(['git', 'rev-parse', 'HEAD^{tree}'], wallet) != cfg['wallet_tree']):
        raise RuntimeError('Frozen wallet SHA/tree mismatch')
    if (wallet / 'node_modules').exists() or fixture.exists():
        raise RuntimeError('Fresh dependency/fixture directories required')
    if sha(payload / 'test/indexeddb_safety.browser.test.ts') != cfg['test_sha256']:
        raise RuntimeError('SDK source copy hash mismatch')
    (fixture / 'test').mkdir(parents=True)
    shutil.copyfile(payload / 'test/indexeddb_safety.browser.test.ts', fixture / 'test/indexeddb_safety.browser.test.ts')
    shutil.copyfile(payload / 'playwright.config.ts', fixture / 'playwright.config.ts')
    shutil.copyfile(payload / 'package.json', fixture / 'package.json')
    save('source-bindings.json', {'workflow_sha': os.environ['GITHUB_SHA'], 'wallet_source': cfg['wallet_source'],
         'wallet_tree': cfg['wallet_tree'], 'sdk_source': cfg['sdk_head'], 'sdk_tree': cfg['sdk_tree'],
         'test_sha256': cfg['test_sha256'], 'scope': cfg['scope']})
    save('wallet-manifest-lock-before.json', {p: sha(wallet / p) for p in ['package.json', 'yarn.lock']})
elif args.stage == 'metadata':
    sdk_run = api('actions/runs/' + str(cfg['producer_run']), 'sdk-run.json')
    artifact = api('actions/artifacts/' + str(cfg['artifact_id']), 'sdk-artifact.json')
    job = api('actions/jobs/' + str(cfg['producer_job_id']), 'producer-job.json')
    commit = api('git/commits/' + cfg['producer_checkout'], 'producer-commit.json')
    head = api('git/commits/' + cfg['sdk_head'], 'sdk-head.json')
    if (sdk_run['head_sha'] != cfg['sdk_head'] or sdk_run['conclusion'] != 'success'
            or sdk_run['run_attempt'] != cfg['producer_attempt'] or job['run_id'] != cfg['producer_run']
            or job['run_attempt'] != cfg['producer_attempt'] or job['conclusion'] != 'success'):
        raise RuntimeError('Successful SDK run/producer/attempt mismatch')
    if (commit['sha'] != cfg['producer_checkout'] or commit['tree']['sha'] != cfg['sdk_tree']
            or head['sha'] != cfg['sdk_head'] or head['tree']['sha'] != cfg['sdk_tree']
            or [p['sha'] for p in commit['parents']] != cfg['producer_parents']):
        raise RuntimeError('SDK head/actual producer tree binding mismatch')
    if (artifact['id'] != cfg['artifact_id'] or artifact['name'] != 'web-client-artifacts' or artifact['expired']
            or artifact['size_in_bytes'] != cfg['artifact_bytes'] or artifact['digest'] != cfg['artifact_digest']
            or artifact['workflow_run']['id'] != cfg['producer_run']
            or artifact['workflow_run']['head_sha'] != cfg['sdk_head']):
        raise RuntimeError('Exact SDK artifact identity mismatch')
    api('actions/jobs/' + str(cfg['producer_job_id']) + '/logs', 'producer.log', raw=True)
    if sha(proof / 'producer.log') != cfg['producer_log_sha256']:
        raise RuntimeError('Fresh producer/cache/profile receipt log differs')
    save('producer-receipt.json', cfg)
elif args.stage == 'restore':
    api('actions/artifacts/' + str(cfg['artifact_id']) + '/zip', 'sdk-dist.zip', raw=True, timeout=360)
    archive = proof / 'sdk-dist.zip'
    if archive.stat().st_size != cfg['artifact_bytes'] or 'sha256:' + sha(archive) != cfg['artifact_digest']:
        raise RuntimeError('Raw SDK ZIP size/digest mismatch')
    target = fixture / 'dist'
    if target.exists():
        raise RuntimeError('Refuse to overlay SDK dist')
    entries = []
    names = set()
    total = 0
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            path = PurePosixPath(item.filename)
            normalized = path.as_posix().rstrip('/')
            if (path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename
                    or not path.parts or path.parts[0] not in ['st', 'mt']
                    or stat.S_ISLNK(item.external_attr >> 16) or normalized in names):
                raise RuntimeError('Unsafe SDK ZIP path')
            names.add(normalized)
            if not item.is_dir():
                if normalized not in cfg['dist_sha256']:
                    raise RuntimeError('SDK ZIP file absent from accepted42-file manifest')
                total += item.file_size
                if total > 2 * 1024**3:
                    raise RuntimeError('Bounded SDK ZIP extraction size exceeded')
                entries.append(item)
        if {item.filename for item in entries} != set(cfg['dist_sha256']):
            raise RuntimeError('SDK ZIP differs from exact accepted dist closure')
        target.mkdir()
        for item in entries:
            path = target / item.filename
            path.parent.mkdir(parents=True, exist_ok=True)
            with z.open(item) as source, path.open('wb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
    if dist_hashes() != cfg['dist_sha256']:
        raise RuntimeError('All42 SDK dist file hashes must match accepted assembly manifest')
    save('dist-before.json', dist_hashes())
    verify_preserved()
elif args.stage == 'install':
    if command(['yarn', '--version'], wallet) != '1.22.22':
        raise RuntimeError('Expected frozen wallet Yarn1.22.22 runner')
    command(['yarn', 'install', '--frozen-lockfile', '--non-interactive', '--network-timeout', '120000'],
            wallet, 'wallet-runner-install.log', 360)
    verify_preserved()
    save('runner-versions.json', {'node': command(['node', '--version']), 'yarn': command(['yarn', '--version'], wallet),
         'playwright': command(['yarn', '--silent', 'playwright', '--version'], wallet),
         'note': 'Wallet dependencies supply runner only; served SDK is verified fd artifact'})
elif args.stage == 'browser-install':
    command(['yarn', 'playwright', 'install', '--with-deps', 'chromium'], wallet, 'chromium-install.log', 240)
    verify_preserved()
elif args.stage == 'run':
    try:
        command(['yarn', 'playwright', 'test', '--config', 'proof-sdk24/playwright.config.ts', '--project=chromium',
                 '--workers=2', '--retries=0'], wallet, 'browser-tests.log', 840)
    finally:
        verify_preserved()
elif args.stage == 'verify':
    verify_preserved()
    data = json.loads((proof / 'results.json').read_text())
    if data.get('errors'):
        raise RuntimeError('Unexpected runner/runtime errors')
    stats = data['stats']
    if (stats['expected'] != 24 or stats['unexpected'] != 0 or stats['skipped'] != 0 or stats['flaky'] != 0):
        raise RuntimeError('Require24 passed with zero unexpected/skipped/flaky')
    cases = []
    def walk(suite):
        for spec in suite.get('specs', []):
            if not spec.get('file', '').endswith('indexeddb_safety.browser.test.ts') or len(spec['tests']) != 1:
                raise RuntimeError('Unexpected test file/project selection')
            case = spec['tests'][0]
            results = case['results']
            if (case['status'] != 'expected' or len(results) != 1 or results[0]['status'] != 'passed'
                    or results[0]['retry'] != 0 or results[0].get('errors')):
                raise RuntimeError('Every original case must pass in one retry0 result')
            cases.append({'title': spec['title'], 'status': 'passed', 'retry': 0, 'duration_ms': results[0]['duration']})
        for child in suite.get('suites', []):
            walk(child)
    for suite in data['suites']:
        walk(suite)
    if sorted(case['title'] for case in cases) != cfg['expected_case_titles']:
        raise RuntimeError('Exact original24 test titles must execute once')
    save('verified-result.json', {'status': 'raw-sdk24-retries0-only', 'passed': 24, 'failed': 0, 'skipped': 0,
         'cases': cases, 'wallet_source': cfg['wallet_source'], 'sdk_source': cfg['sdk_head'],
         'artifact_id': cfg['artifact_id'], 'dist_files': 42, 'test_sha256': cfg['test_sha256'],
         'wallet_factory_protection': False, 'runtime_wallet_acceptance': False,
         'producer_effective_lock_hash': None})
print('Completed raw SDK browser stage: ' + args.stage)
