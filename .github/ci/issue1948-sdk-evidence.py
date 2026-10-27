#!/usr/bin/env python3
"""Extract bounded receipts from an existing successful same-repository artifact."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

workspace = Path(os.environ['GITHUB_WORKSPACE'])
config = json.loads((workspace / 'controller/.github/ci/issue1948-sdk-evidence-inputs.json').read_text())
evidence = workspace / 'evidence'
small = workspace / 'small-proof'
evidence.mkdir(exist_ok=True)
small.mkdir(exist_ok=True)


def save(name, value):
    (evidence / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=workspace / 'controller', text=True, timeout=30).strip()


def api(endpoint, target, raw=False, timeout=60):
    argv = ['gh', 'api']
    if raw:
        argv.append('--allow-escape-sequences')
    argv.append('repos/0xMiden/wallet/' + endpoint)
    with target.open('wb') as output, (evidence / (target.name + '.stderr.log')).open('wb') as errors:
        subprocess.run(argv, stdout=output, stderr=errors, check=True, timeout=timeout)


if git('rev-parse', 'HEAD') != os.environ['GITHUB_SHA'] or git('rev-parse', 'HEAD^') != config['wallet_source']:
    raise RuntimeError('Workflow source/sole-parent mismatch')
if git('rev-parse', 'HEAD^^{tree}') != config['wallet_tree']:
    raise RuntimeError('Frozen source tree mismatch')
parents = git('show', '-s', '--format=%P', 'HEAD').split()
if parents != [config['wallet_source']]:
    raise RuntimeError('Workflow must have exactly the frozen source as parent')
changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').splitlines()
if sorted(changed) != sorted(config['proof_paths']):
    raise RuntimeError('Unexpected workflow payload changes')
api('actions/runs/' + str(config['run_id']), evidence / 'package-run.json')
api('actions/artifacts/' + str(config['artifact_id']), evidence / 'artifact.json')
run = json.loads((evidence / 'package-run.json').read_text())
artifact = json.loads((evidence / 'artifact.json').read_text())
if (run['head_sha'] != config['package_workflow_sha'] or run['conclusion'] != 'success'
        or run['run_attempt'] != 1 or artifact['expired'] or artifact['id'] != config['artifact_id']
        or artifact['name'] != config['artifact_name'] or artifact['workflow_run']['id'] != config['run_id']
        or artifact['workflow_run']['head_sha'] != config['package_workflow_sha']
        or artifact['size_in_bytes'] != config['artifact_bytes'] or artifact['digest'] != config['artifact_digest']):
    raise RuntimeError('Exact successful package artifact metadata mismatch')
archive = workspace / 'package-preparation.zip'
api('actions/artifacts/' + str(config['artifact_id']) + '/zip', archive, raw=True, timeout=360)
if archive.stat().st_size != config['artifact_bytes'] or 'sha256:' + sha(archive) != config['artifact_digest']:
    raise RuntimeError('Archive bytes/digest mismatch')
selected = []
seen = set()
total = 0
with zipfile.ZipFile(archive) as z:
    for item in z.infolist():
        path = PurePosixPath(item.filename)
        normalized = path.as_posix().rstrip('/')
        if (path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename
                or stat.S_ISLNK(item.external_attr >> 16) or normalized in seen):
            raise RuntimeError('Unsafe/duplicate ZIP entry')
        seen.add(normalized)
        if item.is_dir() or not path.parts or path.parts[0] != 'proof':
            continue
        if normalized == 'proof/sdk-dist.zip' or normalized.endswith(('.zip', '.tgz', '.tar', '.gz', '.wasm')):
            continue
        if len(path.parts) != 2:
            raise RuntimeError('Unexpected nested proof receipt')
        total += item.file_size
        if total > config['small_limit_bytes']:
            raise RuntimeError('Small evidence exceeds 20MiB bound')
        selected.append(item)
    required = set(config['required'])
    names = {x.filename.removeprefix('proof/') for x in selected}
    if not required.issubset(names):
        raise RuntimeError('Required small receipts or stage logs missing: ' + ','.join(sorted(required - names)))
    for item in selected:
        target = small / PurePosixPath(item.filename).name
        with z.open(item) as source, target.open('wb') as output:
            while True:
                block = source.read(1024 * 1024)
                if not block:
                    break
                output.write(block)
result = json.loads((small / 'assembly-result.json').read_text())
bindings = json.loads((small / 'source-bindings.json').read_text())
producer = json.loads((small / 'producer-receipt.json').read_text())
packages = json.loads((small / 'packages.json').read_text())
dist = json.loads((small / 'dist-before.json').read_text())
if (result['protected_acceptance'] is not False or result['status'] != 'package-preparation-only'
        or result['artifact_id'] != 12709639500 or result['sdk_head'] != config['sdk_source']
        or bindings['workflow'] != config['package_workflow_sha']
        or bindings['wallet'] != {'sha': config['wallet_source'], 'tree': config['wallet_tree']}
        or bindings['sdk'] != {'sha': config['sdk_source'], 'tree': config['sdk_tree']}
        or producer['sdk_head'] != config['sdk_source'] or producer['artifact_id'] != 12709639500
        or not dist or len(packages) != 3):
    raise RuntimeError('Extracted package/source/acceptance receipt mismatch')
if {p['name'] for p in packages} != {'@miden-sdk/miden-sdk', '@miden-sdk/react', '@miden-sdk/vite-plugin'}:
    raise RuntimeError('Three-package receipt mismatch')
if (small / 'consumer-lock-before.json').read_bytes() != (small / 'consumer-lock-after-install.json').read_bytes():
    raise RuntimeError('Consumer frozen lock receipts differ')
for name, expected in result['evidence_sha256'].items():
    if Path(name).name != name or sha(small / name) != expected:
        raise RuntimeError('Assembly evidence hash mismatch')
save('extraction-result.json', {'status': 'small-evidence-extracted', 'source_run': config['run_id'],
     'source_artifact': config['artifact_id'], 'archive_digest': config['artifact_digest'],
     'small_bytes': total, 'protected_acceptance': False,
     'excluded': ['proof/sdk-dist.zip', 'packages/*'],
     'sha256': {p.name: sha(p) for p in sorted(small.iterdir()) if p.is_file()}})
print('Extracted bounded small evidence only; protected acceptance remains false.')
