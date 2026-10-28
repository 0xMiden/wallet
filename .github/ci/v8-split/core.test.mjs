import test from 'node:test';
import assert from 'node:assert/strict';
import { planSplit, verifyPlan, verifyResults } from './core.mjs';

const sha = n => String(n).repeat(40);
const digest = n => String(n).repeat(64);
const special = ['src/lib/miden/back/miden-client-proxy.test.ts', 'src/offscreen/main.test.ts'];
const files = [...special, 'src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
const tests = (count, prefix) => Array.from({ length: count }, (_, i) => ({ fullName: `${prefix} ${i}`, status: 'passed' }));
const fixture = () => ({ source: sha(1), tree: sha(2), sdk: sha(3), configSha256: digest(1), mergeSha256: digest(2), addon: { verified: true, source: sha(1), sdk: sha(3), rustSdk: sha(4), sha256: digest(3), cargoLockSha256: digest(4), runId: 1, artifactId: 2, features: 'nodejs', noDefaultFeatures: true, locked: true, conclusion: 'success' }, files, denominator: ['src/a.ts', 'src/b.ts'], suites: files.map((file, i) => ({ file, blob: sha(5), tests: tests(i === 0 ? 30 : 2, file) })) });
function artifacts(plan) {
  const make = (id, suites) => ({ id, source: plan.source, tree: plan.tree, sdk: plan.sdk, addonSha256: plan.addon.sha256, planSha256: plan.planSha256, success: true, failed: 0, runtimeErrors: 0, suites, coverageFiles: plan.denominator, coverageSha256: digest(5) });
  return [...plan.general.map(g => make(g.id, g.files.map(file => ({ file, tests: plan.suites.find(s => s.file === file).tests })))), ...plan.partitions.map(p => make(p.id, [{ file: p.file, tests: plan.suites.find(s => s.file === p.file).tests.map(t => ({ ...t, status: p.tests.some(x => x.fullName === t.fullName) ? t.status : 'pending' })) }]))];
}

test('partitions cover titles with duplicate groups and bind all artifacts', () => {
  const x = fixture(); x.suites[0].tests.push({ ...x.suites[0].tests[0] });
  const plan = planSplit(x); assert.equal(verifyPlan(plan), true); assert.equal(plan.partitions.filter(p => p.file === special[0]).length, 2); assert.equal(verifyResults(plan, artifacts(plan)).length, plan.general.length + plan.partitions.length);
});
test('rejects unavailable or wrong addon and oversized duplicate groups', () => {
  const x = fixture(); x.addon.verified = false; assert.throws(() => planSplit(x), /addon provenance/);
  const y = fixture(); y.suites[0].tests = Array.from({ length: 26 }, () => ({ fullName: 'same', status: 'passed' })); assert.throws(() => planSplit(y), /duplicate title/);
});
test('rejects missing shards, altered titles, source and denominator', () => {
  const plan = planSplit(fixture()); const good = artifacts(plan);
  assert.throws(() => verifyResults(plan, good.slice(1)), /missing or extra/);
  const source = structuredClone(good); source[0].source = sha(9); assert.throws(() => verifyResults(plan, source), /identity/);
  const coverage = structuredClone(good); coverage[0].coverageFiles.pop(); assert.throws(() => verifyResults(plan, coverage), /denominator/);
  const title = structuredClone(good); title[0].suites[0].tests[0].fullName += ' changed'; assert.throws(() => verifyResults(plan, title), /multiset/);
});
test('escapes title regex and rejects unexecuted partitions', () => {
  const x = fixture(); x.suites[0].tests[0].fullName = 'suite [a] (b).*'; const plan = planSplit(x);
  const p = plan.partitions.find(v => v.tests.some(t => t.fullName.includes('[a]'))); assert(new RegExp(p.pattern).test('suite [a] (b).*')); assert(!new RegExp(p.pattern).test('suite a b'));
  const bad = artifacts(plan); bad.find(a => a.id === p.id).suites[0].tests.find(t => t.fullName === 'suite [a] (b).*').status = 'pending'; assert.throws(() => verifyResults(plan, bad), /multiset/);
});
