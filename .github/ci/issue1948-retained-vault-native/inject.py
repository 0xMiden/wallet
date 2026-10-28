#!/usr/bin/env python3
"""CI-only artifact injection and explicit lock generation/frozen replay."""
import argparse
import copy
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('stage', choices=['bind', 'packages', 'inject', 'generate-lock', 'replay', 'identities', 'checks', 'receipt'])
parser.add_argument('--config', required=True)
args = parser.parse_args()
cfg = json.loads(Path(args.config).read_text())
root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
proof = root / 'proof'
proof.mkdir(exist_ok=True)
wallet = root / 'wallet'
replay = root / 'replay'
files = root / 'package-files'
targets = ['@miden-sdk/miden-sdk', '@miden-sdk/react', '@miden-sdk/vite-plugin']


def save(name, value):
    (proof / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def hash_stream(stream):
    h = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(block)
    return h.hexdigest()


def sha(path):
    with path.open('rb') as stream:
        return hash_stream(stream)


def run(argv, cwd=root, log=None, timeout=90):
    if log:
        with (proof / log).open('wb') as out:
            subprocess.run(argv, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, check=True, timeout=timeout)
        return ''
    return subprocess.check_output(argv, cwd=cwd, text=True, timeout=timeout).strip()


def api(endpoint, name, raw=False, timeout=90):
    argv = ['gh', 'api'] + (['--allow-escape-sequences'] if raw else [])
    argv.append('repos/0xMiden/wallet/' + endpoint)
    with (root / name).open('wb') as out, (proof / (Path(name).name + '.stderr.log')).open('wb') as errors:
        subprocess.run(argv, stdout=out, stderr=errors, timeout=timeout, check=True)


def snapshot(directory, prefix):
    for name in ['package.json', 'yarn.lock']:
        shutil.copyfile(directory / name, proof / (prefix + '-' + name))


def lock_blocks(text):
    result = {}
    current = None
    for line in text.splitlines(keepends=True):
        if line and not line[0].isspace() and not line.startswith('#') and line.rstrip().endswith(':'):
            current = line.rstrip()[:-1]
            if current in result:
                raise RuntimeError('Duplicate Yarn lock header')
            result[current] = ''
        elif current is not None:
            result[current] += line
    return result


def scoped(header):
    selectors = re.findall(r'"([^"\n]+)"|([^,\s]+)', header)
    names = [a or b for a, b in selectors]
    flags = [any(x.startswith(target + '@') for target in targets) for x in names]
    if any(flags) and not all(flags):
        raise RuntimeError('Ambiguous mixed target lock selector')
    return bool(flags) and all(flags)


def test_name_pattern(argv):
    patterns = []
    for index, value in enumerate(argv):
        if value == '--testNamePattern':
            if index + 1 >= len(argv) or argv[index + 1].startswith('--'):
                raise ValueError('Missing literal testNamePattern value')
            patterns.append(argv[index + 1])
        elif value.startswith('--testNamePattern='):
            patterns.append(value.split('=', 1)[1])
        elif value in ['-t', '--test-name-pattern'] or value.startswith(('-t=', '--test-name-pattern=')):
            raise ValueError('Use the explicit --testNamePattern spelling')
    if len(patterns) > 1 or (patterns and not patterns[0]):
        raise ValueError('Use exactly one nonempty literal testNamePattern')
    return patterns[0] if patterns else None


def package_records():
    return json.loads((proof / 'packages.json').read_text())


if args.stage == 'bind':
    controller = root / 'controller'
    if run(['git', 'rev-parse', 'HEAD'], controller) != os.environ['GITHUB_SHA']:
        raise RuntimeError('Workflow SHA mismatch')
    if run(['git', 'show', '-s', '--format=%P', 'HEAD'], controller).split() != [cfg['wallet_source']]:
        raise RuntimeError('Workflow sole parent mismatch')
    changes = run(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], controller).splitlines()
    if sorted(changes) != sorted(cfg['proof_paths']):
        raise RuntimeError('Unexpected proof source changes')
    if run(['git', 'rev-parse', 'HEAD'], wallet) != cfg['wallet_source'] or run(['git', 'rev-parse', 'HEAD^{tree}'], wallet) != cfg['wallet_tree']:
        raise RuntimeError('Frozen wallet source/tree mismatch')
    if (wallet / 'node_modules').exists():
        raise RuntimeError('Wallet dependency tree must begin fresh')
    snapshot(wallet, 'original')
    save('source.json', {'wallet_source': cfg['wallet_source'], 'wallet_tree': cfg['wallet_tree'], 'workflow': os.environ['GITHUB_SHA']})
