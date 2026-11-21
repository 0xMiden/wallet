import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/two-wallets';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { cachedSolverRegistry, prepareMainnetSwapReview } from '../../helpers/mainnet-swap-ui';

test('observe the prior unsigned Swap review without arming or submitting', async ({ walletB }) => {
  test.setTimeout(300_000);
  const s = loadMainnetSwapCheckpoint('test-results/swap-readonly/roundtrip.json');
  assert.ok(s?.phase === 'unspent' && s.sourceRunId === '44952299224' && s.paidFees === '0' && !s.forwardRequestAuthority);
  let stage = 'restore';
  let quoteSucceeded: boolean | null = null;
  let custodyMatches = false;
  let failure: string | undefined;
  const emit = (passed: boolean) => writeFileSync('test-results/swap-readonly-result.json', JSON.stringify({ stage, passed, custodyMatches, quoteSucceeded, failure }), { mode: 0o600 });
  try {
    await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    assert.equal(await walletB.getAccountAddress(), s.account);
    stage = 'custody';
    for (const asset of [s.offer, s.request, s.native])
      assert.equal((await vaultBalanceByFaucetId(walletB.page, asset.faucetId)).toString(), asset.balance);
    custodyMatches = true;
    stage = 'registry';
    let service: string | undefined;
    await expect.poll(async () => {
      const data = await walletB.page.evaluate(async () => chrome.storage.local.get([
        'bridge_config_v1:mainnet', 'bridge_config_derived_v2:mainnet', 'token_list_cache_v2:mainnet', 'token_list_cache_v1:mainnet'
      ]));
      try {
        service = cachedSolverRegistry(data['bridge_config_v1:mainnet'], data['bridge_config_derived_v2:mainnet'], [
          data['token_list_cache_v2:mainnet'], data['token_list_cache_v1:mainnet']
        ]).service;
        return true;
      } catch { return false; }
    }, { timeout: 90_000, intervals: [1_000] }).toBe(true);
    assert.ok(service);
    stage = 'review';
    const review = await prepareMainnetSwapReview(walletB, service, s.offer, s.request, BigInt(s.principal), BigInt(s.forwardMinimum), (_summary, step) => {
      if (step?.key === 'quote_request') quoteSucceeded = step.status === 'passed';
    });
    assert.ok(BigInt(review.minimumReceive) >= BigInt(s.forwardMinimum));
    stage = 'pre-authorization';
    emit(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const targets = [
      ['flow-root', "getByTestId('swap-flow')"],
      ['offered-token', `getByTestId('swap-token-${s.offer.symbol}')`],
      ['requested-token', `getByTestId('swap-token-${s.request.symbol}')`],
      ['token-selector', "getByTestId('send-token-selector')"],
      ['amount-input', "getByTestId('send-amount-input')"],
      ['quote-response', 'page.waitForResponse:'],
      ['navigation', 'page.goto:']
    ] as const;
    failure = targets.find(([, match]) => message.includes(match))?.[0] ?? 'other';
    emit(false);
    throw new Error(`Read-only Swap observation stopped at ${stage}`);
  }
});
