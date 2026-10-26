import assert from 'node:assert/strict';
import test from 'node:test';

let coordinator = {};
try {
  coordinator = await import('./release-plan.mjs');
} catch {}

const sourceSha = '1'.repeat(40);
const automationSha = '2'.repeat(40);
const ids = ['chrome-testnet', 'ios-testnet', 'android-testnet', 'chrome-devnet'];
const base = () => ({ schemaVersion: 1, releaseTag: 'v1.17.7', sourceSha, buildNumber: '19', targets: {} });
const plan = () => ({
  ...base(),
  targets: Object.fromEntries(
    ids.map((id, index) => [
      id,
      {
        producerRunId: String(100 + index),
        stateRunId: String(200 + index),
        ...(id === 'android-testnet' ? { editId: 'owned-edit', acknowledgement: 'submit-pending-play-changes' } : {})
      }
    ])
  )
});
const run = (intent, id = 301, overrides = {}) => ({
  id,
  run_attempt: 1,
  path: intent.workflowPath,
  event: 'workflow_dispatch',
  head_branch: 'main',
  head_sha: automationSha,
  repository: { full_name: '0xMiden/wallet' },
  head_repository: { full_name: '0xMiden/wallet' },
  display_title: `Store request ${intent.token}`,
  status: 'completed',
  conclusion: 'success',
  ...overrides
});
function harness(overrides = {}) {
  let saved;
  const calls = [];
  const records = new Map();
  let count = 300;
  return {
    calls,
    get saved() {
      return saved;
    },
    deps: {
      save: async checkpoint => {
        saved = structuredClone(checkpoint);
        calls.push(['save', saved]);
      },
      token: () => `token-${++count}`,
      dispatch: async intent => {
        calls.push(['dispatch', structuredClone(intent)]);
        records.set(intent.token, run(intent, count));
      },
      findRuns: async intent =>
        [...records.values()].filter(value => value.display_title === `Store request ${intent.token}`),
      watch: async id => {
        calls.push(['watch', id]);
      },
      readRun: async id => [...records.values()].find(value => value.id === id),
      ...overrides
    }
  };
}
function requireApi(name) {
  assert.equal(typeof coordinator[name], 'function', `missing ${name}`);
}

test('standard build uses four separate trusted producers in priority order', async () => {
  requireApi('executeReleaseStage');
  const h = harness();
  const checkpoint = await coordinator.executeReleaseStage(base(), { stage: 'build', ...h.deps });
  const dispatches = h.calls.filter(([name]) => name === 'dispatch').map(([, value]) => value);
  assert.deepEqual(
    dispatches.map(value => value.targetId),
    ids
  );
  for (const intent of dispatches) {
    assert.equal(intent.workflowPath, '.github/workflows/build-store-artifacts.yml');
    assert.equal(intent.inputs.source_sha, sourceSha);
    assert.equal(intent.inputs.release_tag, 'v1.17.7');
    assert.equal(intent.inputs.request_token, intent.token);
    assert.notEqual(intent.inputs.platform, 'all');
    const index = h.calls.findIndex(([name, value]) => name === 'dispatch' && value.token === intent.token);
    assert.equal(h.calls[index - 1][0], 'save');
    assert.equal(h.calls[index - 1][1].operations[`build:${intent.targetId}`].status, 'dispatch-started');
    assert.equal(checkpoint.operations[`build:${intent.targetId}`].status, 'success');
  }
  assert.deepEqual(
    dispatches.map(value => value.inputs.network),
    ['testnet', 'testnet', 'testnet', 'devnet']
  );
  assert.equal(dispatches[0].inputs.build_number, '');
  assert.equal(dispatches[1].inputs.build_number, '19');
});

test('a late Devnet failure preserves successful native evidence and never resends on resume', async () => {
  requireApi('executeReleaseStage');
  const h = harness();
  const originalRead = h.deps.readRun;
  h.deps.readRun = async id => {
    const value = await originalRead(id);
    return value.display_title.includes('304') ? { ...value, conclusion: 'failure' } : value;
  };
  await assert.rejects(coordinator.executeReleaseStage(base(), { stage: 'build', ...h.deps }), /failed/i);
  for (const id of ids.slice(0, 3)) {
    assert.equal(h.saved.operations[`build:${id}`].status, 'success');
    assert.ok(h.saved.operations[`build:${id}`].runId);
  }
  assert.equal(h.saved.operations['build:chrome-devnet'].status, 'failure');
  const second = harness({ dispatch: async () => assert.fail('must not resend any child') });
  second.deps.readRun = h.deps.readRun;
  await assert.rejects(
    coordinator.executeReleaseStage(base(), {
      stage: 'build',
      checkpoint: h.saved,
      ...second.deps
    }),
    /failed|inspection/i
  );
});

