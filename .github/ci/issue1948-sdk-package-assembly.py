#!/usr/bin/env python3
"""Bounded CI package preparation. No wallet install, runtime proof or publication."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('stage', choices=['bind', 'metadata', 'restore', 'install', 'build', 'pack', 'receipt'])
parser.add_argument('--config', required=True)
args = parser.parse_args()
config = json.loads(Path(args.config).read_text())
workspace = Path(os.environ['GITHUB_WORKSPACE']).resolve()
proof = workspace / 'proof'
proof.mkdir(exist_ok=True)
sdk = workspace / 'sdk'
packages = workspace / 'packages'
packages.mkdir(exist_ok=True)


def save(name, value):
    (proof / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def command(argv, cwd=workspace, timeout=120, output=None):
    if output:
        with (proof / output).open('wb') as stream:
            if output.endswith('.json'):
                with (proof / (output + '.stderr.log')).open('wb') as errors:
                    subprocess.run(argv, cwd=cwd, stdout=stream, stderr=errors, check=True, timeout=timeout)
            else:
                subprocess.run(argv, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=timeout)
        return ''
    return subprocess.check_output(argv, cwd=cwd, text=True, timeout=timeout).strip()


def api(endpoint, name):
    command(['gh', 'api', 'repos/0xMiden/web-sdk/' + endpoint], output=name)
    return json.loads((proof / name).read_text())


def lock_manifest():
    paths = ['Cargo.toml', 'Cargo.lock', 'pnpm-lock.yaml', 'package.json',
             'crates/web-client/package.json', 'crates/web-client/rollup.config.js',
             'packages/react-sdk/package.json', 'packages/vite-plugin/package.json']
    return {path: digest(sdk / path) for path in paths}


def dist_manifest():
    root = sdk / 'crates/web-client/dist'
    return {p.relative_to(root).as_posix(): digest(p) for p in sorted(root.rglob('*')) if p.is_file()}


def require_exports(root):
    package = json.loads((root / 'package.json').read_text())
    found = []

    def walk(value):
        if isinstance(value, dict):
            for child in value.values():
                walk(child)
        elif isinstance(value, str) and value.startswith('./'):
            target = root / value[2:]
            if not target.is_file():
                raise RuntimeError('Missing package export: ' + str(target.relative_to(workspace)))
            found.append(value)
    walk(package['exports'])
    return {'name': package['name'], 'version': package['version'], 'exports': found}


if args.stage == 'bind':
    controller = workspace / 'controller'
    actual = command(['git', 'rev-parse', 'HEAD'], controller)
    if actual != os.environ['GITHUB_SHA']:
        raise RuntimeError('Workflow checkout mismatch')
    if command(['git', 'rev-parse', 'HEAD^'], controller) != config['wallet_source']:
        raise RuntimeError('Workflow parent is not frozen source')
    changed = command(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], controller).splitlines()
    if sorted(changed) != sorted(config['proof_paths']):
        raise RuntimeError('Workflow commit includes changes outside exact proof files')
    observed = {}
    for name, root, sha, tree in [('wallet', workspace / 'wallet', config['wallet_source'], config['wallet_tree']),
                                   ('sdk', sdk, config['sdk_head'], config['sdk_tree'])]:
        head = command(['git', 'rev-parse', 'HEAD'], root)
        actual_tree = command(['git', 'rev-parse', 'HEAD^{tree}'], root)
        if head != sha or actual_tree != tree:
            raise RuntimeError(name + ' checkout mismatch')
        observed[name] = {'sha': head, 'tree': actual_tree}
    observed['workflow'] = actual
    save('source-bindings.json', observed)
    save('consumer-lock-before.json', lock_manifest())
    (proof / 'consumer-Cargo.lock').write_bytes((sdk / 'Cargo.lock').read_bytes())
    (proof / 'consumer-pnpm-lock.yaml').write_bytes((sdk / 'pnpm-lock.yaml').read_bytes())
elif args.stage == 'metadata':
    run = api('actions/runs/' + str(config['producer_run']), 'sdk-run.json')
    artifact = api('actions/artifacts/' + str(config['artifact_id']), 'sdk-artifact.json')
    job = api('actions/jobs/' + str(config['producer_job_id']), 'sdk-producer-job.json')
    commit = api('git/commits/' + config['producer_checkout'], 'sdk-producer-commit.json')
    if run['head_sha'] != config['sdk_head'] or job['run_id'] != config['producer_run'] or job['conclusion'] != 'success':
        raise RuntimeError('Producer run/job binding mismatch')
    if job['run_attempt'] != config['producer_attempt'] or commit['tree']['sha'] != config['sdk_tree']:
        raise RuntimeError('Producer attempt/tree mismatch')
    if artifact['workflow_run']['id'] != config['producer_run'] or artifact['workflow_run']['head_sha'] != config['sdk_head']:
        raise RuntimeError('Artifact workflow binding mismatch')
    if artifact['expired'] or artifact['name'] != 'web-client-artifacts' or artifact['id'] != config['artifact_id']:
        raise RuntimeError('Artifact identity/expiry mismatch')
    if artifact['digest'] != config['artifact_digest'] or artifact['size_in_bytes'] != config['artifact_bytes']:
        raise RuntimeError('Artifact digest/size metadata mismatch')
    command(['gh', 'api', '--allow-escape-sequences', 'repos/0xMiden/web-sdk/actions/jobs/' + str(config['producer_job_id']) + '/logs'],
            output='sdk-producer.log')
    if digest(proof / 'sdk-producer.log') != config['producer_log_sha256']:
        raise RuntimeError('Producer log receipt differs; inspect before use')
    save('producer-receipt.json', config)
elif args.stage == 'restore':
    archive = proof / 'sdk-dist.zip'
    command(['gh', 'api', '--allow-escape-sequences', 'repos/0xMiden/web-sdk/actions/artifacts/' + str(config['artifact_id']) + '/zip'],
            timeout=360, output='sdk-dist.zip')
    if archive.stat().st_size != config['artifact_bytes'] or 'sha256:' + digest(archive) != config['artifact_digest']:
        raise RuntimeError('Downloaded ZIP digest/size mismatch')
    target = sdk / 'crates/web-client/dist'
    if target.exists():
        raise RuntimeError('Refuse to extract over existing SDK dist')
    seen = set()
    entries = []
    total = 0
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            path = PurePosixPath(item.filename)
            mode = item.external_attr >> 16
            if (path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename
                    or not path.parts or path.parts[0] not in ['st', 'mt'] or stat.S_ISLNK(mode)):
                raise RuntimeError('Unsafe/unexpected ZIP entry')
            normalized = path.as_posix().rstrip('/')
            if normalized in seen:
                raise RuntimeError('Duplicate ZIP path')
            seen.add(normalized)
            total += item.file_size
            if total > 2 * 1024**3 or item.file_size > 1024**3:
                raise RuntimeError('ZIP exceeds bounded extraction size')
            entries.append({'path': item.filename, 'bytes': item.file_size})
        target.mkdir()
        z.extractall(target)
    save('zip-entries.json', entries)
    for variant in ['st', 'mt']:
        for name in ['eager.js', 'index.js', 'wasm.js', 'index.d.ts',
                     'workers/web-client-methods-worker.js', 'workers/web-client-methods-worker.module.js']:
            if not (target / variant / name).is_file():
                raise RuntimeError('Missing required variant/worker output: ' + variant + '/' + name)
        if not list((target / variant / 'assets').glob('*.wasm')):
            raise RuntimeError('Missing variant WASM')
        if not list((target / variant / 'workers/assets').glob('*.wasm')):
            raise RuntimeError('Missing worker WASM')
        if not any('installNoteAcquisitionGate' in p.read_text(errors='replace') for p in (target / variant).glob('*.js')):
            raise RuntimeError('Missing generated acquisition API text')
    save('dist-before.json', dist_manifest())
elif args.stage == 'install':
    command(['pnpm', '--filter', '@miden-sdk/miden-sdk...', '--filter', '@miden-sdk/react...',
             '--filter', '@miden-sdk/vite-plugin...', 'install', '--frozen-lockfile', '--ignore-scripts'],
            cwd=sdk, timeout=360, output='consumer-install.log')
    before = json.loads((proof / 'consumer-lock-before.json').read_text())
    if lock_manifest() != before:
        raise RuntimeError('Frozen install changed manifests/locks')
    save('consumer-lock-after-install.json', lock_manifest())
elif args.stage == 'build':
    for package, name in [('@miden-sdk/react', 'react-build.log'), ('@miden-sdk/vite-plugin', 'vite-plugin-build.log')]:
        command(['pnpm', '--filter', package, 'run', 'build'], cwd=sdk, timeout=360, output=name)
    if dist_manifest() != json.loads((proof / 'dist-before.json').read_text()):
        raise RuntimeError('JS companion build changed restored SDK dist')
    if lock_manifest() != json.loads((proof / 'consumer-lock-before.json').read_text()):
        raise RuntimeError('JS companion build changed manifests/locks')
elif args.stage == 'pack':
    outputs = []
    for name, directory in [('web-client', 'crates/web-client'), ('react', 'packages/react-sdk'),
                            ('vite-plugin', 'packages/vite-plugin')]:
        root = sdk / directory
        exports = require_exports(root)
        command(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', str(packages)],
                cwd=root, timeout=120, output='pack-' + name + '.json')
        packed = json.loads((proof / ('pack-' + name + '.json')).read_text())
        if len(packed) != 1 or Path(packed[0]['filename']).name != packed[0]['filename']:
            raise RuntimeError('Unexpected npm pack result')
        tarball = packages / packed[0]['filename']
        with tarfile.open(tarball, 'r:gz') as archive:
            names = set()
            for member in archive.getmembers():
                path = PurePosixPath(member.name)
                if (path.is_absolute() or '..' in path.parts or not path.parts
                        or path.parts[0] != 'package' or member.issym() or member.islnk()):
                    raise RuntimeError('Unsafe package member')
                if member.name in names:
                    raise RuntimeError('Duplicate package member')
                names.add(member.name)
            for exported in exports['exports']:
                if 'package/' + exported[2:] not in names:
                    raise RuntimeError('Export omitted from npm package')
            if name == 'web-client':
                required_source = ['js/noteAcquisition.js', 'js/node-index.js', 'lazy/package.json',
                                   'mt/package.json', 'mt/lazy/package.json']
                for relative in required_source:
                    if 'package/' + relative not in names:
                        raise RuntimeError('Source package file omitted')
                for relative in dist_manifest():
                    member = archive.extractfile('package/dist/' + relative)
                    if member is None or hashlib.sha256(member.read()).hexdigest() != digest(root / 'dist' / relative):
                        raise RuntimeError('Packed SDK dist differs from restored artifact')
        outputs.append({**exports, 'filename': tarball.name, 'sha256': digest(tarball), 'bytes': tarball.stat().st_size})
    save('packages.json', outputs)
elif args.stage == 'receipt':
    required = ['source-bindings.json', 'producer-receipt.json', 'sdk-producer.log', 'sdk-artifact.json',
                'consumer-lock-after-install.json', 'dist-before.json', 'packages.json']
    if any(not (proof / name).is_file() for name in required):
        raise RuntimeError('Required assembly evidence is absent')
    save('assembly-result.json', {'status': 'package-preparation-only', 'protected_acceptance': False,
         'sdk_head': config['sdk_head'], 'producer_checkout': config['producer_checkout'],
         'artifact_id': config['artifact_id'], 'producer_effective_lock_hash': None,
         'limitations': ['Producer final effective lock hash not emitted by source workflow',
                        'No wallet dependency injection, wallet tests/build or runtime acceptance'],
         'evidence_sha256': {name: digest(proof / name) for name in required}})
print('Completed assembly stage: ' + args.stage, flush=True)