elif args.stage == 'packages':
    api('actions/runs/40451498209', 'proof/package-run.json')
    api('actions/artifacts/12710677349', 'proof/package-artifact.json')
    metadata = json.loads((proof / 'package-artifact.json').read_text())
    producer = json.loads((proof / 'package-run.json').read_text())
    expected = '2883ec087286632ef0062df6f8ad9f9d5f5179d6'
    digest = 'sha256:a2375a3a1d7a16d2b691b01a294ed176a12442f4d76f65f424de8fb07f5bc1af'
    if (producer['head_sha'] != expected or producer['conclusion'] != 'success' or producer['run_attempt'] != 1
            or metadata['id'] != 12710677349 or metadata['name'] != 'sdk-package-preparation-fd524-40451498209-1' or metadata['workflow_run']['id'] != 40451498209
            or metadata['workflow_run']['head_sha'] != expected or metadata['expired']
            or metadata['size_in_bytes'] != 295983883 or metadata['digest'] != digest):
        raise RuntimeError('Package artifact run/source/metadata mismatch')
    api('actions/artifacts/12710677349/zip', 'package-preparation.zip', raw=True, timeout=360)
    archive = root / 'package-preparation.zip'
    if archive.stat().st_size != 295983883 or 'sha256:' + sha(archive) != digest:
        raise RuntimeError('Package artifact ZIP mismatch')
    files.mkdir(exist_ok=False)
    with zipfile.ZipFile(archive) as z:
        seen = set()
        small = {}
        total = 0
        for entry in z.infolist():
            path = PurePosixPath(entry.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename or ':' in entry.filename
                    or stat.S_ISLNK(entry.external_attr >> 16) or path.as_posix() in seen):
                raise RuntimeError('Unsafe/duplicate artifact path')
            seen.add(path.as_posix())
            if len(path.parts) == 2 and path.parts[0] == 'proof' and path.suffix not in ['.zip', '.tgz', '.wasm'] and not entry.is_dir():
                total += entry.file_size
                if total > 20 * 1024**2:
                    raise RuntimeError('Receipt output exceeds20MiB')
                small[path.name] = z.read(entry)
        for name in ['assembly-result.json', 'source-bindings.json', 'producer-receipt.json', 'packages.json', 'dist-before.json']:
            if name not in small:
                raise RuntimeError('Missing assembly receipt')
        result = json.loads(small['assembly-result.json'])
        bindings = json.loads(small['source-bindings.json'])
        native = json.loads(small['producer-receipt.json'])
        sdk = {'sha': 'fd52477d7c7d5d475dc14987ebbd7a36dbb703da', 'tree': '0d4504105c5ba62f9ab439cfc19cf3ee503277a5'}
        if (result['protected_acceptance'] is not False or result['status'] != 'package-preparation-only'
                or result['sdk_head'] != sdk['sha'] or result['artifact_id'] != 12709639500
                or bindings['workflow'] != expected or bindings['sdk'] != sdk
                or bindings['wallet'] != {'sha': '52d576ce799e40c2734fb6d918e54185637c982c', 'tree': 'bef16e437bdf8bad033e40fbeb64f2a505e4f532'}
                or native['sdk_head'] != sdk['sha'] or native['artifact_id'] != 12709639500):
            raise RuntimeError('Assembly source/protection receipt mismatch')
        for name, value in result['evidence_sha256'].items():
            if name not in small or hashlib.sha256(small[name]).hexdigest() != value:
                raise RuntimeError('Assembly evidence hash mismatch')
        records = json.loads(small['packages.json'])
        if len(records) != 3 or {p['name'] for p in records} != set(targets):
            raise RuntimeError('Expected exactly the three SDK packages')
        for record in records:
            filename = record['filename']
            if not re.fullmatch(r'[A-Za-z0-9._-]+\.tgz', filename):
                raise RuntimeError('Unsafe tarball filename')
            entry = z.getinfo('packages/' + filename)
            if entry.file_size != record['bytes'] or entry.file_size > 200 * 1024**2:
                raise RuntimeError('Package size mismatch')
            path = files / filename
            with z.open(entry) as source, path.open('wb') as destination:
                shutil.copyfileobj(source, destination, 1024 * 1024)
            if sha(path) != record['sha256'] or record['sha256'] != cfg['package_sha256'][record['name']]:
                raise RuntimeError('Package hash mismatch')
            payload = {}
            total = 0
            with tarfile.open(path, 'r:gz') as tar:
                for member in tar.getmembers():
                    relative = PurePosixPath(member.name)
                    if (relative.is_absolute() or '..' in relative.parts or not relative.parts or relative.parts[0] != 'package'
                            or member.issym() or member.islnk() or '\\' in member.name):
                        raise RuntimeError('Unsafe package member')
                    total += member.size
                    if total > 2 * 1024**3:
                        raise RuntimeError('Package payload exceeds bounded size')
                    if member.isfile():
                        name = relative.relative_to('package').as_posix()
                        if name in payload:
                            raise RuntimeError('Duplicate package file')
                        payload[name] = hash_stream(tar.extractfile(member))
                manifest = json.load(tar.extractfile('package/package.json'))
                if manifest['name'] != record['name'] or manifest['version'] != record['version']:
                    raise RuntimeError('Package manifest mismatch')
            record['declared_dependencies'] = manifest.get('dependencies', {})
            record['payload_sha256'] = payload
            record['spec'] = 'file:' + str(path)
        save('packages.json', records)
        for name, value in small.items():
            (proof / ('assembly-' + name)).write_bytes(value)
