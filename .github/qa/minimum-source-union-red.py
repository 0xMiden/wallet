"""Minimum B171/M171 payload and fixed-output RED gates; no project imports."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import zipfile

QA = Path(__file__).resolve().parent
TARGET = 'tests/t-proof-budget.sh'
SELECTOR = 't-proof-budget.sh::test_required_source_union_nonmonotone'
COMPILER = '7092175a97a81d5e8131cd144e245db4f65a064fc2a8ce6d19486d06f560639a'
RUNNER = '5ffa3cd0b09b845aa00b0fe3c585cc8252cb75610bd8fbd4f6699a3dc63b1add'
OVERLAY = '21f81ae4ba1da612ab06be936d000c43c849b6c439c3a50331cd29912855c782'
MANIFESTS = {
    'B': '7df28cb2e5b8d97270424017af9b4f3fe7ea9659fa175c037f6ef60318d63fac',
    'M': '2f675f4aeee6506beefc0458a1c7863a31f4f11feddc91db122c9eae26cfee48',
}
HEADER = b'required_source_union_nonmonotone\n'
SETUP = b'  ok   union fixture prepares valid same-root identities and mandatory intervals\n'
FAILURE = b"  FAIL missing-inherited-coverage: repair retains ancestor-required 230-277 - expected '0' got '1'\n"
EXPECTED_LOG = HEADER + SETUP + FAILURE
SUMMARY = 'Synthetic minimum RED accepted: setup passed; inherited required coverage 230-277 was not retained.\n'
PUBLIC_FILES = {'identities.json', 'tools.json', 'outcomes.json', 'semantic-red.txt', 'infrastructure.json'}


def require(ok):
    if not ok:
        raise ValueError('minimum transport gate rejected input')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=unique_object)


def valid_path(name):
    path = PurePosixPath(name)
    require(bool(name) and not path.is_absolute() and str(path) == name)
    require(name != '.' and '..' not in path.parts and '\\' not in name and '\x00' not in name)


def validate_manifest(manifest):
    require(set(manifest) == {'member_count', 'members'})
    members = manifest['members']
    require(type(manifest['member_count']) is int and manifest['member_count'] == len(members) == 171)
    for name, row in members.items():
        valid_path(name)
        require(not any(name.startswith(other + '/') for other in members if other != name))
        require(set(row) == {'sha256', 'bytes', 'mode'})
        require(type(row['mode']) is int and row['mode'] in (0o644, 0o755))
        require(type(row['bytes']) is int and row['bytes'] >= 0)
        require(re.fullmatch('[0-9a-f]{64}', row['sha256']) is not None)
    return members


def validate_overlay(baseline, minimum):
    require(baseline.keys() == minimum.keys())
    require(all(baseline[name]['mode'] == minimum[name]['mode'] for name in baseline))
    require({name for name in baseline if baseline[name] != minimum[name]} == {TARGET})
    require(minimum[TARGET]['mode'] == 0o644 and minimum[TARGET]['sha256'] == OVERLAY)
    require(baseline['scripts/rev-evidence.py']['sha256'] == COMPILER)
    require(baseline['tests/run-tests.sh']['sha256'] == RUNNER)


def read_manifest(identity):
    raw = (QA / ('minimum-source-union-red-%s.manifest.json' % identity)).read_bytes()
    require(sha(raw) == MANIFESTS[identity])
    return validate_manifest(decode(raw))


def validate_archive(bundle, members, destination=None):
    items = bundle.infolist()
    require(len(items) == len(members) and {item.filename for item in items} == set(members))
    for item in items:
        valid_path(item.filename)
        row = members[item.filename]
        mode = item.external_attr >> 16
        require(not item.is_dir() and not item.flag_bits & 1)
        require(stat.S_IFMT(mode) in (0, stat.S_IFREG) and stat.S_IMODE(mode) == row['mode'])
        require(item.file_size == row['bytes'])
        data = bundle.read(item)
        require(len(data) == row['bytes'] and sha(data) == row['sha256'])
        if destination is not None:
            target = destination / item.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(row['mode'])


def prepare(work, public):
    raw = (QA / 'minimum-source-union-red-bindings.json').read_bytes()
    require(sha(raw) == os.environ['EXPECTED_BINDINGS_SHA256'])
    source = os.environ['EXPECTED_SOURCE']
    require(re.fullmatch('[0-9a-f]{40}', source) is not None and source == os.environ['GITHUB_SHA'])
    bindings = decode(raw)
    require(set(bindings) == {'B', 'M'})
    records = {identity: read_manifest(identity) for identity in ('B', 'M')}
    validate_overlay(records['B'], records['M'])
    for identity, pin in bindings.items():
        require(set(pin) == {'manifest_sha256', 'archive_sha256'})
        require(pin['manifest_sha256'] == MANIFESTS[identity])
        require(re.fullmatch('[0-9a-f]{64}', pin['archive_sha256']) is not None)
        archive = QA / ('minimum-source-union-red-%s.zip' % identity)
        require(archive.stat().st_size <= 16 * 1024 * 1024)
        require(sha(archive.read_bytes()) == pin['archive_sha256'])
        destination = work / identity
        destination.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            validate_archive(bundle, records[identity], destination)
    runtime = work / 'runtime'
    shutil.copytree(work / 'M', runtime)
    actual = {path.relative_to(runtime).as_posix(): {
        'sha256': sha(path.read_bytes()), 'bytes': path.stat().st_size,
        'mode': stat.S_IMODE(path.stat().st_mode)} for path in runtime.rglob('*') if path.is_file()}
    require(actual == records['M'])
    # Member names and generated manifests are deliberately not public evidence.
    (public / 'identities.json').write_text(json.dumps({
        'expected_source': source, 'bindings_sha256': sha(raw), 'payload_pins': bindings,
        'runtime_members': len(actual), 'unchanged_members': 170,
        'compiler_sha256': COMPILER, 'runner_sha256': RUNNER, 'overlay_sha256': OVERLAY,
    }, sort_keys=True) + '\n')


def accepted_red(raw_exit, log, results):
    # Exact bytes also reject extra task headers, diagnostics, setup/schema errors and CRLF.
    return raw_exit == 1 and results == b'ok\nfail\n' and log == EXPECTED_LOG


def export_result(public, raw_exit, log, results):
    accepted = accepted_red(raw_exit, log, results)
    (public / 'outcomes.json').write_text(json.dumps({
        'raw_exit': raw_exit, 'selected_headers': log.splitlines().count(HEADER.rstrip(b'\n')),
        'assertions': sum(line.startswith((b'  ok   ', b'  FAIL ')) for line in log.splitlines()),
        'results_bytes': len(results), 'semantic_red_observed': accepted,
    }, sort_keys=True) + '\n')
    if accepted:
        (public / 'semantic-red.txt').write_text(SUMMARY)
    else:
        (public / 'semantic-red.txt').unlink(missing_ok=True)
    require({path.name for path in public.iterdir()} <= PUBLIC_FILES)
    return accepted


def gate(work, public, raw_exit):
    results_path = work / 'red/out/red.results'
    results = results_path.read_bytes() if results_path.is_file() else b''
    require(export_result(public, raw_exit, (work / 'red.log').read_bytes(), results))


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'prepare':
        prepare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif len(sys.argv) == 5 and sys.argv[1] == 'gate':
        gate(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
    else:
        raise SystemExit('invalid minimum controller command')