test('a lost dispatch response remains uncertain across restart and cannot send a duplicate', async () => {
  requireApi('executeReleaseStage');
  const h = harness({
    dispatch: async () => {
      throw new Error('connection closed after send');
    }
  });
  await assert.rejects(coordinator.executeReleaseStage(base(), { stage: 'build', ...h.deps }), /connection|uncertain/i);
  assert.equal(h.saved.operations['build:chrome-testnet'].status, 'dispatch-started');
  const second = harness({ dispatch: async () => assert.fail('duplicate dispatch'), findRuns: async () => [] });
  await assert.rejects(
    coordinator.executeReleaseStage(base(), {
      stage: 'build',
      checkpoint: h.saved,
      ...second.deps
    }),
    /uncertain|inspect|correlat/i
  );
});

test('correlation requires exact token and trusted workflow/main/event, not latest run or release-source head', () => {
  requireApi('matchDispatchedRun');
  const intent = {
    token: 'token-1',
    workflowPath: '.github/workflows/publish-stores.yml',
    inputs: { source_sha: sourceSha }
  };
  const good = run(intent);
  assert.deepEqual(coordinator.matchDispatchedRun([run({ ...intent, token: 'unrelated' }, 999), good], intent), good);
  assert.throws(() => coordinator.matchDispatchedRun([good, { ...good, id: 302 }], intent), /multiple|ambiguous/i);
  for (const change of [
    { path: '.github/workflows/untrusted.yml' },
    { event: 'push' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'someone/wallet' } },
    { display_title: 'Store request token-1 trailing' }
  ])
    assert.throws(() => coordinator.matchDispatchedRun([run(intent, 301, change)], intent), /trusted|correlat|match/i);
});

test('all-target submit preflights every explicit Android acknowledgement and caller-owned edit before any dispatch', async () => {
  requireApi('executeReleaseStage');
  for (const missing of ['editId', 'acknowledgement']) {
    const input = plan();
    delete input.targets['android-testnet'][missing];
    const h = harness();
    await assert.rejects(
      coordinator.executeReleaseStage(input, { stage: 'submit', ...h.deps }),
      /edit|acknowledgement/i
    );
    assert.equal(
      h.calls.some(([name]) => name === 'dispatch'),
      false
    );
  }
});

test('each standard publication stage routes the correct target-specific producer and state without a shared parent attestation', async () => {
  requireApi('executeReleaseStage');
  const h = harness();
  await coordinator.executeReleaseStage(plan(), { stage: 'submit', ...h.deps });
  const intents = h.calls.filter(([name]) => name === 'dispatch').map(([, value]) => value);
  assert.deepEqual(
    intents.map(value => value.targetId),
    ids
  );
  for (const [index, intent] of intents.entries()) {
    assert.equal(intent.workflowPath, '.github/workflows/publish-stores.yml');
    assert.equal(intent.inputs.producer_run_id, String(100 + index));
    assert.equal(intent.inputs.state_run_id, String(200 + index));
    assert.equal(intent.inputs.action, 'submit');
    assert.equal(intent.inputs.acknowledgement, index === 2 ? 'submit-pending-play-changes' : 'none');
    assert.equal(intent.inputs.edit_id, index === 2 ? 'owned-edit' : '');
  }
});

test('status does not consume mutation evidence and prepare/begin-edit are never silently broadened to all stores', () => {
  requireApi('validateReleasePlan');
  const validated = coordinator.validateReleasePlan(base(), { stage: 'status' });
  assert.deepEqual(
    validated.map(value => value.targetId),
    ids
  );
  for (const stage of ['prepare', 'begin-edit'])
    assert.throws(() => coordinator.validateReleasePlan(base(), { stage }), /individual|target/i);
  const android = base();
  android.targets['android-testnet'] = { acknowledgement: 'create-new-play-edit' };
  assert.equal(coordinator.validateReleasePlan(android, { stage: 'begin-edit', target: 'android-testnet' }).length, 1);
  assert.throws(() => coordinator.validateReleasePlan(base(), { stage: 'build', target: 'ios-devnet' }), /target/i);
});

