#!/usr/bin/env python3
"""Noncertifying CI-only profile of the frozen compiler's new facts."""
import argparse
import cProfile
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pstats
import shlex
import subprocess
import tempfile
import time

ARCHIVE_SHA256 = 'dba8a1b618194daf7e6c0581b834511cd49cd3af5f278e001fedb4c95b792912'
COMPILER_SHA256 = '034c153a8b135e0b5492b88402a1f9347bfa83de01d835604ea9759c249f9620'
SUBJECT_HEAD = 'aee4787ec9c24d786092357762ce1a643856acd1'
SUBJECT_BASE = '5278fe5dc659a3f81bce97d118f2c9fd53001cdd'
CHANGED_PATHS = sorted([
    '.github/workflows/pr.yml',
    'CHANGELOG.md',
    'playwright.token-detail-visual.config.ts',
    'playwright/visual/token-detail/fixture.tsx',
    'playwright/visual/token-detail/history.fixture.tsx',
    'playwright/visual/token-detail/index.html',
    'playwright/visual/token-detail/main.tsx',
    'playwright/visual/token-detail/native-faucet.fixture.ts',
    'playwright/visual/token-detail/visual.spec.ts',
    'playwright/visual/token-detail/vite.config.mts',
    'src/app/pages/TokenDetail.test.tsx',
    'src/app/pages/TokenDetail.tsx',
])


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(repo, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_LITERAL_PATHSPECS='1', LC_ALL='C')
    return subprocess.check_output(['git', '-C', str(repo), *args], env=env).decode().strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not __debug__:
        raise RuntimeError('input assertions must be enabled')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    profiler = cProfile.Profile()
    started = time.monotonic()
    facts_started = None
    record = {
        'certifying': False,
        'measurement': 'new facts only; not full repair or coverage',
        'subject_head_expected': SUBJECT_HEAD,
        'subject_base': SUBJECT_BASE,
        'expected_changed_paths': CHANGED_PATHS,
        'archive_sha256_expected': ARCHIVE_SHA256,
        'compiler_sha256_expected': COMPILER_SHA256,
        'deadline_seconds': 600,
        'completed': False,
        'timed_out': False,
        'error': None,
        'status': 'error',
        'compiler_imported': False,
        'profile_started': False,
    }
    try:
        compiler = args.runtime.resolve() / 'scripts/rev-evidence.py'
        record['compiler_sha256'] = sha256(compiler)
        assert record['compiler_sha256'] == COMPILER_SHA256, 'compiler SHA256 mismatch'
        helper = Path(__file__).resolve()
        record['helper_sha256'] = sha256(helper)
        record['qa_source_head'] = git(helper.parents[2], 'rev-parse', 'HEAD')
        record['archive_sha256'] = sha256(helper.parent / '2027-timeout-origin-runtime.zip')
        assert record['archive_sha256'] == ARCHIVE_SHA256, 'archive SHA256 mismatch'
        repo_path = args.repo.resolve()
        record['subject_head'] = git(repo_path, 'rev-parse', 'HEAD')
        assert record['subject_head'] == SUBJECT_HEAD, 'subject HEAD mismatch'
        git(repo_path, 'merge-base', '--is-ancestor', SUBJECT_BASE, SUBJECT_HEAD)
        assert not git(repo_path, 'status', '--porcelain=v1', '--untracked-files=all'), 'subject worktree dirty'
        changed = git(repo_path, 'diff', '--name-only', '--no-renames', '-z', SUBJECT_BASE, SUBJECT_HEAD)
        record['changed_paths'] = sorted(path for path in changed.split('\0') if path)
        assert record['changed_paths'] == CHANGED_PATHS, 'subject changed paths mismatch'
        with tempfile.TemporaryDirectory(prefix='repair-facts-session-') as directory:
            session = Path(directory).resolve()
            values = {'REV_ROOT': str(repo_path), 'REV_BASE': SUBJECT_BASE, 'REV_SCOPE': 'branch'}
            (session / 'scope.env').write_text(''.join(
                f'{key}={shlex.quote(value)}\n' for key, value in values.items()))
            spec = importlib.util.spec_from_file_location('repair_facts_compiler', compiler)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            record['compiler_imported'] = True
            repo = module.Repository(session)
            assert repo.selected == '.', 'profile must use full branch scope'
            base_tree = repo.tree(SUBJECT_BASE)
            tree = repo.tree(SUBJECT_HEAD)
            record.update(base_tree=base_tree, subject_tree=tree)
            _, hunks, categories, _ = repo.changes(base_tree, tree)
            assert sorted(categories) == CHANGED_PATHS, 'compiler changed paths mismatch'
            # shortcut: measures new facts, not parent/repeated-render reconstruction; extend only if measurement requires it.
            try:
                module.PREPARE_PROGRESS['stage'] = 'facts'
                with module.prepare_deadline(600):
                    facts_started = time.monotonic()
                    record['profile_started'] = True
                    profiler.enable()
                    module.facts(repo, tree, hunks, categories, base_tree)
                record.update(completed=True, status='completed')
            except module.PrepareTimeout as error:
                record.update(timed_out=True, status='partial_timeout', error=str(error))
            finally:
                profiler.disable()
                if facts_started is not None:
                    record['facts_elapsed_seconds'] = time.monotonic() - facts_started
    except BaseException as error:
        record.update(status='error', error=f'{type(error).__name__}: {error}')
        raise
    finally:
        profiler.disable()
        record['elapsed_seconds'] = time.monotonic() - started
        profiler.dump_stats(str(output / 'facts-profile.pstats'))
        with (output / 'facts-profile.txt').open('w') as stream:
            stream.write(f"Noncertifying diagnostic: {record['status']}\n")
            stream.write('No full-repair, receipt, or scope-coverage claim.\n')
            if record['profile_started']:
                pstats.Stats(profiler, stream=stream).sort_stats('cumulative').print_stats()
            else:
                stream.write('Input/setup rejection: facts profiling never started.\n')
        (output / 'facts-profile.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
        print(json.dumps(record, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
