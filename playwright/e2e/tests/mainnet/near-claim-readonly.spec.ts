import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { recoverMainnetNear } from '../../helpers/mainnet-near-runtime';

const path = 'test-results/near-claim-readonly/roundtrip.json';
test('run the recovery path up to the pre-claim boundary without authorizing', async ({ walletB }) => {
  test.setTimeout(240_000);
  const bytes = readFileSync(path);
  const state = loadMainnetNearCheckpoint(path);
  assert.ok(state?.retiredReturn && state.reverseQuote && state.transactions?.[0]?.feeWei && !state.consumeAuthority);
  const key = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '';
  await restoreMainnetLoopGuardian(walletB, key);
  try {
    await assert.rejects(recoverMainnetNear(walletB, state, `${path}.proof`, AbortSignal.timeout(170_000), key), {
      message: 'Read-only proof reached exact pre-claim boundary'
    });
  } finally {
    assert.deepEqual(readFileSync(path), bytes);
  }
});
