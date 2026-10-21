import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(os.environ['SOURCE_ROOT']).resolve()
OUT = Path(os.environ['PROOF_DIR']).resolve()
BIND = json.loads((OUT / 'bindings.json').read_text())
SOURCE = BIND['source']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT,
                                  env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}, timeout=120)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(name, value):
    path = OUT / name
    with path.open('x') as handle:
        handle.write(json.dumps(value, indent=2) + '\n')


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


def validate_binding():
    assert BIND['ready'] is True
    assert git('rev-parse', 'HEAD').decode().strip() == SOURCE
    assert git('rev-parse', 'HEAD^{tree}').decode().strip() == BIND['tree']
    headers = git('cat-file', '-p', 'HEAD').split(b'\n\n', 1)[0].splitlines()
    assert [line[7:].decode() for line in headers if line.startswith(b'parent ')] == [BIND['parent']]
    assert not git('diff', '--name-only') and not git('diff', '--cached', '--name-only')
    assert not git('status', '--porcelain=v1', '--untracked-files=all')


def snapshot(label, with_framework):
    assert label in ('checkout', 'before', 'after')
    assert not list(OUT.glob(label + '.*')), 'stale or repeated snapshot'
    validate_binding()
    stage = git('ls-files', '--stage', '--full-name', '-z')
    (OUT / (label + '.stage.nul')).write_bytes(stage)
    files = {}
    for record in stage.split(b'\0'):
        if not record:
            continue
        header, raw_path = record.split(b'\t', 1)
        mode, oid, number = header.decode().split()
        assert number == '0' and mode in ['100644', '100755', '120000']
        path = raw_path.decode()
        p = ROOT / path
        info = p.lstat()
        if mode == '120000':
            assert stat.S_ISLNK(info.st_mode)
            data, kind = os.fsencode(os.readlink(p)), 'symlink'
        else:
            assert stat.S_ISREG(info.st_mode) and not p.is_symlink()
            assert bool(info.st_mode & 0o111) == (mode == '100755')
            data, kind = p.read_bytes(), 'regular'
        assert data == git('cat-file', 'blob', oid), path
        files[path] = {'git_mode': mode, 'oid': oid, 'sha256': digest(data), 'bytes': len(data),
                       'physical_mode': format(stat.S_IMODE(info.st_mode), '04o'), 'type': kind}
    assert len(files) == BIND['tracked_count']
    for entry in BIND['source_inputs']:
        assert files[entry['path']]['sha256'] == entry['sha256']
        assert files[entry['path']]['git_mode'] == entry['git_mode']
        assert files[entry['path']]['oid'] == entry['git_blob']
    index = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not index.is_absolute():
        index = ROOT / index
    raw_index = index.read_bytes()
    (OUT / (label + '.index')).write_bytes(raw_index)
    normalized, entries, index_info = index_identity(raw_index)
    (OUT / (label + '.index-normalized')).write_bytes(normalized)
    save(label + '.index-identity.json', {'summary': index_info,
         'entries': {path.decode(): row for path, row in entries.items()}})
    framework, versions, runtime = {}, {}, {}
    if with_framework:
        packages = BIND['framework'] + ['.bin/jest', '.bin/prettier', '.bin/eslint', '.bin/tsc']
        for package in packages:
            base = ROOT / 'node_modules' / package
            tool = package.startswith('.bin/')
            assert tool or (base.is_dir() and not base.is_symlink()), package
            metadata = base / 'package.json'
            if not tool:
                value = json.loads(metadata.read_text())
                versions[package] = {'name': value['name'], 'version': value['version'],
                                     'package_json_sha256': digest(metadata.read_bytes())}
            for p in [base] if tool else sorted(base.rglob('*')):
                info = p.lstat()
                if p.is_symlink():
                    target = p.resolve(strict=True)
                    assert target.is_relative_to(ROOT) and target != ROOT
                    assert target.is_file(), str(p)
                    data = target.read_bytes()
                    key = digest(data)
                    retained = OUT / 'framework-symlink-target-bytes' / key
                    retained.parent.mkdir(exist_ok=True)
                    if retained.exists():
                        assert retained.read_bytes() == data
                    else:
                        retained.write_bytes(data)
                    framework[str(p.relative_to(ROOT))] = {
                        'type': 'symlink', 'raw_link': os.readlink(p),
                        'link_sha256': digest(os.fsencode(os.readlink(p))),
                        'lstat_mode': format(stat.S_IMODE(info.st_mode), '04o'),
                        'target': str(target.relative_to(ROOT)), 'target_sha256': key,
                        'target_bytes': len(data), 'target_mode': format(stat.S_IMODE(target.stat().st_mode), '04o')}
                elif p.is_file():
                    assert p.resolve().is_relative_to(ROOT)
                    data = p.read_bytes()
                    framework[str(p.relative_to(ROOT))] = {'type': 'regular', 'sha256': digest(data),
                        'bytes': len(data), 'mode': format(stat.S_IMODE(info.st_mode), '04o')}
        assert set(versions) == set(BIND['framework_versions'])
        for package, version in BIND['framework_versions'].items():
            assert versions[package]['version'] == version, package
        for command in ['node', 'yarn', 'python3']:
            executable = Path(shutil.which(command)).resolve(strict=True)
            version = subprocess.check_output([str(executable), '--version'], timeout=30).decode().strip()
            runtime[command] = {'path': str(executable), 'sha256': digest(executable.read_bytes()),
                                'mode': format(stat.S_IMODE(executable.stat().st_mode), '04o'), 'version': version}
        assert runtime['node']['version'] == BIND['node_version']
        assert runtime['yarn']['version'] == BIND['yarn_version']
        if label == 'before':
            with tarfile.open(OUT / 'critical-framework.tar', 'w') as archive:
                for entry in BIND['framework_critical_files']:
                    p = ROOT / 'node_modules' / entry
                    assert p.is_file() and not p.is_symlink()
                    assert framework[str(p.relative_to(ROOT))]['sha256'] == digest(p.read_bytes())
                    archive.add(p, arcname=str(p.relative_to(ROOT)), recursive=False)
    save(label + '.json', {'head': SOURCE, 'tree': BIND['tree'], 'stage_sha256': digest(stage),
        'source': files, 'framework': framework, 'framework_versions': versions, 'runtime': runtime})
    if label == 'checkout':
        with tarfile.open(OUT / 'bound-source.tar', 'w') as archive:
            for entry in BIND['source_inputs']:
                archive.add(ROOT / entry['path'], arcname=entry['path'], recursive=False)


