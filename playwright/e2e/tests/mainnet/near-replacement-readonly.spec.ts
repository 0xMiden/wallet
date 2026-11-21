import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { MAINNET_NEAR_STATE_PATH, runMainnetNearReverse } from '../../helpers/mainnet-near-runtime';

const expected = 'd3f5e34cfe19c980f173972e8e28763e4a59bd6040cfee84df5acf307f615fda';
const checkpointDigest = () => createHash('sha256').update(readFileSync(MAINNET_NEAR_STATE_PATH)).digest('hex');

test('qualify the NEAR replacement quote with signing and persistence disabled', async ({ walletB }) => {
  test.setTimeout(240_000);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/wiktor/near-replacement-browser-proof');
  assert.equal(checkpointDigest(), expected);
  const state = loadMainnetNearCheckpoint(MAINNET_NEAR_STATE_PATH);
  assert.ok(state);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  Object.assign(process.env, {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    MAINNET_NEAR_REPLACEMENT_APPROVED: 'true',
    MAINNET_NEAR_REPLACEMENT_PROVENANCE: 'true',
    MAINNET_LOOP_LOSS_BUDGET_USD_MICROS: '1712349'
  });
  try {
    await assert.rejects(
      runMainnetNearReverse(walletB, state, `${MAINNET_NEAR_STATE_PATH}.probe`, AbortSignal.timeout(190_000)),
      { message: 'Verified replacement candidate; persistence and signing disabled' }
    );
  } finally {
    assert.equal(checkpointDigest(), expected);
  }
});
