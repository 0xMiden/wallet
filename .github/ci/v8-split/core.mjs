import { createHash } from 'node:crypto';

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = values => [...values].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const signature = records => sorted(records.map(item => JSON.stringify([item.fullName, item.status])));
const runnable = status => status === 'passed';
const allowed = new Set(['passed', 'pending', 'todo']);

export function planSplit({ source, tree, sdk, addon, files, suites, denominator, configSha256, mergeSha256, packageSetSha256, generalShards = 3 }) {
  for (const [key, value] of Object.entries({ source, tree, sdk })) requireValue(shaPattern.test(value), `invalid ${key}`);
  requireValue(hashPattern.test(configSha256) && hashPattern.test(mergeSha256) && hashPattern.test(packageSetSha256), 'invalid configuration binding');
  requireValue(addon && addon.verified === true && addon.sdk === sdk && addon.source === source, 'exact addon provenance unavailable');
  requireValue(hashPattern.test(addon.sha256) && hashPattern.test(addon.cargoLockSha256), 'missing addon or lock digest');
  requireValue(shaPattern.test(addon.sdkTree) && shaPattern.test(addon.rustSdk) && shaPattern.test(addon.workflowSha) && hashPattern.test(addon.archiveSha256) && Number.isSafeInteger(addon.runId) && addon.runId > 0 && Number.isSafeInteger(addon.artifactId) && addon.artifactId > 0, 'invalid addon producer identity');
  requireValue(addon.features === 'nodejs' && addon.noDefaultFeatures === true && addon.locked === true && addon.conclusion === 'success', 'addon build configuration mismatch');
  requireValue(Number.isInteger(generalShards) && generalShards > 0, 'invalid general shard count');
  requireValue(Array.isArray(files) && files.length > 2 && new Set(files).size === files.length && files.every(x => typeof x === 'string' && x && !x.startsWith('/') && !x.includes('..')), 'invalid full test file inventory');
  requireValue(Array.isArray(denominator) && denominator.length > 0 && new Set(denominator).size === denominator.length && denominator.every(x => typeof x === 'string' && x && !x.startsWith('/') && !x.includes('..')), 'invalid coverage denominator');
  requireValue(Array.isArray(suites) && suites.length === files.length, 'missing baseline suites');
  const byFile = new Map();
  for (const suite of suites) {
    requireValue(files.includes(suite.file) && !byFile.has(suite.file) && shaPattern.test(suite.blob), 'suite source or inventory mismatch');
    requireValue(Array.isArray(suite.tests) && suite.tests.length > 0 && suite.tests.every(t => typeof t.fullName === 'string' && t.fullName && allowed.has(t.status)), 'invalid baseline title/status');
    byFile.set(suite.file, suite);
  }
  const special = ['src/lib/miden/back/miden-client-proxy.test.ts', 'src/offscreen/main.test.ts'];
  requireValue(special.every(file => byFile.has(file)), 'affected suite missing');
  const general = Array.from({ length: generalShards }, (_, i) => ({ id: `general-${i + 1}`, files: [], tests: [] }));
  for (const [index, file] of sorted(files.filter(file => !special.includes(file))).entries()) {
    const shard = general[index % generalShards]; shard.files.push(file); shard.tests.push(...byFile.get(file).tests.map(t => ({ file, ...t })));
  }
  requireValue(general.every(shard => shard.files.length && shard.tests.some(t => runnable(t.status))), 'empty general shard');
  const partitions = [];
  for (const file of special) {
    const groups = new Map();
    for (const item of byFile.get(file).tests) {
      const group = groups.get(item.fullName) ?? []; group.push(item); groups.set(item.fullName, group);
    }
    let batch = [];
    const emit = () => {
      if (!batch.length) return;
      const names = sorted(new Set(batch.map(t => t.fullName)));
      partitions.push({ id: `partition-${special.indexOf(file) + 1}-${partitions.filter(p => p.file === file).length + 1}`, file, pattern: `^(?:${names.map(escapeRegex).join('|')})$`, tests: batch });
      batch = [];
    };
    for (const name of sorted(groups.keys())) {
      const group = groups.get(name); requireValue(group.length <= 25, 'duplicate title group exceeds partition limit');
      if (batch.length + group.length > 25) emit();
      batch.push(...group);
    }
    emit();
    requireValue(equal(signature(partitions.filter(p => p.file === file).flatMap(p => p.tests)), signature(byFile.get(file).tests)), 'partition multiset mismatch');
  }
  const normalized = { schema: 1, source, tree, sdk, addon, configSha256, mergeSha256, packageSetSha256, files: sorted(files), denominator: sorted(denominator), suites: sorted(files).map(file => ({ file, blob: byFile.get(file).blob, tests: byFile.get(file).tests })), general, partitions, thresholds: { branches: 95, functions: 95, lines: 95, statements: 95 } };
  return { ...normalized, planSha256: hash(normalized) };
}

