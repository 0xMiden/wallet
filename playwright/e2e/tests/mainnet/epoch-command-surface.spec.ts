import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from '../../fixtures/two-wallets';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetEpochCheckpoint } from '../../helpers/mainnet-epoch-checkpoint';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';

test('observe the Epoch return entry surface without connecting or signing', async ({ walletB }) => {
  test.setTimeout(240_000);
  const state = loadMainnetEpochCheckpoint('test-results/epoch-readonly/roundtrip.json');
  assert.ok(state?.sourceRunId === '44959645259' && state.phase === 'recovery-required' && state.forwardReceived);
  assert.ok(!state.reverseAuthority && !state.transactions?.length && !state.consumeAuthority);
  let stage = 'restore';
  let custodyMatches = false;
  let commandBridge = false;
  let legacyConnect = false;
  try {
    await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    assert.equal(await walletB.getAccountAddress(), state.account);
    stage = 'custody';
    const native = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
    custodyMatches = native === BigInt(state.native.balance) - BigInt(state.principal) - BigInt(state.paidMidenFees);
    assert.ok(custodyMatches);
    stage = 'bridge-surface';
    await walletB.navigateTo('/bridge/deposit');
    const command = walletB.page.getByTestId('command-bridge');
    const legacy = walletB.page.getByTestId('bridge-connect-wallet');
    await command.or(legacy).first().waitFor({ state: 'visible', timeout: 40_000 });
    commandBridge = await command.isVisible();
    legacyConnect = await legacy.isVisible();
    assert.notEqual(commandBridge, legacyConnect);
  } finally {
    writeFileSync('test-results/epoch-surface-result.json', JSON.stringify({ stage, custodyMatches, commandBridge, legacyConnect }), { mode: 0o600 });
  }
});
