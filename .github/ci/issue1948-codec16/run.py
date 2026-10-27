#!/usr/bin/env python3
"""CI-only exact source/native codec16 browser proof. No SDK or wallet application build."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('stage', choices=['bind', 'metadata', 'restore', 'install', 'browser-install', 'run', 'verify', 'preserve'])
args = parser.parse_args()
if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Disposable CI execution only')
root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
controller = root / 'controller'
wallet = root / 'wallet'
payload = controller / '.github/ci/issue1948-codec16'
cfg = json.loads((payload / 'inputs.json').read_text())
proof = root / 'proof'
proof.mkdir(exist_ok=True)
fixture = wallet / 'playwright/proofs/storage-recovery-codec'
dist = root / 'sdk-dist'
if len(cfg['wallet_source']) != 40 or any(c not in '0123456789abcdef' for c in cfg['wallet_source']):
    raise SystemExit('Controller must supply exact immutable wallet SHA before execution')


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
    directory = dist
    return {p.relative_to(directory).as_posix(): sha(p) for p in sorted(directory.rglob('*')) if p.is_file()}


def verify_preserved():
    for name, expected in cfg['fixture_files'].items():
        if sha(wallet / name) != expected:
            raise RuntimeError('Frozen codec fixture hash changed: ' + name)
    actual = dist_hashes()
    if actual != cfg['dist_sha256'] or len(actual) != 42:
        raise RuntimeError('Original42 SDK dist files changed or closure differs')
    original = json.loads((proof / 'wallet-manifest-lock-before.json').read_text())
    if original != {p: sha(wallet / p) for p in ['package.json', 'yarn.lock']}:
        raise RuntimeError('Frozen wallet manifest/lock changed')
    save('dist-after.json', actual)
    save('preserved-source.json', {'fixture_files': cfg['fixture_files'], 'dist_files': len(actual), 'wallet_lock_unchanged': True})


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
    if (wallet / 'node_modules').exists() or dist.exists():
        raise RuntimeError('Fresh dependency/dist directories required')
    for name, expected in cfg['fixture_files'].items():
        if sha(wallet / name) != expected:
            raise RuntimeError('Source-bound codec file mismatch: ' + name)
    declared = json.loads((fixture / 'inputs.json').read_text())
    if declared['dist_sha256'] != cfg['dist_sha256']:
        raise RuntimeError('Fixture SDK asset manifest differs')
    save('source-bindings.json', {'workflow_sha': os.environ['GITHUB_SHA'], 'wallet_source': cfg['wallet_source'],
         'wallet_tree': cfg['wallet_tree'], 'sdk_source': cfg['sdk_head'], 'sdk_tree': cfg['sdk_tree'],
         'fixture_files': cfg['fixture_files'], 'scope': cfg['scope']})
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
    target = dist
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
        command(['yarn', 'playwright', 'test', '--config', 'playwright/proofs/storage-recovery-codec/playwright.config.ts', '--project=chromium',
                 '--workers=2', '--retries=0'], wallet, 'browser-tests.log', 840)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        save('run-failure.json', {'status': 'failed', 'error_class': type(error).__name__,
             'exit': getattr(error, 'returncode', None), 'result_json_present': (proof / 'results.json').is_file()})
        raise
    finally:
        verify_preserved()
elif args.stage == 'preserve':
    verify_preserved()
elif args.stage == 'verify':
    verify_preserved()
    data = json.loads((proof / 'results.json').read_text())
    if data.get('errors'):
        raise RuntimeError('Unexpected runner/runtime errors')
    stats = data['stats']
    if (stats['expected'] != 16 or stats['unexpected'] != 0 or stats['skipped'] != 0 or stats['flaky'] != 0):
        raise RuntimeError('Require16 passed with zero unexpected/skipped/flaky')
    cases = []
    def walk(suite):
        for spec in suite.get('specs', []):
            if not spec.get('file', '').endswith('codec.spec.ts') or len(spec['tests']) != 1:
                raise RuntimeError('Unexpected test file/project selection')
            case = spec['tests'][0]
            results = case['results']
            if (case['status'] != 'expected' or len(results) != 1 or results[0]['status'] != 'passed'
                    or results[0]['retry'] != 0 or results[0].get('errors')):
                raise RuntimeError('Every original case must pass in one retry0 result')
            attachments = results[0].get('attachments', [])
            if len(attachments) != 1 or attachments[0].get('name') != 'codec-receipt':
                raise RuntimeError('Exactly one safe codec receipt required')
            attachment = attachments[0]
            if 'body' in attachment:
                receipt = json.loads(base64.b64decode(attachment['body'], validate=True))
            else:
                path = Path(attachment['path']).resolve()
                if not path.is_relative_to(proof.resolve()):
                    raise RuntimeError('Receipt outside owned proof directory')
                receipt = json.loads(path.read_text())
            if (set(receipt) != {'ok', 'phase', 'checks', 'digests'} or receipt['ok'] is not True
                    or receipt['phase'] != 'complete' or not receipt['checks']
                    or not all(value is True for value in receipt['checks'].values())):
                raise RuntimeError('Codec receipt checks failed or unsafe shape')
            for digest in receipt['digests']:
                if (set(digest) != {'control', 'incoming', 'prepared', 'candidate', 'receipt'}
                        or digest['control'] not in ['expected', 'committed', 'id', 'hint']
                        or any(not isinstance(value, str) or len(value) != 64
                               or any(c not in '0123456789abcdef' for c in value)
                               for key, value in digest.items() if key != 'control')):
                    raise RuntimeError('Unsafe codec digest receipt')
            cases.append({'title': spec['title'], 'status': 'passed', 'retry': 0,
                          'duration_ms': results[0]['duration'], 'receipt': receipt})
        for child in suite.get('suites', []):
            walk(child)
    for suite in data['suites']:
        walk(suite)
    if sorted(case['title'] for case in cases) != sorted(cfg['expected_case_titles']):
        raise RuntimeError('Exact16 codec test titles must execute once')
    save('verified-result.json', {'status': 'codec16-retries0-only', 'passed': 16, 'failed': 0, 'skipped': 0,
         'cases': cases, 'wallet_source': cfg['wallet_source'], 'sdk_source': cfg['sdk_head'],
         'artifact_id': cfg['artifact_id'], 'dist_files': 42, 'fixture_files': cfg['fixture_files'],
         'wallet_factory_protection': False, 'runtime_wallet_acceptance': False,
         'producer_effective_lock_hash': None})
print('Completed SDK codec browser stage: ' + args.stage)
