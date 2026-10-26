import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const worker = 'services/feature-eligibility/worker.mjs';
const config = 'services/feature-eligibility/wrangler.jsonc';
const original = readFileSync(worker, 'utf8');
const settings = readFileSync(config, 'utf8');
const cases = [
  {
    name: 'caller rate state is shared across networks and survives caller object recreation',
    prediction: 'Routing each network separately resets the caller limit and permits a third request.',
    mutate: () => writeFileSync(worker, original.replace('`caller-v1:${caller}`', '`caller-v1:${caller}:${network}`'))
  },
  {
    name: 'caller cleanup expires local records without deleting the global paid-query budget',
    prediction: 'Skipping caller cleanup retains expired caller state after its alarm.',
    mutate: () => {
      const method = 'async alarm() {\n      await cleanup(this.storage);\n    }';
      const offset = original.lastIndexOf(method);
      assert.ok(offset >= 0);
      writeFileSync(worker, original.slice(0, offset) + original.slice(offset).replace(method, 'async alarm() {}'));
    }
  },
  {
    name: 'warm cache and per-caller rejection do not enter the global reservation object',
    prediction: 'Routing accepted requests back to the global object breaks cached eligibility and bypass isolation.',
    mutate: () => writeFileSync(worker, original.replace('env.CALLER_GUARD.get(env.CALLER_GUARD.idFromName', 'env.ELIGIBILITY_GUARD.get(env.ELIGIBILITY_GUARD.idFromName'))
  },
  {
    name: 'one caller storage queue cannot block another caller warm cache',
    prediction: 'Collapsing caller identities produces one object and removes caller storage isolation.',
    mutate: () => writeFileSync(worker, original.replace('`caller-v1:${caller}`', "'caller-v1:shared'"))
  },
  {
    name: 'all caller objects share the existing nearly exhausted persisted global budget',
    prediction: 'Removing the cap check permits more than one paid call after count9999.',
    mutate: () => writeFileSync(worker, original.replace('budget.count >= limit', 'false'))
  },
  {
    name: 'queued reservation expiry fails closed without starting a late paid lookup or retry',
    prediction: 'Removing authority expiry checks consumes a reservation after the absolute deadline.',
    mutate: () => writeFileSync(worker, original.replace('deadline <= now() ||', '').replace('if (day !== dayOf(now()) || deadline <= now()) return false;', 'if (day !== dayOf(now())) return false;'))
  },
  {
    name: 'readiness and requests fail closed when the caller namespace binding is unavailable',
    prediction: 'Ignoring caller binding readiness incorrectly marks a non-serving deployment healthy.',
    mutate: () => writeFileSync(worker, original.replace('env.CALLER_GUARD &&', ''))
  },
  {
    name: 'caller migration appends a class without recreating the original budget namespace',
    prediction: 'Replacing the historical migration class breaks preserved global storage identity.',
    mutate: () => {
      const value = JSON.parse(settings);
      value.migrations[0].new_sqlite_classes = ['RecreatedBudget'];
      writeFileSync(config, JSON.stringify(value));
    }
  }
];
function run(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return spawnSync(process.execPath, ['--test', `--test-name-pattern=^${escaped}$`, 'services/feature-eligibility/worker.test.mjs'], { encoding: 'utf8', timeout: 15_000 });
}
try {
  for (const item of cases) {
    writeFileSync(worker, original);
    writeFileSync(config, settings);
    const baseline = run(item.name);
    assert.equal(baseline.status, 0, `Baseline failed: ${item.name}\n${baseline.stdout}\n${baseline.stderr}`);
    assert.match(baseline.stdout, /# pass [1-9]/, 'Baseline selected no test');
    item.mutate();
    assert.ok(readFileSync(worker, 'utf8') !== original || readFileSync(config, 'utf8') !== settings, 'Mutation made no change');
    const result = run(item.name);
    assert.notEqual(result.status, 0, `Mutation survived: ${item.name}`);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_TEST_FAILURE.*exitCode/s, 'Mutation failed during setup');
    assert.match(result.stdout, /# fail [1-9]/, 'Mutation did not produce a functional failure');
    console.log(JSON.stringify({ test: item.name, prediction: item.prediction, baseline: 'pass', mutant: 'killed' }));
  }
} finally {
  writeFileSync(worker, original);
  writeFileSync(config, settings);
}
