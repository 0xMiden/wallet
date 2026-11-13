#!/usr/bin/env python3
"""CI-only real Git/TypeScript facts regressions; never imports wallet code.

Mutation predictions (not executed here):
* routing_reuses_intermediate_work: removing either local reuse fails its own
  count subtests, with nonempty barrel/path witnesses (original034 is RED).
* facts_match_reference_for_aliases: omitting currentName from the reference
  cache key changes alias routes/ranges and fails complete facts equality.
* facts_match_reference_for_cycles_and_unresolved: caching away cycle/missing
  route flags or changing traversal order fails complete facts equality.
* config_selection_matches_reference: substituting the five-argument closure
  selection for two-argument routing selection changes mapped route evidence.
* facts_cache_is_invocation_local: retaining bodies/configs across invocations
  leaves stale routes after the same paths change and fails snapshot equality.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


def serialized(value):
    # Preserve every field and list order; compare actual bytes, not digests.
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def load_runtime(directory, identity):
    compiler = directory.resolve() / 'scripts/rev-evidence.py'
    spec = importlib.util.spec_from_file_location(identity, compiler)
    module = importlib.util.module_from_spec(spec)
    sys.modules[identity] = module
    with patch.object(sys, 'path', sys.path[:]):
        spec.loader.exec_module(module)
    return module


class GitFixture:
    def __init__(self, directory, files):
        self.directory = directory
        self.root = directory / 'repo'
        self.root.mkdir()
        self.files = dict(files)
        self.git('init', '--quiet')
        self.write(files)
        self.base = self.commit('base')

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                   GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                   LC_ALL='C')
        return subprocess.check_output(
            ['git', '-C', str(self.root), '-c', 'commit.gpgsign=false',
             '-c', 'core.hooksPath=/dev/null', *args], env=env).decode().strip()

    def write(self, files):
        self.files.update(files)
        for name, body in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding='utf-8')

    def commit(self, message):
        self.git('add', '--all')
        self.git('commit', '--quiet', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def session(self, identity):
        session = self.directory / identity
        session.mkdir()
        values = dict(REV_ROOT=str(self.root), REV_BASE=self.base, REV_SCOPE='branch')
        (session / 'scope.env').write_text(''.join(
            f'{key}={shlex.quote(value)}\n' for key, value in values.items()))
        return session


def graph():
    return {
        'defs/a.ts': 'export function shared() { return 1; }\n',
        'defs/b.ts': 'export function shared() { return 2; }\n',
        'barrel.ts': '// fixture:barrel.ts\nexport * from "./defs/a";\nexport * from "./defs/b";\n',
        'consumer.ts': 'import { shared } from "./barrel";\nexport const result = shared();\n',
        'tsconfig.json': '{"include":["**/*.ts"]}\n',
    }


class FactsRoutingReuseTests(unittest.TestCase):
    candidate = None
    reference = None

    def fixture(self, files):
        temporary = tempfile.TemporaryDirectory(prefix='facts-routing-')
        self.addCleanup(temporary.cleanup)
        fixture = GitFixture(Path(temporary.name).resolve(), files)
        fixture.write({
            'defs/a.ts': files['defs/a.ts'].replace('return 1;', 'return 11;'),
            'defs/b.ts': files['defs/b.ts'].replace('return 2;', 'return 22;'),
        })
        fixture.head = fixture.commit('changed definitions')
        return fixture

    @contextmanager
    def observe(self, module, fixture):
        configs = Counter()
        references = Counter()
        config_values = defaultdict(dict)
        reference_values = {}
        bodies = {tuple(body.rstrip('\n').split('\n')): path
                  for path, body in fixture.files.items() if path.endswith('.ts')}
        self.assertEqual(len(bodies), sum(path.endswith('.ts') for path in fixture.files),
                         'source bodies must uniquely identify fixture paths')
        original_configs = module.source_configs_for_path
        original_references = module.ts_reexport_references

        def config_spy(*args, **kwargs):
            value = original_configs(*args, **kwargs)
            if len(args) == 2 and not kwargs:
                configs[args[0]] += 1
                config_values[args[0]]['routing'] = serialized(value)
            elif len(args) == 5 and not kwargs:
                config_values[args[0]]['closure'] = serialized(value)
            return value

        def reference_spy(lines, name, *args, **kwargs):
            path = bodies[tuple(lines)]
            key = (path, name)
            references[key] += 1
            value = original_references(lines, name, *args, **kwargs)
            reference_values[key] = serialized(value)
            return value

        with patch.object(module, 'source_configs_for_path', config_spy), \
                patch.object(module, 'ts_reexport_references', reference_spy):
            yield configs, references, config_values, reference_values

    def prepare(self, module, fixture, identity):
        repo = module.Repository(fixture.session(identity))
        self.assertEqual(repo.selected, '.')
        return repo

    def facts(self, module, repo, base, head):
        base_tree, tree = repo.tree(base), repo.tree(head)
        _, hunks, categories, _ = repo.changes(base_tree, tree)
        self.assertTrue(hunks)
        value = module.facts(repo, tree, hunks, categories, base_tree)
        self.assertTrue(value['symbols'])
        self.assertTrue(value['dependencies'])
        return value

    def compare(self, fixture):
        candidate_repo = self.prepare(self.candidate, fixture, 'candidate')
        reference_repo = self.prepare(self.reference, fixture, 'reference')
        with self.observe(self.candidate, fixture) as observed:
            candidate = self.facts(self.candidate, candidate_repo, fixture.base, fixture.head)
        reference = self.facts(self.reference, reference_repo, fixture.base, fixture.head)
        self.assertEqual(serialized(candidate), serialized(reference))
        self.assertTrue(observed[0], 'routing must be exercised')
        self.assertTrue(observed[1], 're-export references must be exercised')
        self.assertTrue(reference['unresolved_imports'], 'nonempty route obligations required')
        return reference, observed

    def test_routing_reuses_intermediate_work(self):
        fixture = self.fixture(graph())
        repo = self.prepare(self.candidate, fixture, 'counts')
        with self.observe(self.candidate, fixture) as observed:
            value = self.facts(self.candidate, repo, fixture.base, fixture.head)
        configs, references, _, _ = observed
        self.assertTrue(value['unresolved_imports'])
        # No count assertions inside the witness guards: both count groups must run on RED.
        self.assertTrue(configs)
        self.assertTrue(references)
        self.assertIn('barrel.ts', configs)
        self.assertIn(('barrel.ts', 'shared'), references)
        for path, count in sorted(configs.items()):
            with self.subTest(group='routing-config', path=path):
                self.assertEqual(count, 1)
        for key, count in sorted(references.items()):
            with self.subTest(group='reexport-references', key=key):
                self.assertEqual(count, 1)

    def test_facts_match_reference_for_aliases(self):
        files = graph()
        files['defs/a.ts'] += 'export function other() { return 3; }\n'
        files['barrel.ts'] = ('// fixture:barrel.ts aliases\n'
                              'export { shared as first, other as second } from "./defs/a";\n'
                              'export { shared as third } from "./defs/b";\n')
        files['consumer.ts'] = ('import { first as localOne, second as localTwo, third } from "./barrel";\n'
                                'export const result = localOne() + localTwo() + third();\n')
        fixture = self.fixture(files)
        fixture.write({'defs/a.ts': fixture.files['defs/a.ts'].replace('return 3;', 'return 33;')})
        fixture.head = fixture.commit('change other name')
        reference, observed = self.compare(fixture)
        values = observed[3]
        self.assertIn(('barrel.ts', 'first'), values)
        self.assertIn(('barrel.ts', 'second'), values)
        self.assertNotEqual(values[('barrel.ts', 'first')], values[('barrel.ts', 'second')])
        self.assertTrue(any(row['local_name'] == 'localOne' for row in reference['unresolved_imports']))

    def test_facts_match_reference_for_cycles_and_unresolved(self):
        files = graph()
        files['barrel.ts'] += 'export * from "./cycle";\nexport * from "./missing";\n'
        files['cycle.ts'] = '// fixture:cycle.ts\nexport * from "./barrel";\n'
        reference, observed = self.compare(self.fixture(files))
        self.assertIn(('cycle.ts', 'shared'), observed[1])
        self.assertTrue(any(row['candidate_search_ranges'] for row in reference['unresolved_imports']))
        self.assertTrue(any(row['target'] == 'cycle.ts' for row in reference['dependencies']))

    def test_config_selection_matches_reference(self):
        files = graph()
        files['tsconfig.base.json'] = ('{"files":[],"compilerOptions":{"baseUrl":".",'
                                       '"paths":{"@defs/*":["defs/*"]}}}\n')
        files['tsconfig.json'] = '{"extends":"./tsconfig.base.json","files":["consumer.ts"]}\n'
        files['tsconfig.overlap.json'] = ('{"extends":"./tsconfig.base.json",'
                                          '"files":["consumer.ts"]}\n')
        files['barrel.ts'] = ('// fixture:barrel.ts config closure\n'
                              'export * from "@defs/a";\nexport * from "@defs/b";\n')
        reference, observed = self.compare(self.fixture(files))
        selections = observed[2]['barrel.ts']
        self.assertIn('routing', selections)
        self.assertIn('closure', selections)
        self.assertNotEqual(selections['routing'], selections['closure'],
                            'routing must not borrow import-closure configs')
        self.assertEqual(json.loads(selections['routing']), [[], False])
        closure_configs, ambiguous = json.loads(selections['closure'])
        self.assertTrue(ambiguous)
        self.assertIn('tsconfig.base.json', {row['path'] for row in closure_configs})
        self.assertTrue(any(row['config_ranges'] for row in reference['unresolved_imports']))

    def test_facts_cache_is_invocation_local(self):
        fixture = self.fixture(graph())
        candidate_repo = self.prepare(self.candidate, fixture, 'candidate-isolation')
        reference_repo = self.prepare(self.reference, fixture, 'reference-isolation')
        witnesses = []
        for snapshot in range(3):
            if snapshot == 1:
                fixture.write({
                    'barrel.ts': '// fixture:barrel.ts snapshot 2\nexport * from "./defs/b";\n',
                    'tsconfig.json': '{"files":["consumer.ts"]}\n',
                })
                fixture.head = fixture.commit('same paths new route and config')
            elif snapshot == 2:
                # A second repository with identical paths must not inherit the first's cache.
                fixture = self.fixture(graph())
                candidate_repo = self.prepare(self.candidate, fixture, 'candidate-other-repo')
                reference_repo = self.prepare(self.reference, fixture, 'reference-other-repo')
            with self.subTest(snapshot=snapshot):
                candidate = self.facts(self.candidate, candidate_repo, fixture.base, fixture.head)
                reference = self.facts(self.reference, reference_repo, fixture.base, fixture.head)
                self.assertEqual(serialized(candidate), serialized(reference))
                self.assertTrue(reference['unresolved_imports'])
                route_witness = sorted({
                    (row['path'], row['line_start'], row['line_end'], row['name'])
                    for obligation in reference['unresolved_imports']
                    for row in obligation['candidate_route_symbols']
                })
                self.assertTrue(route_witness, 'reference must contain actual barrel routes')
                witnesses.append(route_witness)
                # Repeat on exactly the same immutable tree as well as changing snapshots.
                repeated = self.facts(self.candidate, candidate_repo, fixture.base, fixture.head)
                self.assertEqual(serialized(repeated), serialized(reference))
        self.assertEqual(len(witnesses), 3)
        self.assertNotEqual(witnesses[0], witnesses[1],
                            'reference route ranges must change, not merely snapshot tree IDs')
        self.assertEqual(witnesses[0], witnesses[2], 'fresh repository restores the original witness')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--reference-runtime', type=Path, required=True)
    args = parser.parse_args()
    if args.runtime.resolve() == args.reference_runtime.resolve():
        parser.error('candidate and reference must be separate runtime copies')
    FactsRoutingReuseTests.candidate = load_runtime(args.runtime, 'facts_routing_candidate')
    FactsRoutingReuseTests.reference = load_runtime(args.reference_runtime, 'facts_routing_reference')
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(FactsRoutingReuseTests)
    if suite.countTestCases() != 5:
        raise RuntimeError('expected exactly five real regression tests')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
