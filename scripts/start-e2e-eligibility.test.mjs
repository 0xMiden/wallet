import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureEnvironment } from './start-e2e-eligibility.mjs';

test('ordinary E2E jobs bake explicit matching local config and eligibility URLs', () => {
  assert.deepEqual(fixtureEnvironment({ E2E_NETWORK: 'devnet' }), {
    args: ['--port', '8551', '--networks', 'devnet'],
    env: {
      MIDEN_E2E_TEST: 'true',
      FEATURE_ELIGIBILITY_URL: 'http://127.0.0.1:8551/v1/eligibility',
      MIDEN_REMOTE_CONFIG_URL: 'http://127.0.0.1:8551'
    }
  });
});

test('mock E2E defaults to the wallet testnet document', () => {
  assert.deepEqual(fixtureEnvironment({}).args, ['--port', '8551', '--networks', 'testnet']);
});

test('localhost chain jobs use the wallet localnet config name', () => {
  assert.deepEqual(fixtureEnvironment({ E2E_NETWORK: 'localhost' }).args, ['--port', '8551', '--networks', 'localnet']);
});

test('existing hermetic config stays on8550 and is queried lazily for matching eligibility', () => {
  const plan = fixtureEnvironment({ E2E_NETWORK: 'localhost', MIDEN_REMOTE_CONFIG_URL: 'http://127.0.0.1:8550/' });
  assert.deepEqual(plan.args, ['--port', '8551', '--networks', 'localnet', '--source', 'http://127.0.0.1:8550', '--lazy-source']);
  assert.equal(plan.env.MIDEN_REMOTE_CONFIG_URL, 'http://127.0.0.1:8550');
  assert.equal(plan.env.FEATURE_ELIGIBILITY_URL, 'http://127.0.0.1:8551/v1/eligibility');
});

test('an explicit published config source is frozen before matching decisions are served', () => {
  const plan = fixtureEnvironment({ MIDEN_REMOTE_CONFIG_URL: 'https://config.example/policies/' });
  assert.deepEqual(plan.args, ['--port', '8551', '--networks', 'testnet', '--source', 'https://config.example/policies']);
  assert.equal(plan.env.MIDEN_REMOTE_CONFIG_URL, 'http://127.0.0.1:8551');
});

test('invalid or injected network names cannot reach the fixture command', () => {
  assert.throws(() => fixtureEnvironment({ E2E_NETWORK: 'constructor' }));
  assert.throws(() => fixtureEnvironment({ E2E_NETWORK: 'testnet\nOTHER=value' }));
});

test('mock and smoothness jobs explicitly request a prelaunch testnet policy', () => {
  const plan = fixtureEnvironment({ E2E_FIXTURE_PRELAUNCH_TESTNET: 'true' });
  assert.deepEqual(plan.args, ['--port', '8551', '--networks', 'testnet', '--prelaunch-testnet']);
});

test('prelaunch fixture mode cannot be selected for Mainnet or another network', () => {
  for (const network of ['mainnet', 'devnet', 'localhost']) {
    assert.throws(() => fixtureEnvironment({ E2E_NETWORK: network, E2E_FIXTURE_PRELAUNCH_TESTNET: 'true' }));
  }
  assert.throws(() => fixtureEnvironment({ E2E_FIXTURE_PRELAUNCH_TESTNET: 'yes' }));
});

test('prelaunch mode rejects direct loopback policy sources that the app would read without the fixture transform', () => {
  assert.throws(() =>
    fixtureEnvironment({
      E2E_FIXTURE_PRELAUNCH_TESTNET: 'true',
      MIDEN_REMOTE_CONFIG_URL: 'http://127.0.0.1:8550/'
    })
  );
});

test('an explicit mock launch transition serves both the starting and destination policy', () => {
  assert.deepEqual(fixtureEnvironment({ E2E_FIXTURE_NETWORKS: 'testnet,mainnet' }).args, [
    '--port',
    '8551',
    '--networks',
    'testnet,mainnet'
  ]);
});

test('explicit fixture networks remain closed, unique and include the starting network', () => {
  for (const networks of ['mainnet', 'testnet,testnet', 'testnet,constructor', 'testnet\nOTHER=value']) {
    assert.throws(() => fixtureEnvironment({ E2E_FIXTURE_NETWORKS: networks }));
  }
});
