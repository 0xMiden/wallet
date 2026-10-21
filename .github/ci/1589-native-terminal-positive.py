from pathlib import Path
import hashlib
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import traceback

ROOT = Path.cwd()
PROOF = Path(os.environ['PROOF_DIR'])
SPEC = json.loads((PROOF / 'contract.json').read_bytes())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], env=dict(os.environ, GIT_OPTIONAL_LOCKS='0'))


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def index_identity(raw):
    assert len(raw) >= 32 and raw[:4] == b'DIRC'
    assert hashlib.sha1(raw[:-20]).digest() == raw[-20:]
    version, count = struct.unpack('>II', raw[4:12])
    assert version in (2, 3), version
    limit = len(raw) - 20
    normalized = bytearray(raw[:limit])
    entries, pos = {}, 12
    stat_names = ['ctime_seconds', 'ctime_nanoseconds', 'mtime_seconds', 'mtime_nanoseconds',
                  'device', 'inode', 'uid', 'gid', 'size']
    for _ in range(count):
        start = pos
        assert pos + 62 <= limit
        fields = struct.unpack('>10I20sH', raw[pos:pos + 62])
        pos += 62
        flags = fields[-1]
        extended = None
        if flags & 0x4000:
            assert version == 3 and pos + 2 <= limit
            extended = struct.unpack('>H', raw[pos:pos + 2])[0]
            pos += 2
        end = raw.index(b'\0', pos, limit)
        path = raw[pos:end]
        assert path and path not in entries
        assert flags & 0x0fff == min(len(path), 0x0fff)
        pos = start + ((end - start + 1 + 7) // 8) * 8
        assert pos <= limit and not any(raw[end:pos])
        stats = fields[:6] + fields[7:10]
        entries[path] = {'mode': format(fields[6], '06o'), 'oid': fields[10].hex(),
                         'stage': (flags >> 12) & 3, 'flags': flags, 'extended_flags': extended,
                         'stats': dict(zip(stat_names, stats))}
        # Only cache metadata is excluded; mode and every following identity byte remain.
        normalized[start:start + 24] = b'\0' * 24
        normalized[start + 28:start + 40] = b'\0' * 12
    extension_start = pos
    while pos < limit:
        assert pos + 8 <= limit
        assert raw[pos:pos + 4] not in [b'link', b'sdir']
        length = struct.unpack('>I', raw[pos + 4:pos + 8])[0]
        pos += 8 + length
        assert pos <= limit
    assert pos == limit and len(entries) == count
    return bytes(normalized), entries, {'version': version, 'entries': count,
        'raw_sha256': hashlib.sha256(raw).hexdigest(), 'checksum_sha1': raw[-20:].hex(),
        'normalized_sha256': hashlib.sha256(normalized).hexdigest(),
        'extension_bytes': limit - extension_start,
        'extension_sha256': hashlib.sha256(raw[extension_start:limit]).hexdigest()}


def native_source(variant):
    data = git('show', SPEC['source'] + ':' + SPEC['native_path'])
    assert sha(data) == SPEC['normal_native_sha256']
    if variant == 'omission':
        needle = SPEC['omission_needle'].encode()
        assert data.count(needle) == 1
        data = data.replace(needle, b'')
        assert sha(data) == SPEC['omission_native_sha256'] and len(data) == SPEC['omission_native_bytes']
    return data


def bind_transport():
    assert git('rev-parse', 'HEAD^').decode().strip() == SPEC['source']
    paths = [SPEC['workflow'], SPEC['helper'], SPEC['contract_path']]
    assert sorted(git('diff', '--name-status', 'HEAD^', 'HEAD').decode().splitlines()) == sorted('A\t' + path for path in paths)
    (PROOF / 'transport.txt').write_bytes(git('rev-parse', 'HEAD', 'HEAD^{tree}', 'HEAD^'))
    (PROOF / 'transport-commit.bin').write_bytes(git('cat-file', 'commit', 'HEAD'))
    (PROOF / 'source-commit.bin').write_bytes(git('cat-file', 'commit', SPEC['source']))
    (PROOF / 'transport.patch').write_bytes(git('diff', '--binary', 'HEAD^', 'HEAD'))
    for path in paths:
        assert (ROOT / path).read_bytes() == git('show', 'HEAD:' + path)
    shutil.copy2(ROOT / SPEC['workflow'], PROOF / 'workflow.yml')


def snapshot(label, variant):
    out = PROOF / 'source-snapshots' / label
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    for expected in SPEC['source_files']:
        path = ROOT / expected['path']
        assert path.is_file() and not path.is_symlink(), str(path)
        data = path.read_bytes()
        rows.append({'path': expected['path'], 'sha256': sha(data), 'bytes': len(data), 'mode': stat.S_IMODE(path.stat().st_mode)})
    write(out / 'source.json', rows)
    (out / 'native-opener.ts').write_bytes((ROOT / SPEC['native_path']).read_bytes())
    for name, args in [
        ('identity.txt', ['rev-parse', 'HEAD', 'HEAD^{tree}', 'HEAD^']),
        ('stage.bin', ['ls-files', '--stage', '-z']),
        ('status.bin', ['status', '--porcelain=v1', '-z']),
        ('working-tree.patch', ['diff', '--binary'])
    ]:
        (out / name).write_bytes(git(*args))
    index = Path(git('rev-parse', '--path-format=absolute', '--git-path', 'index').decode().strip())
    raw_index = index.read_bytes()
    (out / 'index.bin').write_bytes(raw_index)
    normalized, index_entries, index_metadata = index_identity(raw_index)
    assert (out / 'identity.txt').read_text().splitlines() == [SPEC['source'], SPEC['tree'], SPEC['parent']]
    assert not git('diff', '--cached', '--name-only')
    wanted_changes = [SPEC['native_path']] if variant == 'omission' else []
    assert git('diff', '--name-only').decode().splitlines() == wanted_changes
    assert (out / 'status.bin').read_bytes() == b''.join(b' M ' + path.encode() + b'\0' for path in wanted_changes)
    for row, expected in zip(rows, SPEC['source_files']):
        wanted = {key: expected[key] for key in ['path', 'sha256', 'bytes', 'mode']}
        if expected['path'] == SPEC['native_path'] and variant == 'omission':
            wanted.update(sha256=SPEC['omission_native_sha256'], bytes=SPEC['omission_native_bytes'])
        assert row == wanted, (label, row, wanted)
    assert (ROOT / SPEC['native_path']).read_bytes() == native_source(variant)
    initial = PROOF / 'source-snapshots' / 'initial'
    initial_raw = (initial / 'index.bin').read_bytes()
    initial_normalized, initial_entries, initial_metadata = index_identity(initial_raw)
    identity_differences = []
    stat_differences = []
    for path in sorted(set(initial_entries) | set(index_entries)):
        before = initial_entries.get(path)
        after = index_entries.get(path)
        before_identity = {key: value for key, value in before.items() if key != 'stats'} if before else None
        after_identity = {key: value for key, value in after.items() if key != 'stats'} if after else None
        if before_identity != after_identity:
            identity_differences.append({'path': os.fsdecode(path), 'before': before_identity, 'after': after_identity})
        if before and after:
            changes = {key: {'before': before['stats'][key], 'after': after['stats'][key]}
                       for key in before['stats'] if before['stats'][key] != after['stats'][key]}
            if changes:
                stat_differences.append({'path': os.fsdecode(path), 'stats': changes})
    write(out / 'index-comparison.json', {
        'baseline': initial_metadata, 'current': index_metadata,
        'raw_equal': initial_raw == raw_index, 'normalized_equal': initial_normalized == normalized,
        'identity_differences': identity_differences, 'stat_cache_differences': stat_differences,
        'allowed_stat_fields': ['ctime_seconds', 'ctime_nanoseconds', 'mtime_seconds', 'mtime_nanoseconds',
                                'device', 'inode', 'uid', 'gid', 'size']
    })
    assert initial_normalized == normalized, (label, 'full normalized index changed')
    assert not identity_differences, (label, identity_differences)
    if label != 'initial':
        for name in ['identity.txt', 'stage.bin']:
            assert (out / name).read_bytes() == (initial / name).read_bytes(), (label, name)
    write(out / 'validated.json', {'label': label, 'variant': variant, 'source_files': len(rows),
                                  'raw_index_sha256': sha(raw_index),
                                  'normalized_index_sha256': index_metadata['normalized_sha256']})


def mutate():
    path = ROOT / SPEC['native_path']
    assert path.read_bytes() == native_source('fixed')
    path.write_bytes(native_source('omission'))


def restore():
    (ROOT / SPEC['native_path']).write_bytes(native_source('fixed'))


def classify(arm):
    out = PROOF / 'raw-results' / arm
    report = json.loads((out / 'jest.json').read_bytes())
    omission = arm == 'omission'
    failed = 7 if omission else 0
    assert int((out / 'jest.exit').read_text()) == (1 if omission else 0)
    assert int((out / 'jest.tee.exit').read_text()) == 0
    assert report['numTotalTests'] == 72 and report['numPassedTests'] == 72 - failed and report['numFailedTests'] == failed
    assert report['numPendingTests'] == report['numTodoTests'] == report['numRuntimeErrorTestSuites'] == 0
    assert report['numTotalTestSuites'] == 4 and report['numPendingTestSuites'] == 0
    assert report['numFailedTestSuites'] == (2 if omission else 0)
    assert report['numPassedTestSuites'] == (2 if omission else 4)
    assert report['wasInterrupted'] is False and report['success'] is (not omission)
    inventory = []
    for suite in report['testResults']:
        assert not suite.get('testExecError'), suite['name']
        assert suite['name'].startswith(str(ROOT) + os.sep)
        path = suite['name'][len(str(ROOT)) + 1:]
        expected_suite = next(item for item in SPEC['suites'] if item['path'] == path)
        assert len(suite['assertionResults']) == expected_suite['count']
        for case in suite['assertionResults']:
            inventory.append([path, case['fullName']])
            expected_failure = next((item for item in SPEC['red_failures'] if [item['path'], item['fullName']] == [path, case['fullName']]), None)
            if omission and expected_failure is not None:
                assert case['status'] == 'failed'
                assert case['numPassingAsserts'] == expected_failure['prior_passing_assertions']
                assert case['failureDetails'] == expected_failure['failureDetails']
                assert len(case['failureMessages']) == 1
                first_frame = case['failureMessages'][0].split('\n    at ', 1)[1].splitlines()[0]
                frame = str(ROOT / path) + ':' + str(expected_failure['frame_line']) + ':' + str(expected_failure['frame_column'])
                assert first_frame.endswith('(' + frame + ')'), first_frame
            else:
                assert case['status'] == 'passed' and not case['failureMessages'] and not case.get('failureDetails')
    assert len(inventory) == len(set(map(tuple, inventory))) == 72
    assert sorted(inventory) == sorted(SPEC['inventory'])
    write(out / 'inventory.json', inventory)
    write(out / 'validation.json', {'arm': arm, 'total': 72, 'passed': 72 - failed, 'failed': failed, 'skipped': 0, 'runtime_errors': 0, 'natural_exit': 1 if omission else 0, 'tee_exit': 0, 'valid': True})


def finalize():
    path = ROOT / SPEC['native_path']
    current = path.read_bytes() if path.is_file() else b''
    (PROOF / 'pre-final-restore-native-opener.ts').write_bytes(current)
    errors = []
    try:
        (PROOF / 'pre-final-restore.patch').write_bytes(git('diff', '--binary'))
    except Exception as error:
        errors.append(type(error).__name__ + ': ' + str(error))
    expected = current in [native_source('fixed'), native_source('omission')]
    restore()
    try:
        snapshot('final-restoration', 'fixed')
    except Exception as error:
        errors.append(type(error).__name__ + ': ' + str(error))
    write(PROOF / 'finalization.json', {'restored': path.read_bytes() == native_source('fixed'), 'pre_restore_bytes_known': expected, 'errors': errors})
    assert expected, 'unexpected native source bytes preserved before final restoration'
    assert not errors, errors


def seal():
    rows = []
    for path in sorted(PROOF.rglob('*')):
        assert not path.is_symlink(), str(path)
        if path.is_file() and path.name not in ['payload-manifest.json', 'payload-manifest.sha256']:
            rows.append({'path': path.relative_to(PROOF).as_posix(), 'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size, 'mode': stat.S_IMODE(path.stat().st_mode)})
    write(PROOF / 'payload-manifest.json', rows)
    (PROOF / 'payload-manifest.sha256').write_text(sha((PROOF / 'payload-manifest.json').read_bytes()) + '\n')


def main():
    command = sys.argv[1]
    if command == 'transport':
        bind_transport()
    elif command == 'snapshot':
        snapshot(sys.argv[2], sys.argv[3])
    elif command == 'mutate':
        mutate()
    elif command == 'restore':
        restore()
    elif command == 'classify':
        assert sys.argv[2] in ['positive', 'omission', 'restored']
        classify(sys.argv[2])
    elif command == 'finalize':
        finalize()
    elif command == 'seal':
        seal()
    else:
        raise ValueError(command)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        (PROOF / ('error-' + '-'.join(sys.argv[1:]).replace('/', '_') + '.txt')).write_text(traceback.format_exc())
        raise
