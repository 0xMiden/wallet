import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys

OUT = Path(os.environ['PROOF_DIR'])
ROOT = Path.cwd().resolve()
SPEC = json.loads((OUT / 'source-spec.json').read_text())
EXPECTED = json.loads((OUT / 'expected-cases.json').read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def restore():
    for rel, rule in SPEC['mutable_paths'].items():
        data = (OUT / rule['candidate_file']).read_bytes()
        assert digest(data) == rule['candidate_sha256']
        (ROOT / rel).write_bytes(data)


def select(arm):
    assert arm in ['positive', 'feature', 'wallet', 'restored']
    result = OUT / 'results' / arm
    result.mkdir(parents=True, exist_ok=False)
    restore()
    if arm in ['feature', 'wallet']:
        rel = SPEC['tests'][0 if arm == 'feature' else 1].replace('.test.tsx', '.tsx')
        rule = SPEC['mutable_paths'][rel]
        data = (OUT / rule['omission_file']).read_bytes()
        assert digest(data) == rule['omission_sha256']
        (ROOT / rel).write_bytes(data)


def snapshot(label, arm, framework):
    assert arm in ['positive', 'feature', 'wallet', 'restored']
    target = OUT / 'snapshots' / label
    target.mkdir(parents=True, exist_ok=False)
    assert git('rev-parse', 'HEAD').decode().strip() == SPEC['source']
    assert git('rev-parse', 'HEAD^{tree}').decode().strip() == SPEC['tree']
    stage = git('ls-files', '--stage', '-z')
    (target / 'stage.bin').write_bytes(stage)
    rows = {}
    changed = []
    for record in stage.split(b'\0'):
        if not record:
            continue
        header, raw_path = record.split(b'\t', 1)
        mode, oid, number = header.decode().split()
        assert number == '0'
        rel = raw_path.decode()
        expected = SPEC['source_map'][rel]
        assert mode == expected['mode'] and oid == expected['oid']
        path = ROOT / rel
        info = path.lstat()
        if mode == '120000':
            assert stat.S_ISLNK(info.st_mode)
            data = os.readlink(path).encode()
        else:
            assert stat.S_ISREG(info.st_mode)
            data = path.read_bytes()
        wanted = expected['sha256']
        for index, feature in enumerate(['feature', 'wallet']):
            owner = SPEC['tests'][index].replace('.test.tsx', '.tsx')
            if arm == feature and rel == owner:
                wanted = SPEC['mutable_paths'][rel]['omission_sha256']
                changed.append(rel)
        assert digest(data) == wanted, (label, rel)
        rows[rel] = {'mode': mode, 'oid': oid, 'physical_sha256': digest(data),
                     'physical_mode': stat.S_IMODE(info.st_mode)}
    assert set(rows) == set(SPEC['source_map'])
    assert sorted(git('diff', '--name-only').decode().splitlines()) == sorted(changed)
    assert not git('diff', '--cached', '--name-only')
    (target / 'status.txt').write_bytes(git('status', '--porcelain=v1', '--untracked-files=all'))
    index = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not index.is_absolute():
        index = ROOT / index
    (target / 'index.bin').write_bytes(index.read_bytes())
    values = {}
    if framework:
        for name in SPEC['framework']:
            directory = ROOT / 'node_modules' / name
            assert directory.is_dir() and directory.resolve().is_relative_to(ROOT), name
            count = 0
            for path in sorted(directory.rglob('*')):
                if path.is_file():
                    assert path.resolve().is_relative_to(ROOT)
                    count += 1
                    values[str(path.relative_to(ROOT))] = {
                        'sha256': digest(path.read_bytes()),
                        'mode': stat.S_IMODE(path.stat().st_mode)}
            assert count > 0, name
    save(target / 'source.json', {'head': SPEC['source'], 'tree': SPEC['tree'],
        'arm': arm, 'stage_sha256': digest(stage), 'source': rows, 'framework': values})


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


def classify():
    for prerequisite in ['install', 'format', 'lint', 'types']:
        assert (OUT / (prerequisite + '.exit')).read_text().strip() == '0', prerequisite
        assert (OUT / (prerequisite + '.tee.exit')).read_text().strip() == '0', prerequisite
        argv = (OUT / (prerequisite + '.argv.bin')).read_bytes().split(b'\0')
        assert argv[-1] == b'' and [x.decode() for x in argv[:-1]] == SPEC['prerequisite_argv'][prerequisite]
    wanted = {(r['file'], r['ordinal']): r for r in EXPECTED}
    assert len(wanted) == 28
    summaries = {}
    for arm in ['positive', 'feature', 'wallet', 'restored']:
        directory = OUT / 'results' / arm
        result = json.loads((directory / 'jest.json').read_text())
        counts = SPEC['predictions'][arm]
        assert (result['numTotalTests'], result['numPassedTests'], result['numFailedTests']) == (28, *counts[:2])
        assert result['numTotalTestSuites'] == len(result['testResults']) == 2
        assert result['numFailedTestSuites'] == (1 if arm in ['feature', 'wallet'] else 0)
        assert result['numPassedTestSuites'] + result['numFailedTestSuites'] == 2
        assert all(result[key] == 0 for key in ['numPendingTests', 'numTodoTests', 'numPendingTestSuites', 'numRuntimeErrorTestSuites'])
        assert result['wasInterrupted'] is False and result['openHandles'] == []
        argv = (directory / 'argv.bin').read_bytes().split(b'\0')
        expected_argv = ['yarn', 'jest', '--runTestsByPath', *SPEC['tests'], '--maxWorkers=2',
            '--coverage=false', '--watch=false', '--json', '--outputFile=' + str(directory / 'jest.json')]
        assert argv[-1] == b'' and [x.decode() for x in argv[:-1]] == expected_argv
        rows = []
        seen = set()
        for suite in result['testResults']:
            rel = str(Path(suite['name']).relative_to(ROOT))
            for ordinal, row in enumerate(suite['assertionResults']):
                key = (rel, ordinal)
                assert key not in seen
                seen.add(key)
                expectation = wanted[key]
                assert row['fullName'] == expectation['full_name']
                assert row['title'] == expectation['title'] and row['ancestorTitles'] == expectation['ancestor_titles']
                assert row['invocations'] == 1 and row['retryReasons'] == [] and row['failing'] is False
                failure = expectation.get('omission', {}).get('arm') == arm
                assert row['status'] == ('failed' if failure else 'passed')
                count = expectation['omission']['passing_assertions'] if failure else expectation['positive_passing_assertions']
                assert row['numPassingAsserts'] == count
                if failure:
                    assert len(row['failureMessages']) == len(row['failureDetails']) == 1
                    matcher = row['failureDetails'][0]['matcherResult']
                    assert matcher['name'] == 'toEqual' and matcher['pass'] is False
                    assert matcher['actual'] == expectation['omission']['matcher_actual']
                    assert matcher['expected'] == expectation['omission']['matcher_expected']
                    frame = re.findall(r'\bat [^\n]*?\(([^()\n]+):(\d+):(\d+)\)', row['failureMessages'][0])[0]
                    expected_frame = expectation['omission']['first_frame']
                    assert str(Path(frame[0]).relative_to(ROOT)) == rel
                    assert (int(frame[1]), int(frame[2])) == (expected_frame['line'], expected_frame['column'])
                else:
                    assert row['failureMessages'] == [] and row['failureDetails'] == []
                rows.append({'file': rel, 'ordinal': ordinal, 'full_name': row['fullName'],
                    'status': row['status'], 'passing_assertions': row['numPassingAsserts']})
        assert seen == set(wanted)
        assert len(rows) == 28 and sum(r['passing_assertions'] for r in rows) == counts[2]
        assert (directory / 'jest.exit').read_text().strip() == str(SPEC['normal_exit'][arm])
        assert (directory / 'tee.exit').read_text().strip() == '0'
        summaries[arm] = {'rows': rows, 'passed': counts[0], 'failed': counts[1], 'passing_assertions': counts[2]}
    compatibility = OUT / 'results' / 'compatibility'
    result = json.loads((compatibility / 'jest.json').read_text())
    argv = (compatibility / 'argv.bin').read_bytes().split(b'\0')
    expected_argv = ['yarn', 'jest', '--runTestsByPath', *SPEC['compatibility'], '--maxWorkers=2',
        '--coverage=false', '--watch=false', '--json', '--outputFile=' + str(compatibility / 'jest.json')]
    assert argv[-1] == b'' and [x.decode() for x in argv[:-1]] == expected_argv
    assert result['numTotalTestSuites'] == result['numPassedTestSuites'] == len(result['testResults']) == 3
    assert result['numFailedTestSuites'] == 0 and result['numTotalTests'] > 0
    assert all(result[key] == 0 for key in ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numPendingTestSuites', 'numRuntimeErrorTestSuites'])
    assert result['wasInterrupted'] is False and result['openHandles'] == []
    actual_files = {str(Path(suite['name']).relative_to(ROOT)) for suite in result['testResults']}
    assert actual_files == set(SPEC['compatibility'])
    compat_rows = []
    for suite in result['testResults']:
        assert suite['assertionResults']
        for ordinal, row in enumerate(suite['assertionResults']):
            assert row['status'] == 'passed' and row['failureMessages'] == [] and row['failureDetails'] == []
            assert row['invocations'] == 1 and row['retryReasons'] == [] and row['failing'] is False
            compat_rows.append({'file': str(Path(suite['name']).relative_to(ROOT)), 'ordinal': ordinal,
                'full_name': row['fullName'], 'passing_assertions': row['numPassingAsserts']})
    assert len(compat_rows) == result['numTotalTests'] == result['numPassedTests']
    assert (compatibility / 'jest.exit').read_text().strip() == '0' and (compatibility / 'tee.exit').read_text().strip() == '0'
    expected_snapshots = {'initial': 'positive', 'before-compatibility': 'restored',
        'after-compatibility': 'restored', 'final': 'restored'}
    for arm in ['positive', 'feature', 'wallet', 'restored']:
        expected_snapshots['before-' + arm] = arm
        expected_snapshots['after-' + arm] = arm
    assert {p.name for p in (OUT / 'snapshots').iterdir()} == set(expected_snapshots)
    assert {p.name for p in (OUT / 'results').iterdir()} == {'positive', 'feature', 'wallet', 'restored', 'compatibility'}
    baseline = OUT / 'snapshots' / 'before-positive'
    original = json.loads((baseline / 'source.json').read_text())
    normal, entries, metadata = index_identity((baseline / 'index.bin').read_bytes())
    snapshots = {}
    for directory in sorted((OUT / 'snapshots').iterdir()):
        current = json.loads((directory / 'source.json').read_text())
        assert current['head'] == SPEC['source'] and current['tree'] == SPEC['tree']
        assert current['arm'] == expected_snapshots[directory.name]
        raw = (directory / 'index.bin').read_bytes()
        current_normal, current_entries, current_metadata = index_identity(raw)
        assert current_normal == normal
        assert {path.decode() for path in current_entries} == set(SPEC['source_map'])
        reconstructed = b''
        for path, row in current_entries.items():
            source_row = SPEC['source_map'][path.decode()]
            assert row['mode'] == source_row['mode'] and row['oid'] == source_row['oid'] and row['stage'] == 0
            reconstructed += (row['mode'] + ' ' + row['oid'] + ' 0\t').encode() + path + b'\0'
        assert reconstructed == (directory / 'stage.bin').read_bytes()
        assert (directory / 'stage.bin').read_bytes() == (baseline / 'stage.bin').read_bytes()
        for rel, row in current['source'].items():
            assert row['physical_mode'] == original['source'][rel]['physical_mode']
        if directory.name != 'initial':
            assert current['framework'] == original['framework']
        snapshots[directory.name] = {'index': current_metadata, 'raw_equal': raw == (baseline / 'index.bin').read_bytes()}
    assert json.loads((OUT / 'snapshots' / 'final' / 'source.json').read_text())['arm'] == 'restored'
    save(OUT / 'classification.json', {'status': 'SCOPED_PROOF_REQUIRES_CONTROLLER_ACCEPTANCE',
        'source': SPEC['source'], 'results': summaries, 'compatibility_rows': compat_rows,
        'index_snapshots': snapshots, 'coverage_whole_unit_platform_review_merge': 'PENDING'})


def seal():
    rows = []
    for path in sorted(OUT.rglob('*')):
        assert not path.is_symlink(), path
        if path.is_file() and path != OUT / 'hashes.json':
            rows.append({'path': str(path.relative_to(OUT)), 'bytes': path.stat().st_size,
                'sha256': digest(path.read_bytes())})
    save(OUT / 'hashes.json', rows)


if sys.argv[1] == 'select':
    select(sys.argv[2])
elif sys.argv[1] == 'snapshot':
    snapshot(sys.argv[2], sys.argv[3], sys.argv[4] == 'framework')
elif sys.argv[1] == 'restore':
    restore()
elif sys.argv[1] == 'classify':
    classify()
elif sys.argv[1] == 'seal':
    seal()
else:
    raise SystemExit('unknown operation')