elif args.stage == 'inject':
    package = json.loads((wallet / 'package.json').read_text())
    original = copy.deepcopy(package)
    specs = {p['name']: p['spec'] for p in package_records()}
    for name in targets:
        count = 0
        for section in ['dependencies', 'devDependencies', 'optionalDependencies']:
            if name in package.get(section, {}):
                package[section][name] = specs[name]
                count += 1
        if count == 0:
            raise RuntimeError('Target absent in frozen wallet: ' + name)
    resolutions = package.setdefault('resolutions', {})
    for key in list(resolutions):
        for name in targets:
            if key == name or key.endswith('/' + name):
                resolutions[key] = specs[name]
    for name in targets:
        resolutions[name] = specs[name]
    resolutions['**/@miden-sdk/miden-sdk'] = specs['@miden-sdk/miden-sdk']
    if resolutions.get('dexie') != original.get('resolutions', {}).get('dexie'):
        raise RuntimeError('Dexie resolution changed')
    (wallet / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    snapshot(wallet, 'injected-before-install')
    save('injection.json', {'targets': specs, 'unrelated_manifest_fields': 'preserved', 'original_frozen_lock_claim': False})
elif args.stage == 'generate-lock':
    if run(['yarn', '--version'], wallet) != '1.22.22':
        raise RuntimeError('Expected Yarn1.22.22')
    run(['yarn', 'install', '--non-interactive', '--network-timeout', '120000'], wallet, 'lock-generation-install.log', 600)
    snapshot(wallet, 'effective')
    before = (proof / 'original-yarn.lock').read_text()
    after = (wallet / 'yarn.lock').read_text()
    old = {k: v for k, v in lock_blocks(before).items() if not scoped(k)}
    new = {k: v for k, v in lock_blocks(after).items() if not scoped(k)}
    (proof / 'yarn.lock.diff').write_text(''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='original', tofile='effective')))
    original = (proof / 'original-package.json').read_text()
    effective = (wallet / 'package.json').read_text()
    (proof / 'package.json.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), effective.splitlines(True), fromfile='original', tofile='effective')))
    changes = []
    approvals = cfg.get('approved_target_lock_changes', {})
    for header in sorted(set(old) | set(new)):
        if old.get(header) == new.get(header):
            continue
        change = {'header': header,
                  'before_sha256': hashlib.sha256(old[header].encode()).hexdigest() if header in old else None,
                  'after_sha256': hashlib.sha256(new[header].encode()).hexdigest() if header in new else None}
        approval = approvals.get(header)
        if (approval is None or not approval.get('reason') or approval.get('owner') not in targets
                or approval.get('before_sha256') != change['before_sha256']
                or approval.get('after_sha256') != change['after_sha256']):
            save('unapproved-lock-changes.json', changes + [change])
            raise RuntimeError('Unapproved target-transitive or unrelated lock drift; inspect exact retained diff')
        changes.append({**change, 'owner': approval['owner'], 'reason': approval['reason']})
    save('approved-target-transitive-lock-changes.json', changes)
    if (wallet / 'package.json').read_bytes() != (proof / 'injected-before-install-package.json').read_bytes():
        raise RuntimeError('Install altered the injected manifest')
    save('effective-lock.json', {'package_sha256': sha(wallet / 'package.json'), 'lock_sha256': sha(wallet / 'yarn.lock'), 'generation_attempts': 1})
elif args.stage == 'replay':
    if replay.exists():
        raise RuntimeError('Replay tree must not exist')
    run(['git', 'clone', '--no-hardlinks', '--no-checkout', str(wallet), str(replay)], log='replay-clone.log')
    run(['git', 'checkout', '--detach', cfg['wallet_source']], replay, 'replay-checkout.log')
    shutil.copyfile(proof / 'effective-package.json', replay / 'package.json')
    shutil.copyfile(proof / 'effective-yarn.lock', replay / 'yarn.lock')
    if (replay / 'node_modules').exists():
        raise RuntimeError('Replay dependency tree was not fresh')
    run(['yarn', 'install', '--frozen-lockfile', '--non-interactive', '--network-timeout', '120000'], replay, 'frozen-replay-install.log', 600)
    receipt = json.loads((proof / 'effective-lock.json').read_text())
    if sha(replay / 'yarn.lock') != receipt['lock_sha256'] or sha(replay / 'package.json') != receipt['package_sha256']:
        raise RuntimeError('Frozen replay mutated effective manifest/lock')
    save('frozen-replay.json', {**receipt, 'fresh_dependency_tree': True, 'source': cfg['wallet_source'], 'original_lock_frozen': False})
elif args.stage == 'identities':
    identities = []
    for record in package_records():
        directory = replay / 'node_modules' / record['name']
        manifest = json.loads((directory / 'package.json').read_text())
        if manifest['name'] != record['name'] or manifest['version'] != record['version']:
            raise RuntimeError('Installed package identity mismatch')
        for relative, expected in record['payload_sha256'].items():
            if sha(directory / relative) != expected:
                raise RuntimeError('Installed payload differs from verified tarball: ' + record['name'] + '/' + relative)
        identities.append({'name': record['name'], 'version': manifest['version'], 'tarball_sha256': record['sha256'], 'payload_matches': True})
    copies = []
    for directory, children, names in os.walk(replay / 'node_modules', followlinks=False):
        if Path(directory).name == 'miden-sdk' and Path(directory).parent.name == '@miden-sdk' and 'package.json' in names:
            copies.append(str(Path(directory).resolve().relative_to(replay)))
    if copies != ['node_modules/@miden-sdk/miden-sdk']:
        raise RuntimeError('Unexpected nested SDK copy; inspect actual dependency composition')
    save('installed-identities.json', {'packages': identities, 'sdk_directories': copies, 'runtime_singleton_proven': False, 'runtime_asset_closure_proven': False})
elif args.stage == 'checks':
    results = []
    for check in cfg['checks']:
        argv = check['argv']
        log = 'check-' + check['name'] + '.log'
        try:
            run(argv, replay, log, check['timeout_seconds'])
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            failure = {'name': check['name'], 'kind': check['kind'], 'argv': argv,
                       'status': 'failed', 'error_class': type(error).__name__,
                       'exit': getattr(error, 'returncode', None),
                       'timeout_seconds': check['timeout_seconds'], 'log': log,
                       'results_json_present': False, 'results_json_retained': False}
            if check['kind'] == 'test':
                path = replay / check['results_json']
                destination = 'check-' + check['name'] + '-results.json'
                try:
                    failure['results_json_present'] = path.is_file()
                    if failure['results_json_present']:
                        shutil.copyfile(path, proof / destination)
                        failure['results_json_retained'] = True
                        failure['results_json'] = destination
                except OSError as retention_error:
                    failure['results_retention_error'] = type(retention_error).__name__
            try:
                save('check-' + check['name'] + '-failure.json', failure)
            except OSError:
                print('Could not retain named failure status; preserving original command failure')
            raise
        item = {'name': check['name'], 'argv': argv, 'exit': 0}
        if check['kind'] == 'test':
            path = replay / check['results_json']
            data = json.loads(path.read_text())
            passed, failed = data['numPassedTests'], data['numFailedTests']
            pending, runtime = data['numPendingTests'], data['numRuntimeErrorTestSuites']
            item['counts'] = {k: data.get(k) for k in ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numRuntimeErrorTestSuites']}
            shutil.copyfile(path, proof / ('check-' + check['name'] + '-results.json'))
            pattern = test_name_pattern(argv)
            if pattern is not None:
                if (type(check.get('expected_count')) is not int or check['expected_count'] < 1
                        or type(check.get('expected_filtered')) is not int or check['expected_filtered'] < 0):
                    raise RuntimeError('Filtered checks require explicit positive executed and nonnegative filtered counts')
                # Jest-circus constructs RegExp(testNamePattern, 'i'). Use that JS engine/flag,
                # rather than translating its syntax into a different regex implementation.
                selector = r'''const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const pattern = new RegExp(process.argv[2], 'i');
const assertions = data.testResults.flatMap(suite => suite.assertionResults);
const matches = assertions.filter(assertion => {
  if (typeof assertion.fullName !== 'string') throw new Error('Missing assertion fullName');
  return pattern.test(assertion.fullName);
});
process.stdout.write(JSON.stringify({pattern: process.argv[2], flags: 'i',
  matched: matches.length,
  notPassed: matches.filter(assertion => assertion.status !== 'passed')
    .map(assertion => ({fullName: assertion.fullName, status: assertion.status}))}));'''
                selected = json.loads(run(['node', '-e', selector, str(path), pattern], timeout=30))
                save('check-' + check['name'] + '-selection.json', selected)
                if selected['matched'] != check['expected_count'] or selected['notPassed']:
                    raise RuntimeError('A regex-matching assertion was missing or not passed')
                if passed + failed != check['expected_count'] or pending != check['expected_filtered']:
                    raise RuntimeError('Filtered executed or pending count mismatch')
            elif pending != 0:
                raise RuntimeError('Unfiltered regression has pending assertions')
            if passed < 1 or failed != 0 or runtime != 0:
                raise RuntimeError('Named regression scope failed, empty or has runtime errors')
            if check.get('expected_count') is not None and passed + failed != check['expected_count']:
                raise RuntimeError('Named executed test count mismatch')
        results.append(item)
    save('named-checks.json', results)
elif args.stage == 'receipt':
    required = ['source.json', 'packages.json', 'injection.json', 'effective-lock.json', 'frozen-replay.json', 'installed-identities.json', 'named-checks.json']
    save('result.json', {'scope': 'Exact artifact injection and effective-lock replay plus explicit named checks only',
         'wallet_source': cfg['wallet_source'], 'sdk_source': 'fd52477d7c7d5d475dc14987ebbd7a36dbb703da',
         'protected_wallet_sdk_acceptance': False, 'runtime_singleton_proven': False, 'runtime_asset_closure_proven': False,
         'producer_effective_lock_hash': None, 'evidence': {name: sha(proof / name) for name in required}})
print('Completed injection stage: ' + args.stage)