def bookends():
    snapshots = {label: json.loads((OUT / (label + '.json')).read_text())
                 for label in ['checkout', 'before', 'after']}
    first = snapshots['checkout']
    for value in snapshots.values():
        for key in ['head', 'tree', 'stage_sha256', 'source']:
            assert first[key] == value[key], key
    for key in ['framework', 'framework_versions', 'runtime']:
        assert snapshots['before'][key] == snapshots['after'][key], key
    original, entries, summary = index_identity((OUT / 'checkout.index').read_bytes())
    comparisons = []
    for label in ['before', 'after']:
        normalized, observed, info = index_identity((OUT / (label + '.index')).read_bytes())
        assert original == normalized and entries.keys() == observed.keys()
        changes = []
        for path in entries:
            left, right = entries[path], observed[path]
            assert {k: v for k, v in left.items() if k != 'stats'} == {k: v for k, v in right.items() if k != 'stats'}
            delta = {k: [left['stats'][k], right['stats'][k]] for k in left['stats']
                     if left['stats'][k] != right['stats'][k]}
            if delta:
                changes.append({'path': path.decode(), 'stat_cache_only': delta})
        comparisons.append({'label': label, 'summary': info, 'stat_differences': changes,
                            'raw_equal': summary['raw_sha256'] == info['raw_sha256']})
    save('bookend-comparison.json', {'source_stage_framework_runtime_equal': True,
         'full_index_identity_equal': True, 'checkout_index': summary, 'comparisons': comparisons,
         'policy': 'Raw bytes/checksums retained; only nine stat-cache fields may differ. Mode/OID/stage/flags/path/version/count/extensions exact.'})


