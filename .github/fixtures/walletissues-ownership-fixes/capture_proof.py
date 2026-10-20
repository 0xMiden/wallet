import ast
import hashlib
import importlib
import inspect
import json
import multiprocessing
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys


FIXTURES = Path(__file__).resolve().parent
OUTPUT = Path(os.environ['OWNERSHIP_RESULTS'])
WORKFLOW = '.github/workflows/walletissues-ownership-fixes.yml'
MODULES = ('unittest', 'unittest.case', 'unittest.suite', 'unittest.runner', 'unittest.result',
           'unittest.loader', 'unittest.mock', 'multiprocessing', 'multiprocessing.context',
           'multiprocessing.process', 'multiprocessing.spawn', 'multiprocessing.reduction',
           'multiprocessing.util', 'multiprocessing.popen_fork', 'multiprocessing.popen_spawn_posix',
           'multiprocessing.forkserver', 'multiprocessing.popen_forkserver', 'multiprocessing.queues',
           'multiprocessing.synchronize', 'multiprocessing.connection', 'multiprocessing.resource_tracker')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=FIXTURES,
                                   env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def dump(name, data):
    (OUTPUT / name).write_text(json.dumps(data, sort_keys=True, indent=2) + '\n')


def capture(label):
    root = Path(git('rev-parse', '--show-toplevel').decode().strip())
    entries = {}
    tree = git('ls-tree', '--full-tree', '-rz', 'HEAD')
    for item in tree.split(b'\0'):
        if item:
            meta, name = item.split(b'\t', 1)
            entries[name.decode()] = meta.decode().split()
    status = git('status', '--porcelain=v1')
    index = Path(git('rev-parse', '--git-path', 'index').decode().strip())
    if not index.is_absolute():
        index = FIXTURES / index
    index_bytes = index.read_bytes()
    index_stage = git('ls-files', '--stage', '--full-name', '-z', '--', ':/')
    commit = git('cat-file', 'commit', 'HEAD')
    parents = [line[7:] for line in commit.decode().split('\n\n', 1)[0].splitlines()
               if line.startswith('parent ')]
    assert len(parents) == 1
    raw = {'commit.raw': commit, 'ls-tree.bin': tree, 'index.bin': index_bytes,
           'index-stage.bin': index_stage, 'status.txt': status}
    for name, content in raw.items():
        (OUTPUT / (label + '.' + name)).write_bytes(content)
    subjects = {}
    for path in sorted([*FIXTURES.rglob('*.py'), root / WORKFLOW]):
        relative = str(path.relative_to(root))
        mode = path.lstat().st_mode
        assert stat.S_ISREG(mode) and not path.is_symlink()
        content = path.read_bytes()
        entry = entries[relative]
        blob = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
        assert entry[1] == 'blob' and entry[2] == blob
        assert bool(mode & 0o111) == (entry[0] == '100755')
        subjects[relative] = {'bytes': len(content), 'sha256': digest(content),
                              'physical_mode': oct(stat.S_IMODE(mode)), 'kind': 'regular',
                              'git_entry': entry}
        flattened = relative.replace('/', '--')
        (OUTPUT / (label + '.source.' + flattened)).write_bytes(content)
    assert len(subjects) == 9
    cases = []
    for filename in ('test_ledger.py', 'test_ownership.py'):
        parsed = ast.parse((FIXTURES / filename).read_text(), filename=filename)
        for cls in parsed.body:
            if isinstance(cls, ast.ClassDef):
                cases.extend(Path(filename).stem + '.' + cls.name + '.' + method.name
                             for method in cls.body if isinstance(method, ast.FunctionDef)
                             and method.name.startswith('test_'))
    assert len(cases) == len(set(cases)) == 51
    modules = {}
    for name in MODULES:
        module = importlib.import_module(name)
        source = Path(inspect.getsourcefile(module))
        assert source.is_file()
        content = source.read_bytes()
        destination = label + '.stdlib.' + name.replace('.', '-') + '.py'
        (OUTPUT / destination).write_bytes(content)
        modules[name] = {'module_file': module.__file__, 'source': str(source), 'bytes': len(content),
                         'sha256': digest(content), 'mode': oct(stat.S_IMODE(source.stat().st_mode)),
                         'artifact': destination}
    executable = Path(sys.executable).resolve()
    runtime = {'sys_platform': sys.platform, 'platform': platform.platform(), 'python': sys.version,
               'executable': str(executable), 'executable_sha256': digest(executable.read_bytes()),
               'start_method': multiprocessing.get_start_method(),
               'available_start_methods': multiprocessing.get_all_start_methods(), 'stdlib': modules}
    dump(label + '.snapshot.json', {'head': git('rev-parse', 'HEAD').decode().strip(),
         'tree': git('rev-parse', 'HEAD^{tree}').decode().strip(), 'parents': parents,
         'source': subjects, 'registered': sorted(cases), 'runtime': runtime,
         'index_sha256': digest(index_bytes), 'index_stage_sha256': digest(index_stage),
         'git_entry_map_sha256': digest(tree), 'status': status.decode()})


