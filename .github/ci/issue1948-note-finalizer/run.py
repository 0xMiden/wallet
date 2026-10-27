#!/usr/bin/env python3
"""CI-only passive generated SDK finalizer evidence. No code execution from SDK."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('stage', choices=['bind', 'metadata', 'restore', 'extract', 'preserve'])
args = parser.parse_args()
if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Disposable CI execution only')
root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
controller = root / 'controller'
wallet = root / 'wallet'
payload = controller / '.github/ci/issue1948-note-finalizer'
cfg = json.loads((payload / 'inputs.json').read_text())
proof = root / 'proof'
proof.mkdir(exist_ok=True)
fixture = wallet / 'playwright/proofs/storage-recovery-auth'
dist = root / 'sdk-dist'
if len(cfg['wallet_source']) != 40 or any(c not in '0123456789abcdef' for c in cfg['wallet_source']):
    raise SystemExit('Controller must supply exact immutable wallet SHA before execution')


def save(name, value):
    (proof / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def command(argv, cwd=root, log=None, timeout=90):
    if log:
        with (proof / log).open('wb') as output:
            subprocess.run(argv, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=timeout, check=True)
        return ''
    return subprocess.check_output(argv, cwd=cwd, text=True, timeout=timeout).strip()


def api(endpoint, destination, raw=False, timeout=90):
    argv = ['gh', 'api'] + (['--allow-escape-sequences'] if raw else [])
    argv.append('repos/0xMiden/web-sdk/' + endpoint)
    with (proof / destination).open('wb') as out, (proof / (destination + '.stderr.log')).open('wb') as errors:
        subprocess.run(argv, stdout=out, stderr=errors, timeout=timeout, check=True)
    if not raw:
        return json.loads((proof / destination).read_text())


def dist_hashes():
    directory = dist
    return {p.relative_to(directory).as_posix(): sha(p) for p in sorted(directory.rglob('*')) if p.is_file()}


def verify_preserved():
    for name, expected in cfg['fixture_files'].items():
        if sha(wallet / name) != expected:
            raise RuntimeError('Frozen auth fixture hash changed: ' + name)
    actual = dist_hashes()
    if actual != cfg['dist_sha256'] or len(actual) != 42:
        raise RuntimeError('Original42 SDK dist files changed or closure differs')
    original = json.loads((proof / 'wallet-manifest-lock-before.json').read_text())
    if original != {p: sha(wallet / p) for p in ['package.json', 'yarn.lock']}:
        raise RuntimeError('Frozen wallet manifest/lock changed')
    save('dist-after.json', actual)
    save('preserved-source.json', {'fixture_files': cfg['fixture_files'], 'dist_files': len(actual), 'wallet_lock_unchanged': True})


if args.stage == 'bind':
    if command(['git', 'rev-parse', 'HEAD'], controller) != os.environ['GITHUB_SHA']:
        raise RuntimeError('Workflow checkout mismatch')
    if command(['git', 'show', '-s', '--format=%P', 'HEAD'], controller).split() != [cfg['wallet_source']]:
        raise RuntimeError('Workflow sole-parent binding mismatch')
    paths = command(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], controller).splitlines()
    if sorted(paths) != sorted(cfg['proof_paths']):
        raise RuntimeError('Unexpected source changes in proof commit')
    if (command(['git', 'rev-parse', 'HEAD'], wallet) != cfg['wallet_source']
            or command(['git', 'rev-parse', 'HEAD^{tree}'], wallet) != cfg['wallet_tree']):
        raise RuntimeError('Frozen wallet SHA/tree mismatch')
    if (wallet / 'node_modules').exists() or dist.exists():
        raise RuntimeError('Fresh dependency/dist directories required')
    for name, expected in cfg['fixture_files'].items():
        if sha(wallet / name) != expected:
            raise RuntimeError('Source-bound auth file mismatch: ' + name)
    declared = json.loads((fixture / 'inputs.json').read_text())
    if declared['dist_sha256'] != cfg['dist_sha256']:
        raise RuntimeError('Fixture SDK asset manifest differs')
    save('source-bindings.json', {'workflow_sha': os.environ['GITHUB_SHA'], 'wallet_source': cfg['wallet_source'],
         'wallet_tree': cfg['wallet_tree'], 'sdk_source': cfg['sdk_head'], 'sdk_tree': cfg['sdk_tree'],
         'fixture_files': cfg['fixture_files'], 'scope': cfg['scope']})
    save('wallet-manifest-lock-before.json', {p: sha(wallet / p) for p in ['package.json', 'yarn.lock']})
elif args.stage == 'metadata':
    sdk_run = api('actions/runs/' + str(cfg['producer_run']), 'sdk-run.json')
    artifact = api('actions/artifacts/' + str(cfg['artifact_id']), 'sdk-artifact.json')
    job = api('actions/jobs/' + str(cfg['producer_job_id']), 'producer-job.json')
    commit = api('git/commits/' + cfg['producer_checkout'], 'producer-commit.json')
    head = api('git/commits/' + cfg['sdk_head'], 'sdk-head.json')
    if (sdk_run['head_sha'] != cfg['sdk_head'] or sdk_run['conclusion'] != 'success'
            or sdk_run['run_attempt'] != cfg['producer_attempt'] or job['run_id'] != cfg['producer_run']
            or job['run_attempt'] != cfg['producer_attempt'] or job['conclusion'] != 'success'):
        raise RuntimeError('Successful SDK run/producer/attempt mismatch')
    if (commit['sha'] != cfg['producer_checkout'] or commit['tree']['sha'] != cfg['sdk_tree']
            or head['sha'] != cfg['sdk_head'] or head['tree']['sha'] != cfg['sdk_tree']
            or [p['sha'] for p in commit['parents']] != cfg['producer_parents']):
        raise RuntimeError('SDK head/actual producer tree binding mismatch')
    if (artifact['id'] != cfg['artifact_id'] or artifact['name'] != 'web-client-artifacts' or artifact['expired']
            or artifact['size_in_bytes'] != cfg['artifact_bytes'] or artifact['digest'] != cfg['artifact_digest']
            or artifact['workflow_run']['id'] != cfg['producer_run']
            or artifact['workflow_run']['head_sha'] != cfg['sdk_head']):
        raise RuntimeError('Exact SDK artifact identity mismatch')
    api('actions/jobs/' + str(cfg['producer_job_id']) + '/logs', 'producer.log', raw=True)
    if sha(proof / 'producer.log') != cfg['producer_log_sha256']:
        raise RuntimeError('Fresh producer/cache/profile receipt log differs')
    save('producer-receipt.json', cfg)
elif args.stage == 'restore':
    api('actions/artifacts/' + str(cfg['artifact_id']) + '/zip', 'sdk-dist.zip', raw=True, timeout=360)
    archive = proof / 'sdk-dist.zip'
    if archive.stat().st_size != cfg['artifact_bytes'] or 'sha256:' + sha(archive) != cfg['artifact_digest']:
        raise RuntimeError('Raw SDK ZIP size/digest mismatch')
    target = dist
    if target.exists():
        raise RuntimeError('Refuse to overlay SDK dist')
    entries = []
    names = set()
    total = 0
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            path = PurePosixPath(item.filename)
            normalized = path.as_posix().rstrip('/')
            if (path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename
                    or not path.parts or path.parts[0] not in ['st', 'mt']
                    or stat.S_ISLNK(item.external_attr >> 16) or normalized in names):
                raise RuntimeError('Unsafe SDK ZIP path')
            names.add(normalized)
            if not item.is_dir():
                if normalized not in cfg['dist_sha256']:
                    raise RuntimeError('SDK ZIP file absent from accepted42-file manifest')
                total += item.file_size
                if total > 2 * 1024**3:
                    raise RuntimeError('Bounded SDK ZIP extraction size exceeded')
                entries.append(item)
        if {item.filename for item in entries} != set(cfg['dist_sha256']):
            raise RuntimeError('SDK ZIP differs from exact accepted dist closure')
        target.mkdir()
        for item in entries:
            path = target / item.filename
            path.parent.mkdir(parents=True, exist_ok=True)
            with z.open(item) as source, path.open('wb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
    if dist_hashes() != cfg['dist_sha256']:
        raise RuntimeError('All42 SDK dist file hashes must match accepted assembly manifest')
    save('dist-before.json', dist_hashes())
    verify_preserved()
elif args.stage == 'preserve':
    verify_preserved()
elif args.stage == 'extract':
    verify_preserved()
    import re
    excerpts = []
    records = []
    try:
        cargo = sorted(name for name in cfg['dist_sha256'] if re.search(r'(?:^|/)Cargo[^/]*\.js$', name))
        if len(cargo) != 4:
            raise RuntimeError('Require four original ST/MT main/worker Cargo glue assets')
        def method(text, start, name):
            found = re.search(r'(?m)^\s*(?:static\s+)?' + re.escape(name) + r'\([^\n]*\)\s*\{', text[start:])
            if not found:
                raise RuntimeError('Generated NoteFile ownership method not found: ' + name)
            begin = start + found.start()
            opening = text.index('{', begin)
            depth = 1
            end = opening + 1
            while end < len(text) and depth and end - begin <= 2048:
                if text[end] == '{':
                    depth += 1
                elif text[end] == '}':
                    depth -= 1
                end += 1
            if depth:
                raise RuntimeError('Generated ownership block bound exceeded')
            return begin, end, text[begin:end].strip()
        for asset in cargo:
            js = (dist / asset).read_text()
            candidates = [(asset, js, 'generated-js')]
            mapping_path = asset + '.map'
            if mapping_path in cfg['dist_sha256']:
                mapping = json.loads((dist / mapping_path).read_text())
                for index, content in enumerate(mapping.get('sourcesContent', [])):
                    if isinstance(content, str) and '__wbg_notefile_free' in content and 'class NoteFile' in content:
                        candidates.append((mapping['sources'][index], content, 'embedded-generated-source-map'))
            selected = None
            for source_name, text, source_kind in candidates:
                klass = re.search(r'\bclass\s+NoteFile\s*\{', text)
                if not klass:
                    continue
                try:
                    wrap = method(text, klass.end(), '__wrap')
                    destroy = method(text, klass.end(), '__destroy_into_raw')
                    free = method(text, klass.end(), 'free')
                    registration = re.search(r'([\w$]+)\.register\s*\(', wrap[2])
                    if not registration:
                        continue
                    symbol = registration[1]
                    declaration = re.search(r'\b(?:const|let|var)\s+' + re.escape(symbol) + r'\s*=', text)
                    if not declaration:
                        continue
                    final_start = declaration.start()
                    free_at = text.find('__wbg_notefile_free', declaration.end(), declaration.end() + 1000)
                    if free_at < 0:
                        continue
                    final_end = text.find(';', free_at, free_at + 250)
                    if final_end < 0:
                        continue
                    final_end += 1
                    final = (final_start, final_end, text[final_start:final_end])
                    checks = {
                        'actual_finalization_registry_callback': bool(re.search(r'new\s+FinalizationRegistry\s*\([^;]*__wbg_notefile_free', final[2], re.S)),
                        'finalizer_owned_free_flag_one': bool(re.search(r'__wbg_notefile_free\s*\([^;]*,\s*1\s*\)', final[2])),
                        'finalizer_unsigned_pointer_conversion': bool(re.search(r'>>>\s*0', final[2])),
                        'wrapped_object_registered': bool(re.search(re.escape(symbol) + r'\.register\s*\(', wrap[2])),
                        'ownership_conversion_unregisters': bool(re.search(re.escape(symbol) + r'\.unregister\s*\(\s*this\s*\)', destroy[2])),
                        'ownership_conversion_clears_pointer': bool(re.search(r'this\.__wbg_ptr\s*=\s*0', destroy[2])),
                        'explicit_free_uses_ownership_conversion': '__destroy_into_raw(' in free[2],
                        'explicit_free_flag_zero': bool(re.search(r'__wbg_notefile_free\s*\([^;]*,\s*0\s*\)', free[2])),
                    }
                    if not all(value is True for value in checks.values()):
                        continue
                    snippets = []
                    for label, block in [('finalizer', final), ('wrap', wrap), ('ownership-conversion', destroy), ('explicit-free', free)]:
                        begin, end, body = block
                        line = text.count('\n', 0, begin) + 1
                        end_line = text.count('\n', 0, end) + 1
                        snippets.append({'label': label, 'line_start': line, 'line_end': end_line,
                                         'snippet_sha256': hashlib.sha256(body.encode()).hexdigest()})
                        excerpts.append(asset + ' | ' + source_name + ' | ' + label + ' | lines ' + str(line) + '-' + str(end_line) + '\n' + body + '\n')
                    selected = {'asset_path': asset, 'asset_sha256': cfg['dist_sha256'][asset],
                                'map_path': mapping_path if source_kind.endswith('map') else None,
                                'map_sha256': cfg['dist_sha256'].get(mapping_path) if source_kind.endswith('map') else None,
                                'source_path': source_name, 'source_kind': source_kind,
                                'source_sha256': hashlib.sha256(text.encode()).hexdigest(),
                                'finalizer_symbol': symbol, 'checks': checks, 'blocks': snippets}
                    break
                except RuntimeError:
                    continue
            if selected is None:
                raise RuntimeError('No complete supported generated NoteFile finalizer pattern in exact asset: ' + asset)
            records.append(selected)
        excerpt = '\n'.join(excerpts).encode()
        if len(excerpt) > 8192:
            raise RuntimeError('Static finalizer excerpt exceeds8192 bytes; refuse truncation')
        (proof / 'note-finalizer-excerpt.txt').write_bytes(excerpt)
        save('note-finalizer-evidence.json', {'status': 'generated-source-presence-only', 'assets': records,
             'excerpt_bytes': len(excerpt), 'excerpt_sha256': hashlib.sha256(excerpt).hexdigest(),
             'sdk_source': cfg['sdk_head'], 'sdk_tree': cfg['sdk_tree'], 'artifact_id': cfg['artifact_id'],
             'artifact_digest': cfg['artifact_digest'], 'producer_checkout': cfg['producer_checkout'],
             'profile': cfg['profile'], 'producer_effective_lock_hash': cfg['producer_effective_lock_hash'],
             'all_required_static_checks': True, 'sdk_executed': False, 'runtime_gc_guarantee': False})
    except Exception as error:
        save('extraction-failure.json', {'status': 'failed', 'error_class': type(error).__name__,
             'completed_assets': len(records), 'generated_finalizer_presence_proven': False})
        raise
    finally:
        verify_preserved()