def classify():
    rows = []
    raw = None
    if (OUT / 'jest.json').is_file():
        raw = json.loads((OUT / 'jest.json').read_text())
        for suite in raw['testResults']:
            path = str(Path(suite['name']).resolve().relative_to(ROOT))
            for ordinal, row in enumerate(suite['assertionResults']):
                rows.append({'file': path, 'ordinal': ordinal, 'assertion': row})
        save('inventory.json', rows)
    gates = ['corepack-prepare', 'checkout-snapshot', 'install', 'format', 'lint', 'types',
             'snapshot-before', 'snapshot-after']
    exits = {name: {'exit': (OUT / (name + '.exit')).read_text().strip(),
                    'tee': (OUT / (name + '.tee.exit')).read_text().strip()}
             for name in gates if (OUT / (name + '.exit')).exists()}
    save('prerequisite-exits.json', exits)
    assert len(exits) == len(gates) and all(v == {'exit': '0', 'tee': '0'} for v in exits.values()), 'prerequisite failure; no causal credit'
    bookends()
    assert isinstance(raw, dict), 'missing raw Jest JSON'
    assert raw['numTotalTestSuites'] == len(raw['testResults']) == 3
    assert {str(Path(suite['name']).resolve().relative_to(ROOT)) for suite in raw['testResults']} == set(BIND['tests'])
    assert raw['numRuntimeErrorTestSuites'] == 0 and raw['wasInterrupted'] is False
    assert raw['numPendingTests'] == raw['numTodoTests'] == raw['numPendingTestSuites'] == 0
    assert raw['numTotalTests'] == len(rows) == 33
    assert raw['numFailedTests'] == 19 and raw['numPassedTests'] == 14 and raw['success'] is False
    assert raw['numFailedTestSuites'] == 3 and raw['numPassedTestSuites'] == 0
    expected = {(row['file'], row['fullName']): row for row in BIND['expected_cases']}
    assert len(expected) == 33
    actual = {(row['file'], row['assertion']['fullName']): row['assertion'] for row in rows}
    assert len(actual) == len(rows) == 33 and set(actual) == set(expected)
    causal = []
    for key, row in actual.items():
        want = expected[key]
        for field in ['title', 'ancestorTitles', 'status', 'numPassingAsserts']:
            assert row[field] == want[field], (key, field)
        assert row['invocations'] == 1 and row['retryReasons'] == [] and row['failing'] is False
        if want['status'] == 'passed':
            assert row['failureMessages'] == row['failureDetails'] == []
            continue
        assert len(row['failureDetails']) == len(row['failureMessages']) == 1
        assert set(row['failureDetails'][0]) == {'matcherResult'}
        result = row['failureDetails'][0]['matcherResult']
        assert sorted(result) == want['matcher_keys'] and result['pass'] is False
        message = re.sub(r'\x1b\[[0-9;]*m', '', result['message'])
        assert message == want['expected_matcher_message'], key
        if want['matcher_name'] == 'toEqual':
            assert result['name'] == 'toEqual' and result['actual'] == want['actual'] == {}
            assert result['expected'] == want['expected']
        else:
            assert want['matcher_name'] == 'toMatchObject' and set(result) == {'message', 'pass'}
        failure = re.sub(r'\x1b\[[0-9;]*m', '', row['failureMessages'][0])
        assert failure.startswith('Error: ' + message)
        frames = re.findall(re.escape(key[0]) + r':(\d+):(\d+)', failure)
        assert frames and [int(v) for v in frames[0]] == want['first_frame'], key
        causal.append({'file': key[0], 'fullName': key[1], 'first_frame': want['first_frame'],
                       'prior_passing_assertions': row['numPassingAsserts'],
                       'matcher': want['matcher_name'], 'missing_expected': want['expected']})
    assert len(causal) == 19
    assert (OUT / 'jest.exit').read_text().strip() == '1'
    assert (OUT / 'jest.tee.exit').read_text().strip() == '0'
    save('classification.json', {'status': 'EXACT_EXPECTED_CURRENT_PROPOSAL_DIAGNOSTIC_RED',
         'source': SOURCE, 'tree': BIND['tree'], 'cases': 33, 'causal_failed': 19,
         'controls_passed': 14, 'skipped': 0, 'runtime_errors': 0, 'all_rows_retained': True,
         'causal': causal, 'remaining': 'No production, privacy-after-failure, coverage, finished review or merge credit.'})


def seal():
    path = OUT / 'hashes.json'
    assert not path.exists(), 'repeated seal'
    files = []
    for p in sorted(OUT.rglob('*')):
        if p.is_file():
            assert not p.is_symlink()
            files.append({'path': str(p.relative_to(OUT)), 'bytes': p.stat().st_size,
                          'sha256': digest(p.read_bytes()), 'mode': format(stat.S_IMODE(p.stat().st_mode), '04o')})
    save('hashes.json', files)


try:
    command = sys.argv[1]
    if command in ('source', 'snapshot'):
        snapshot(sys.argv[2], command == 'snapshot')
    elif command == 'classify':
        classify()
    elif command == 'seal':
        seal()
    else:
        raise SystemExit('unknown operation')
except Exception as error:
    name = '.'.join(sys.argv[1:]) + '.refusal.json'
    if not (OUT / name).exists():
        save(name, {'status': 'NOT_ACCEPTED', 'error_type': type(error).__name__, 'detail': str(error)})
    raise