test('resume rejects a changed source or changed child intent before dispatch', async () => {
  requireApi('executeReleaseStage');
  const h = harness();
  const checkpoint = await coordinator.executeReleaseStage(base(), {
    stage: 'build',
    target: 'chrome-testnet',
    ...h.deps
  });
  const next = harness({ dispatch: async () => assert.fail('must reject before dispatch') });
  const changed = base();
  changed.sourceSha = '3'.repeat(40);
  await assert.rejects(
    coordinator.executeReleaseStage(changed, { stage: 'build', checkpoint, ...next.deps }),
    /source|intent|release/i
  );
  const build = base();
  build.buildNumber = '20';
  const complete = harness();
  const previous = await coordinator.executeReleaseStage(base(), { stage: 'build', ...complete.deps });
  await assert.rejects(
    coordinator.executeReleaseStage(build, { stage: 'build', checkpoint: previous, ...next.deps }),
    /intent|build/i
  );
});

test('a watcher exit or pending child never establishes completed producer evidence', async () => {
  requireApi('executeReleaseStage');
  const h = harness();
  const originalRead = h.deps.readRun;
  h.deps.readRun = async id => ({ ...(await originalRead(id)), status: 'in_progress', conclusion: null });
  await assert.rejects(
    coordinator.executeReleaseStage(base(), { stage: 'build', ...h.deps }),
    /complete|terminal|pending/i
  );
  assert.notEqual(h.saved.operations['build:chrome-testnet'].status, 'success');
  assert.equal(h.calls.filter(([name]) => name === 'dispatch').length, 1);
});

test('plan rejects custom identities, unknown targets and malformed source before reaching workflows', () => {
  requireApi('validateReleasePlan');
  const extra = base();
  extra.targets['ios-devnet'] = {};
  assert.throws(() => coordinator.validateReleasePlan(extra, { stage: 'build' }), /target/i);
  const override = base();
  override.targets['chrome-devnet'] = { identity: 'another-item' };
  assert.throws(() => coordinator.validateReleasePlan(override, { stage: 'build' }), /identity|field/i);
  for (const source of ['main', '1'.repeat(39), null]) {
    assert.throws(
      () => coordinator.validateReleasePlan({ ...base(), sourceSha: source }, { stage: 'build' }),
      /source|SHA/i
    );
  }
});

test('iOS submission forwards exact optional release notes without adding them to other targets', () => {
  const notes = 'Clearer Guardian screens.\nSmoother mobile transitions.\tEnjoy Bread.';
  const input = plan();
  input.targets['ios-testnet'].releaseNotes = notes;
  const intents = coordinator.validateReleasePlan(input, { stage: 'submit' });
  assert.equal(intents.find(value => value.targetId === 'ios-testnet').inputs.release_notes, notes);
  assert.equal(intents.filter(value => value.targetId !== 'ios-testnet').some(value => 'release_notes' in value.inputs), false);
});

test('empty optional release notes are omitted and Unicode length uses code points', () => {
  const input = plan();
  input.targets['ios-testnet'].releaseNotes = '';
  assert.equal('release_notes' in coordinator.validateReleasePlan(input, { stage: 'submit', target: 'ios-testnet' })[0].inputs, false);
  input.targets['ios-testnet'].releaseNotes = '😀'.repeat(4000);
  assert.equal(coordinator.validateReleasePlan(input, { stage: 'submit', target: 'ios-testnet' })[0].inputs.release_notes, input.targets['ios-testnet'].releaseNotes);
  input.targets['ios-testnet'].releaseNotes += '😀';
  assert.throws(() => coordinator.validateReleasePlan(input, { stage: 'submit', target: 'ios-testnet' }), /release|notes|4000/i);
});

test('release notes are rejected outside iOS submit and invalid content prevents every child dispatch', async () => {
  for (const invalid of ['  \n', 'private\u0000text', 'private\u001btext', 'private\u0085text', 42, null]) {
    const input = plan();
    input.targets['ios-testnet'].releaseNotes = invalid;
    const h = harness();
    await assert.rejects(coordinator.executeReleaseStage(input, { stage: 'submit', ...h.deps }), /release|notes/i);
    assert.equal(h.calls.some(([name]) => name === 'dispatch'), false);
  }
  for (const [target, stage] of [['android-testnet', 'submit'], ['chrome-devnet', 'submit'], ['ios-testnet', 'upload'], ['ios-testnet', 'build']]) {
    const input = plan();
    input.targets[target].releaseNotes = 'Only iOS submission may carry this text.';
    assert.throws(() => coordinator.validateReleasePlan(input, { stage, target }), /release|notes|iOS|submit/i);
  }
});
