import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys

SOURCE = '135949ab445af8553daf89917f27db0b3b4a338c'
TREE = '35eee92233fc6b65228fba3e595b5708e76dafcd'
OUT = Path(os.environ['VISUAL_PROOF_OUTPUT'])
ROOT = Path.cwd()


def git(*args):
    return subprocess.check_output(['git', *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


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


def snapshot(label):
    destination = OUT / 'snapshots' / label
    destination.mkdir(parents=True, exist_ok=False)
    assert git('rev-parse', 'HEAD').decode().strip() == SOURCE
    assert git('rev-parse', 'HEAD^{tree}').decode().strip() == TREE
    records = []
    for raw in git('ls-tree', '-rz', '--full-tree', SOURCE).split(b'\0'):
        if not raw:
            continue
        meta, name = raw.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        assert kind == 'blob'
        path = Path(os.fsdecode(name))
        info = path.lstat()
        if mode == '120000':
            assert stat.S_ISLNK(info.st_mode)
            physical = os.fsencode(os.readlink(path))
        else:
            assert stat.S_ISREG(info.st_mode) and not path.is_symlink()
            assert bool(info.st_mode & 0o111) == (mode == '100755')
            physical = path.read_bytes()
        expected = git('cat-file', 'blob', oid)
        assert physical == expected, str(path)
        records.append({'path': str(path), 'git_mode': mode, 'git_oid': oid, 'bytes': len(physical), 'sha256': sha(physical)})
    save(destination / 'sources.json', records)
    status = git('status', '--porcelain=v1', '--untracked-files=all')
    (destination / 'status.bin').write_bytes(status)
    assert all(line.startswith(b'?? .ci-proof/1616-visual/') for line in status.splitlines()), status.decode()
    (destination / 'stage.bin').write_bytes(git('ls-files', '--stage', '-z'))
    index = Path(git('rev-parse', '--git-path', 'index').decode().strip()).read_bytes()
    (destination / 'index.bin').write_bytes(index)
    normalized, entries, identity = index_identity(index)
    (destination / 'index.normalized.bin').write_bytes(normalized)
    save(destination / 'index.json', identity)
    save(destination / 'index.entries.json', {os.fsdecode(key): value for key, value in entries.items()})
    (destination / 'commit.txt').write_bytes(git('cat-file', 'commit', SOURCE))


def framework(label):
    destination = OUT / 'framework' / label
    destination.mkdir(parents=True, exist_ok=False)
    inventory = ROOT / '.ci-proof/1616-visual/bundle/module-inventory.json'
    modules = json.loads(inventory.read_text())
    required = [
        'src/app/templates/EvmConnectModal/EvmBridgeDepositStatus.tsx',
        'src/components/AmountInput.tsx',
        'src/screens/send-flow/SelectAmount.tsx',
        'src/screens/earn-flow/EarnDepositAmount.tsx',
        'src/lib/settings/theme.ts',
        'src/main.css',
        'src/i18n.ts'
    ]
    for path in required:
        assert any(module.split('?', 1)[0] == str(ROOT / path) for module in modules), path
    rows = []
    selected = set()
    for module in modules:
        if module.startswith('\0'):
            continue
        path = Path(module.split('?', 1)[0])
        if path.is_file() and 'node_modules' in path.parts:
            path = path.resolve(strict=True)
            assert path.is_relative_to((ROOT / 'node_modules').resolve())
            selected.add(path)
    for package in ['react', 'react-dom', 'vite', '@vitejs/plugin-react-swc', '@tailwindcss/vite', '@playwright/test', 'playwright', 'playwright-core', 'sharp']:
        path = ROOT / 'node_modules' / package / 'package.json'
        assert path.is_file(), package
        selected.add(path.resolve(strict=True))
    for path in sorted(selected):
        data = path.read_bytes()
        rows.append({'path': str(path.relative_to(ROOT)), 'mode': stat.S_IMODE(path.stat().st_mode), 'bytes': len(data), 'sha256': sha(data)})
    assert rows
    save(destination / 'files.json', rows)
    (destination / 'module-inventory.json').write_bytes(inventory.read_bytes())
    bundle = ROOT / '.ci-proof/1616-visual/bundle'
    built = []
    for path in sorted(bundle.rglob('*')):
        if not path.is_file():
            continue
        assert not path.is_symlink()
        data = path.read_bytes()
        relative = path.relative_to(bundle)
        built.append({'path': str(relative), 'bytes': len(data), 'sha256': sha(data)})
        if label == 'before-browser' and (relative == Path('index.html') or path.suffix in ['.js', '.css']):
            target = OUT / 'compiled' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            assert not target.exists()
            target.write_bytes(data)
    assert built
    save(destination / 'built-files.json', built)


def classify():
    before, after = (OUT / 'snapshots' / name for name in ['before-build', 'after-browser'])
    for name in ['sources.json', 'stage.bin', 'index.normalized.bin', 'commit.txt']:
        assert (before / name).read_bytes() == (after / name).read_bytes(), name
    assert (OUT / 'framework/before-browser/files.json').read_bytes() == (OUT / 'framework/after-browser/files.json').read_bytes()
    assert (OUT / 'framework/before-browser/built-files.json').read_bytes() == (OUT / 'framework/after-browser/built-files.json').read_bytes()
    for name in ['format', 'build', 'browser']:
        assert (OUT / f'{name}.exit').read_text().strip() == '0', name
        assert (OUT / f'{name}.tee.exit').read_text().strip() == '0', name
    raw = json.loads((OUT / 'playwright.json').read_text())
    rows = []
    def walk(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                assert len(spec['tests']) == 1
                test = spec['tests'][0]
                results = test['results']
                assert test['status'] == 'expected' and len(results) == 1
                assert results[0]['status'] == 'passed' and results[0]['retry'] == 0
                assert not results[0].get('errors') and not test.get('annotations')
                rows.append(spec['title'])
            walk(suite.get('suites', []))
    walk(raw.get('suites', []))
    assert not raw.get('errors')
    cases = ['bridge-empty-failure', 'amount-helper-without-error', 'amount-visible-error', 'earn-no-collateral', 'earn-selected-unknown-metadata']
    expected = [f'{case} / {theme}' for theme in ['light', 'dark'] for case in cases]
    assert rows == expected and len(rows) == 10
    images = []
    for theme in ['light', 'dark']:
        for case in cases:
            path = OUT / 'screenshots' / f'{case}-{theme}.png'
            data = path.read_bytes()
            assert data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR'
            width, height = struct.unpack('>II', data[16:24])
            assert (width, height) == (393, 852) and max(width, height) <= 1800
            detail = json.loads(path.with_suffix('.json').read_text())
            assert not detail['browserErrors'] and not detail['blockedRequests']
            images.append({'path': str(path.relative_to(OUT)), 'width': width, 'height': height, 'bytes': len(data), 'sha256': sha(data)})
    save(OUT / 'classification.json', {'scope': 'component display only; visual readback still required', 'source': SOURCE, 'tree': TREE, 'natural_build_exit': 0, 'natural_browser_exit': 0, 'tests': rows, 'screenshots': images, 'raw_index_bytes_preserved': True, 'index_semantics': 'only stat-cache fields and recomputed checksum may differ'})


def seal():
    rows = []
    for path in sorted(OUT.rglob('*')):
        if path.is_file() and path.name != 'payload-manifest.json':
            data = path.read_bytes()
            rows.append({'path': str(path.relative_to(OUT)), 'bytes': len(data), 'sha256': sha(data)})
    save(OUT / 'payload-manifest.json', rows)


if __name__ == '__main__':
    command = sys.argv[1]
    if command == 'snapshot':
        snapshot(sys.argv[2])
    elif command == 'framework':
        framework(sys.argv[2])
    elif command == 'classify':
        classify()
    elif command == 'seal':
        seal()
    else:
        raise SystemExit('unsupported command')