export function verifyPlan(plan) {
  const { planSha256, ...body } = plan; requireValue(hash(body) === planSha256, 'plan hash mismatch');
  const rebuilt = planSplit({ source: plan.source, tree: plan.tree, sdk: plan.sdk, addon: plan.addon, files: plan.files, suites: plan.suites, denominator: plan.denominator, configSha256: plan.configSha256, mergeSha256: plan.mergeSha256, packageSetSha256: plan.packageSetSha256, generalShards: plan.general.length });
  requireValue(equal(rebuilt, plan), 'noncanonical or altered plan'); return true;
}

export function verifyResults(plan, artifacts) {
  verifyPlan(plan);
  const targets = [...plan.general.map(g => ({ ...g, kind: 'general' })), ...plan.partitions.map(p => ({ ...p, kind: 'partition' }))];
  requireValue(Array.isArray(artifacts) && artifacts.length === targets.length, 'missing or extra artifact');
  const seen = new Set();
  for (const target of targets) {
    const matches = artifacts.filter(a => a.id === target.id); requireValue(matches.length === 1 && !seen.has(target.id), 'duplicate or missing shard'); seen.add(target.id);
    const a = matches[0];
    requireValue(a.source === plan.source && a.tree === plan.tree && a.sdk === plan.sdk && a.addonSha256 === plan.addon.sha256 && a.planSha256 === plan.planSha256, 'artifact identity mismatch');
    requireValue(a.success === true && a.failed === 0 && a.runtimeErrors === 0 && Array.isArray(a.suites), 'failed shard');
    const expectedFiles = target.kind === 'general' ? target.files : [target.file];
    requireValue(equal(sorted(a.suites.map(s => s.file)), sorted(expectedFiles)), 'executed file set mismatch');
    for (const suite of a.suites) {
      const expected = target.kind === 'general' ? plan.suites.find(s => s.file === suite.file).tests : target.tests;
      const selected = target.kind === 'general' ? suite.tests : suite.tests.filter(t => expected.some(x => x.fullName === t.fullName));
      requireValue(equal(signature(selected), signature(expected)), 'test title/status multiset mismatch');
      if (target.kind === 'partition') {
        const all = plan.suites.find(s => s.file === suite.file).tests;
        requireValue(equal(sorted(suite.tests.map(t => t.fullName)), sorted(all.map(t => t.fullName))), 'full suite collection changed');
        requireValue(suite.tests.filter(t => !expected.some(x => x.fullName === t.fullName)).every(t => t.status === 'pending'), 'unexpected outside selection');
      }
    }
    requireValue(a.suites.flatMap(s => s.tests).some(t => t.status === 'passed'), 'zero executed tests');
    requireValue(Array.isArray(a.coverageFiles) && equal(sorted(a.coverageFiles), plan.denominator), 'coverage denominator mismatch');
    requireValue(hashPattern.test(a.coverageSha256), 'missing coverage digest');
  }
  return targets.map(target => target.id);
}
