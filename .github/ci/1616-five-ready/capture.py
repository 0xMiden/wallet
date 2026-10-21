import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys

P = Path(os.environ['PROOF_DIR']).resolve()
ROOT = Path.cwd().resolve()
TOOLS = Path(__file__).resolve().parent
SPEC = json.loads((TOOLS / 'source-spec.json').read_text())
EXPECTED = json.loads((TOOLS / 'expected.json').read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def raw(path, data):
    with path.open('xb') as stream:
        stream.write(data)


def safe_path(relative):
    path = ROOT / relative
    assert not Path(relative).is_absolute() and '..' not in Path(relative).parts, relative
    assert path.parent.resolve().is_relative_to(ROOT), relative
    assert all(not part.is_symlink() for part in [path.parent, *path.parent.parents]
               if part.is_relative_to(ROOT)), relative
    return path


def entries():
    result = {}
    for row in git('ls-tree', '-r', '--full-tree', '-z', SPEC['source_head']).split(b'\0'):
        if not row:
            continue
        metadata, name = row.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        path = name.decode()
        assert kind == 'blob' and mode in ['100644', '100755', '120000'] and path not in result
        result[path] = {'mode': mode, 'oid': oid}
    assert len(result) == SPEC['source_entries']
    return result


def blob(oid):
    return git('cat-file', 'blob', oid)


def source_snapshot(destination, arm='candidate', retain=False):
    destination.mkdir(exist_ok=False)
    tree = entries()
    override = SPEC['mutations'].get(arm)
    rows, errors = {}, []
    for relative, item in tree.items():
        try:
            path = safe_path(relative)
            mode = stat.S_IMODE(path.lstat().st_mode)
            if item['mode'] == '120000':
                assert path.is_symlink(), relative
                data = os.fsencode(os.readlink(path))
                kind = 'symlink-target-only'
            else:
                assert path.is_file() and not path.is_symlink(), relative
                data = path.read_bytes()
                kind = 'regular'
            oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            wanted = override['omission']['oid'] if override and relative == override['path'] else item['oid']
            row = {'git_mode': item['mode'], 'git_oid': item['oid'], 'physical_oid': oid,
                   'physical_mode': mode, 'bytes': len(data), 'sha256': sha(data), 'type': kind}
            rows[relative] = row
            if arm != 'observed':
                assert oid == wanted, (relative, oid, wanted)
                if kind == 'regular':
                    assert mode == (0o755 if item['mode'] == '100755' else 0o644), (relative, mode)
            if retain and kind == 'regular':
                target = P / 'source' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                raw(target, data)
                target.chmod(mode)
        except Exception as error:
            errors.append({'path': relative, 'error': repr(error)})
    status = git('status', '--porcelain=v1', '--untracked-files=all')
    stage = git('ls-files', '--stage', '-z')
    index_path = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not index_path.is_absolute():
        index_path = ROOT / index_path
    index = index_path.read_bytes()
    raw(destination / 'index.bin', index)
    raw(destination / 'index-stage.bin', stage)
    raw(destination / 'status.bin', status)
    raw(destination / 'diff.patch', git('diff', '--binary', '--no-ext-diff'))
    raw(destination / 'cached.diff', git('diff', '--cached', '--binary', '--no-ext-diff'))
    raw(destination / 'identity.txt', git('rev-parse', 'HEAD', 'HEAD^{tree}'))
    write(destination / 'source.json', {'arm': arm, 'source': rows, 'errors': errors,
          'head': git('rev-parse', 'HEAD').decode().strip(),
          'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'index_sha256': sha(index)})
    if retain:
        raw(P / 'source-tree.bin', git('ls-tree', '-r', '--full-tree', '-z', SPEC['source_head']))
    assert not errors, errors
    assert len(rows) == SPEC['source_entries']
    assert sum(row['type'] == 'regular' for row in rows.values()) == SPEC['regular_files']
    assert sum(row['type'] == 'symlink-target-only' for row in rows.values()) == SPEC['symlinks']
    assert git('rev-parse', 'HEAD').decode().strip() == SPEC['source_head']
    assert git('rev-parse', 'HEAD^{tree}').decode().strip() == SPEC['source_tree']
    assert not (destination / 'cached.diff').read_bytes()
    if arm != 'observed':
        wanted_status = (' M ' + override['path'] + '\n').encode() if override else b''
        assert status == wanted_status, (arm, status)
    return rows


def framework(destination, retain=False):
    destination.mkdir(exist_ok=False)
    old_map, api_map, links = {}, {}, {}

    def record(path, target_map):
        assert path.is_file() and not path.is_symlink(), path
        resolved = path.resolve()
        assert resolved.is_relative_to(ROOT), str(path)
        data = path.read_bytes()
        relative = path.relative_to(ROOT).as_posix()
        mode = stat.S_IMODE(path.stat().st_mode)
        target_map[relative] = {'sha256': sha(data), 'mode': oct(mode)}
        for ancestor in [path.parent, *path.parent.parents]:
            if ancestor.is_relative_to(ROOT) and ancestor.is_symlink():
                links[ancestor.relative_to(ROOT).as_posix()] = {
                    'target': os.readlink(ancestor), 'resolved': ancestor.resolve().relative_to(ROOT).as_posix()}
        if retain:
            target = P / 'framework' / relative
            if target.exists():
                assert target.read_bytes() == data and stat.S_IMODE(target.stat().st_mode) == mode
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                raw(target, data)
                target.chmod(mode)

    for name in SPEC['framework_roots']:
        package = ROOT / name
        assert package.is_dir() and package.resolve().is_relative_to(ROOT), name
        for path in sorted(package.rglob('*')):
            if path.is_file() and not path.is_symlink():
                record(path, old_map)
    for relative in SPEC['framework_api_files']:
        record(ROOT / relative, api_map)
    write(destination / 'framework.json', {'prior_view': old_map, 'additional_api': api_map, 'links': links})
    digest = sha(json.dumps(old_map, sort_keys=True, separators=(',', ':')).encode())
    write(destination / 'identity.json', {'files': len(old_map), 'prior_view_sha256': digest,
          'additional_api_files': len(api_map)})
    assert len(old_map) == SPEC['framework_prior_files']
    assert digest == SPEC['framework_prior_sha256'], (digest, SPEC['framework_prior_sha256'])
    if not retain:
        assert json.loads((P / 'framework-initial/framework.json').read_text()) == {
            'prior_view': old_map, 'additional_api': api_map, 'links': links}, destination


def restore():
    for mutation in SPEC['mutations'].values():
        path = safe_path(mutation['path'])
        data = blob(mutation['candidate']['oid'])
        assert sha(data) == mutation['candidate']['sha256']
        assert path.is_file() and not path.is_symlink()
        path.write_bytes(data)


def initialize():
    assert P.is_dir() and not P.is_relative_to(ROOT)
    transport = git('rev-parse', 'HEAD').decode().strip()
    assert transport == os.environ['GITHUB_SHA']
    parent = git('show', '-s', '--format=%P', transport).decode().strip()
    assert parent == SPEC['source_head'], parent
    changed = git('diff-tree', '--no-commit-id', '--name-status', '-r', transport).decode().splitlines()
    assert sorted(changed) == ['A\t' + path for path in sorted(SPEC['transport_paths'])], changed
    for relative in SPEC['transport_paths']:
        data = git('show', transport + ':' + relative)
        assert (TOOLS / Path(relative).name).read_bytes() == data, relative
        assert safe_path(relative).read_bytes() == data, relative
    raw(P / 'transport.commit', git('cat-file', 'commit', transport))
    raw(P / 'transport.diff', git('diff', '--binary', SPEC['source_head'], transport))
    raw(P / 'transport.tree.bin', git('ls-tree', '-r', '--full-tree', '-z', transport))
    write(P / 'transport.json', {'transport_head': transport, 'parent': parent,
          'tree': git('rev-parse', transport + '^{tree}').decode().strip(),
          'run_id': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT'],
          'event': os.environ['GITHUB_EVENT_NAME'], 'ref': os.environ['GITHUB_REF']})
    assert os.environ['GITHUB_EVENT_NAME'] == 'push'
    assert os.environ['GITHUB_REF'] == 'refs/heads/ci/1616-five-ready-positive-proof'
    subprocess.check_call(['git', 'checkout', '--detach', SPEC['source_head']], cwd=ROOT)
    assert git('show', '-s', '--format=%P', 'HEAD').decode().strip() == SPEC['source_parent']
    raw(P / 'source.commit', git('cat-file', 'commit', SPEC['source_head']))
    raw(P / 'source-parent.commit', git('cat-file', 'commit', SPEC['source_parent']))
    source_snapshot(P / 'initial', retain=True)
    for arm, mutation in SPEC['mutations'].items():
        for version in ['candidate', 'omission']:
            data = blob(mutation[version]['oid'])
            assert sha(data) == mutation[version]['sha256'] and len(data) == mutation[version]['bytes']
            target = P / 'mutations' / arm / (version + '.source')
            target.parent.mkdir(parents=True, exist_ok=True)
            raw(target, data)
    write(P / 'initialized.json', {'source_head': SPEC['source_head'], 'source_tree': SPEC['source_tree']})


def installed():
    source_snapshot(P / 'installed')
    framework(P / 'framework-initial', retain=True)
    versions = {'python': sys.version, 'python_executable': sys.executable, 'platform': platform.platform()}
    for name in ['node', 'yarn', 'git']:
        binary = Path(shutil.which(name)).resolve()
        versions[name] = {'version': subprocess.check_output([name, '--version']).decode().strip(),
                          'executable': str(binary), 'sha256': sha(binary.read_bytes())}
    write(P / 'versions.json', versions)
    assert versions['node']['version'].startswith('v22.') and versions['yarn']['version'] == '1.22.22'
    write(P / 'inputs-ready.json', {'source_and_framework_recorded': True})


def begin(arm):
    assert arm in [item['name'] for item in EXPECTED['arms']] + ['compatibility']
    destination = P / 'arms' / arm
    destination.parent.mkdir(exist_ok=True)
    destination.mkdir(exist_ok=False)
    (destination / 'results').mkdir(exist_ok=False)
    restore()
    source_snapshot(destination / 'candidate-start')
    if arm in SPEC['mutations']:
        mutation = SPEC['mutations'][arm]
        data = blob(mutation['omission']['oid'])
        assert sha(data) == mutation['omission']['sha256']
        safe_path(mutation['path']).write_bytes(data)
    source_snapshot(destination / 'source-before', arm)
    framework(destination / 'framework-before')
    write(destination / 'begun.json', {'arm': arm})


def end(arm):
    destination = P / 'arms' / arm
    assert (destination / 'begun.json').is_file()
    results = destination / 'results'
    source_snapshot(destination / 'source-after', arm)
    framework(destination / 'framework-after')
    assert all((results / name).is_file() for name in ['jest.json', 'jest.log', 'jest.argv', 'jest.exit', 'jest.tee.exit'])
    write(destination / 'complete.json', {'raw_results_retained_before_source_validation': True})


def finalize():
    errors = []
    assert not (P / 'finalization.json').exists()
    for label, action in [
        ('observed', lambda: source_snapshot(P / 'before-final-restore', 'observed')),
        ('restore', restore),
        ('final-source', lambda: source_snapshot(P / 'final')),
        ('final-framework', lambda: framework(P / 'framework-final'))
    ]:
        try:
            action()
        except Exception as error:
            errors.append({'stage': label, 'error': repr(error)})
    write(P / 'finalization.json', {'restored_and_validated': not errors, 'errors': errors})
    assert not errors, errors


def seal():
    target = P / 'payload-manifest.json'
    assert not target.exists() and not (P / 'payload-manifest.sha256').exists()
    rows = []
    for path in sorted(P.rglob('*')):
        if path.is_dir() and not path.is_symlink():
            continue
        assert stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink(), path
        data = path.read_bytes()
        rows.append({'path': path.relative_to(P).as_posix(), 'sha256': sha(data),
                     'bytes': len(data), 'mode': stat.S_IMODE(path.stat().st_mode)})
    write(target, {'files': rows, 'count': len(rows), 'scope': 'Raw scoped CI evidence; controller acceptance required.'})
    raw(P / 'payload-manifest.sha256', (sha(target.read_bytes()) + '\n').encode())


if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'init':
        initialize()
    elif command == 'installed':
        installed()
    elif command == 'begin':
        begin(sys.argv[2])
    elif command == 'end':
        end(sys.argv[2])
    elif command == 'finalize':
        finalize()
    elif command == 'seal':
        seal()
    else:
        raise ValueError(command)