def validate():
    report = {'status': 'NOT_ACCEPTED'}
    try:
        before = json.loads((OUTPUT / 'before.snapshot.json').read_text())
        after = json.loads((OUTPUT / 'after.snapshot.json').read_text())
        for key in ('head', 'tree', 'parents', 'source', 'registered', 'index_sha256',
                    'index_stage_sha256', 'git_entry_map_sha256', 'status'):
            assert before[key] == after[key], key
        assert not before['status'] and before['head'] == os.environ['GITHUB_SHA']
        for name in ('commit.raw', 'ls-tree.bin', 'index.bin', 'index-stage.bin', 'status.txt'):
            assert (OUTPUT / ('before.' + name)).read_bytes() == (OUTPUT / ('after.' + name)).read_bytes()
        for name in MODULES:
            old = before['runtime']['stdlib'][name]
            new = after['runtime']['stdlib'][name]
            assert {k: v for k, v in old.items() if k != 'artifact'} == {k: v for k, v in new.items() if k != 'artifact'}
            assert (OUTPUT / old['artifact']).read_bytes() == (OUTPUT / new['artifact']).read_bytes()
        for key in ('python', 'executable', 'executable_sha256', 'sys_platform', 'start_method'):
            assert before['runtime'][key] == after['runtime'][key]
        if before['runtime']['sys_platform'] == 'darwin':
            assert before['runtime']['start_method'] == 'spawn'
        else:
            assert before['runtime']['sys_platform'] == 'linux'
        results = json.loads((OUTPUT / 'results.json').read_text())
        assert sorted(results['started']) == sorted(results['passed']) == before['registered']
        assert results['tests_run'] == len(set(results['started'])) == 51
        for key in ('failures', 'errors', 'skipped', 'expected_failures', 'unexpected_successes'):
            assert results[key] == []
        assert results['commit'] == before['head'] and results['run_id'] == os.environ['GITHUB_RUN_ID']
        assert set(results['source_sha256']) == {
            'ledger.py', 'test_ledger.py', 'test_ownership.py', 'run_tests.py',
            'run_sensitivity.py', 'run_control_sensitivity.py', 'capture_proof.py'}
        for name, sha in results['source_sha256'].items():
            assert digest((FIXTURES / name).read_bytes()) == sha
        assert results['fake_gh_get_exit'] == 0 and results['fake_gh_non_get_exit'] == 17
        for name in ('exits.txt', 'sensitivity-exits.txt', 'control-sensitivity-exits.txt'):
            assert (OUTPUT / name).read_text() == 'python=0\ntee=0\n'
        f001 = json.loads((OUTPUT / 'sensitivity.json').read_text())
        assert f001['status'] == 'EXACT_PRIVATE_IGNORED_COMMAND_OLD_NEW_SENSITIVITY'
        assert [(x['label'], x['exit_code']) for x in f001['cases']] == [
            ('control-old', 0), ('control-new', 0), ('mutant-old', 0), ('mutant-new', 1)]
        controls = json.loads((OUTPUT / 'control-sensitivity.json').read_text())
        assert controls['status'] == 'EXACT_PRIVATE_IMPORT_AND_INVERSE_ADMISSION_SENSITIVITY'
        assert [(x['label'], x['exit_code']) for x in controls['cases']] == [
            ('import-control', 0), ('import-mutant', 1), ('controller-control', 0), ('controller-mutant', 1)]
        report = {'status': 'EXACT_FIXED51_AND_PRIVATE_SENSITIVITIES', 'head': before['head'],
                  'tree': before['tree'], 'parents': before['parents'], 'registered': 51,
                  'source_files': len(before['source']), 'stdlib_modules': len(MODULES),
                  'platform': before['runtime']['sys_platform'], 'python': before['runtime']['python'],
                  'start_method': before['runtime']['start_method'],
                  'limits': 'Scoped helper/controller CI proof only; no installed/live execution or full physical wallet-source certificate.'}
    finally:
        dump('validation.json', report)


def seal():
    files = {}
    for path in sorted(OUTPUT.rglob('*')):
        if path.is_file() and path.name != 'hash-manifest.json':
            content = path.read_bytes()
            files[str(path.relative_to(OUTPUT))] = {'bytes': len(content), 'sha256': digest(content)}
    dump('hash-manifest.json', {'files': files, 'self_excluded': 'hash-manifest.json'})


if __name__ == '__main__':
    if sys.argv[1] in ('before', 'after'):
        capture(sys.argv[1])
    elif sys.argv[1] == 'validate':
        validate()
    elif sys.argv[1] == 'seal':
        seal()
    else:
        raise SystemExit('unknown proof command')
