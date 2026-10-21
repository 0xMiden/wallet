import hashlib
import json
import os
from pathlib import Path
import re
import struct

P = Path(os.environ['PROOF_DIR']).resolve()
ROOT = Path.cwd().resolve()
TOOLS = Path(__file__).resolve().parent
SPEC = json.loads((TOOLS / 'source-spec.json').read_text())
EXPECTED = json.loads((TOOLS / 'expected.json').read_text())
CASES = {(row['path'], row['full_name']): row for row in EXPECTED['cases']}
ALL_TARGETS = {(row['path'], row['full_name']): row
               for arm in EXPECTED['arms'] for row in arm['targets']}
assert len(CASES) == 283 and len(ALL_TARGETS) == 14


def load(path):
    return json.loads(path.read_text())


def relative(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


def natural(stem, expected):
    assert int(Path(str(stem) + '.exit').read_text()) == expected, stem
    assert int(Path(str(stem) + '.tee.exit').read_text()) == 0, stem


def run(arm, spec=None):
    directory = P / 'arms' / arm
    assert (directory / 'complete.json').is_file(), arm
    results = directory / 'results'
    files = EXPECTED['core_files'] if spec else EXPECTED['compatibility_files']
    output = results / 'jest.json'
    argv = (results / 'jest.argv').read_bytes().split(b'\0')
    wanted = ['yarn', 'jest', '--runTestsByPath', *files, '--maxWorkers=2', '--coverage=false',
              '--watch=false', '--no-colors', '--json', '--outputFile=' + str(output)]
    assert argv[-1] == b'' and [part.decode() for part in argv[:-1]] == wanted, arm
    data = load(output)
    failed = spec['failed'] if spec else 0
    assert data['numFailedTests'] == failed, arm
    if spec:
        assert (data['numTotalTests'], data['numPassedTests']) == (283, spec['passed']), arm
    else:
        assert data['numTotalTests'] > 0 and data['numTotalTests'] == data['numPassedTests'], arm
    assert data['numTotalTestSuites'] == len(files), arm
    assert data['numFailedTestSuites'] + data['numPassedTestSuites'] == len(files), arm
    assert all(data[key] == 0 for key in ['numPendingTests', 'numTodoTests',
               'numPendingTestSuites', 'numRuntimeErrorTestSuites']), arm
    assert data['wasInterrupted'] is False and data['success'] is (not failed), arm
    assert data['openHandles'] == [] and data['snapshot']['failure'] is False, arm
    assert all(data['snapshot'][key] == 0 for key in ['added', 'updated', 'unchecked', 'unmatched']), arm
    targets = {(row['path'], row['full_name']): row for row in spec['targets']} if spec else {}
    rows, failures, suites = {}, {}, set()
    for suite in data['testResults']:
        path = relative(suite['name'])
        assert path in files and path not in suites and suite['assertionResults'], (arm, path)
        suites.add(path)
        assert suite['status'] in ['passed', 'failed'], (arm, path)
        suite_failed = False
        for row in suite['assertionResults']:
            key = (path, row['fullName'])
            assert key not in rows and (not spec or key in CASES), (arm, key)
            assert row['fullName'] == ' '.join([*row['ancestorTitles'], row['title']]), (arm, key)
            assert row['invocations'] == 1 and row['retryReasons'] == [] and row['failing'] is False, (arm, key)
            assert row['status'] in ['passed', 'failed'], (arm, key)
            assert type(row['numPassingAsserts']) is int and row['numPassingAsserts'] >= 0, (arm, key)
            if row['status'] == 'failed':
                suite_failed = True
                assert key in targets, (arm, key)
                target = targets[key]
                assert row['numPassingAsserts'] == target['prior_assertions'], (arm, key)
                assert len(row['failureDetails']) == 1 and len(row['failureMessages']) == 1, (arm, key)
                detail = row['failureDetails'][0]
                assert set(detail) == {'matcherResult'}, (arm, key)
                matcher = detail['matcherResult']
                assert set(matcher) == {'message', 'pass'}, (arm, key)
                assert matcher['pass'] is target['matcher_pass'], (arm, key)
                assert isinstance(matcher['message'], str), (arm, key)
                if target.get('message_exact', False):
                    assert matcher['message'] == target['message_prefix'], (arm, key)
                else:
                    assert matcher['message'].startswith(target['message_prefix']), (arm, key)
                message = re.sub(r'\x1b\[[0-9;]*m', '', row['failureMessages'][0])
                assert target['message_prefix'] in message, (arm, key)
                frames = re.findall(r'\bat [^\n]*?\(([^()\n]+):(\d+):(\d+)\)', message)
                assert frames, (arm, key)
                first = frames[0]
                assert (relative(first[0]), int(first[1]), int(first[2])) == (
                    path, target['line'], target['column']), (arm, key, first)
                failures[key] = {'first_frame': [path, int(first[1]), int(first[2])],
                                 'prior_passing_assertions': row['numPassingAsserts']}
            else:
                assert row['failureDetails'] == [] and row['failureMessages'] == [], (arm, key)
                if spec:
                    if key in ALL_TARGETS:
                        assert row['numPassingAsserts'] == ALL_TARGETS[key]['positive_assertions'], (arm, key)
                    elif CASES[key]['prior_status'] == 'passed':
                        assert row['numPassingAsserts'] == CASES[key]['prior_assertions'], (arm, key)
            rows[key] = row
        assert suite['status'] == ('failed' if suite_failed else 'passed'), (arm, path)
    assert suites == set(files) and set(failures) == set(targets), arm
    assert sum(row['status'] == 'failed' for row in rows.values()) == failed, arm
    assert len(rows) == data['numTotalTests'], arm
    assert data['numFailedTestSuites'] == len({key[0] for key in failures}), arm
    if spec:
        assert set(rows) == set(CASES), arm
    natural(results / 'jest', spec['exit'] if spec else 0)
    return rows, {'total': len(rows), 'passed': data['numPassedTests'], 'failed': failed,
                  'passing_assertions': sum(row['numPassingAsserts'] for row in rows.values()),
                  'cases': [{'path': key[0], 'full_name': key[1], 'status': row['status'],
                             'passing_assertions': row['numPassingAsserts']} for key, row in sorted(rows.items())],
                  'failures': [{'path': key[0], 'full_name': key[1], **value}
                               for key, value in sorted(failures.items())]}


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


def stage_identity(raw):
    assert raw.endswith(b'\0')
    entries = {}
    for row in raw[:-1].split(b'\0'):
        identity, path = row.split(b'\t', 1)
        mode, oid, stage = identity.decode('ascii').split()
        assert path not in entries
        entries[path] = {'mode': mode, 'oid': oid, 'stage': int(stage)}
    return entries


def source_and_index():
    initial = load(P / 'initial/source.json')
    stage_raw = (P / 'initial/index-stage.bin').read_bytes()
    initial_stage = stage_identity(stage_raw)
    expected_stage = {path.encode(): {'mode': row['git_mode'], 'oid': row['git_oid'], 'stage': 0}
                      for path, row in initial['source'].items()}
    assert len(initial_stage) == SPEC['source_entries'] and initial_stage == expected_stage
    initial_raw = (P / 'initial/index.bin').read_bytes()
    baseline, initial_entries, _ = index_identity(initial_raw)
    checks = {}
    wanted = [P / 'initial', P / 'installed', P / 'before-final-restore', P / 'final']
    for arm in [row['name'] for row in EXPECTED['arms']] + ['compatibility']:
        directory = P / 'arms' / arm
        wanted.extend([directory / name for name in ['candidate-start', 'source-before', 'source-after']])
    actual = {path.parent for path in P.rglob('source.json')
              if path.relative_to(P).parts[0] not in ['tools', 'source', 'framework']}
    assert actual == set(wanted), (actual, wanted)
    for destination in wanted:
        source = load(destination / 'source.json')
        assert source['errors'] == []
        assert source['head'] == SPEC['source_head'] and source['tree'] == SPEC['source_tree']
        assert set(source['source']) == set(initial['source'])
        mutation = SPEC['mutations'].get(source['arm'])
        for path, row in source['source'].items():
            expected = dict(initial['source'][path])
            if mutation and path == mutation['path']:
                expected.update(physical_oid=mutation['omission']['oid'],
                                bytes=mutation['omission']['bytes'], sha256=mutation['omission']['sha256'])
            if source['arm'] == 'observed':
                continue
            assert row == expected, (destination, path)
        current_stage_raw = (destination / 'index-stage.bin').read_bytes()
        assert current_stage_raw == stage_raw, destination
        current_raw = (destination / 'index.bin').read_bytes()
        normalized, entries, metadata = index_identity(current_raw)
        assert normalized == baseline, destination
        assert stage_identity(current_stage_raw) == {
            path: {key: row[key] for key in ['mode', 'oid', 'stage']} for path, row in entries.items()}, destination
        assert source['index_sha256'] == metadata['raw_sha256']
        assert not (destination / 'cached.diff').read_bytes()
        changes = []
        for path, row in entries.items():
            delta = {key: {'before': initial_entries[path]['stats'][key], 'after': value}
                     for key, value in row['stats'].items() if initial_entries[path]['stats'][key] != value}
            if delta:
                changes.append({'path': path.decode(), 'fields': delta})
        checks[destination.relative_to(P).as_posix()] = {
            **metadata, 'raw_byte_equal_initial': current_raw == initial_raw, 'stat_cache_changes': changes}
    with (P / 'index-semantics.json').open('x') as stream:
        json.dump({'allowed_changes': 'Only entry ctime/mtime/device/inode/uid/gid/size and recomputed checksum. '
                   'Header/version/count, mode/OID/stage/all flags, path/padding and extension bytes stay exact.',
                   'snapshots': checks}, stream, indent=2)
        stream.write('\n')
    before = load(P / 'framework-initial/framework.json')
    locations = [P / 'framework-final']
    for arm in [row['name'] for row in EXPECTED['arms']] + ['compatibility']:
        locations.extend([P / 'arms' / arm / name for name in ['framework-before', 'framework-after']])
    for destination in locations:
        assert load(destination / 'framework.json') == before, destination
    final = load(P / 'finalization.json')
    assert final['restored_and_validated'] is True and final['errors'] == []


def main():
    for step, argv in SPEC['prerequisite_argv'].items():
        stem = P / 'prerequisites' / step
        natural(stem, 0)
        raw = Path(str(stem) + '.argv').read_bytes().split(b'\0')
        assert raw[-1] == b'' and [part.decode() for part in raw[:-1]] == argv, step
    natural(P / 'finalize', 0)
    source_and_index()
    summaries = {}
    positive = None
    for spec in EXPECTED['arms']:
        arm = spec['name']
        rows, summaries[arm] = run(arm, spec)
        if arm == 'positive':
            positive = rows
        else:
            targets = {(row['path'], row['full_name']) for row in spec['targets']}
            for key, row in rows.items():
                if key not in targets:
                    assert row['numPassingAsserts'] == positive[key]['numPassingAsserts'], (arm, key)
    assert summaries['positive']['passing_assertions'] == summaries['restored']['passing_assertions']
    _, summaries['compatibility'] = run('compatibility')
    with (P / 'classification.json').open('x') as stream:
        json.dump({'status': 'OBSERVED_SCOPED_PROOF_CONTROLLER_ACCEPTANCE_REQUIRED', 'results': summaries,
                   'limits': ['No F006 repair credit, source advancement, whole-head95, full Unit, platform, '
                              'visual delivery, final review, public publication or merge credit.']}, stream, indent=2)
        stream.write('\n')


if __name__ == '__main__':
    main()
