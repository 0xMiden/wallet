import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/two-wallets';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { cachedSolverRegistry, prepareMainnetSwapReview, readLiveSwapLeg } from '../../helpers/mainnet-swap-ui';

test('observe the prior unsigned Swap review without arming or submitting', async ({ walletB }) => {
  test.setTimeout(300_000);
  const s = loadMainnetSwapCheckpoint('test-results/swap-readonly/roundtrip.json');
  assert.ok(s?.phase === 'unspent' && s.sourceRunId === '44952299224' && s.paidFees === '0' && !s.forwardRequestAuthority);
  let stage = 'restore';
  let quoteSucceeded: boolean | null = null;
  let custodyMatches = false;
  let failure: string | undefined;
  let surface: object | undefined;
  let quoteAvailability: string | undefined;
  let freshBelowHistorical: boolean | undefined;
  const emit = (passed: boolean) => writeFileSync('test-results/swap-readonly-result.json', JSON.stringify({ stage, passed, custodyMatches, quoteSucceeded, quoteAvailability, failure, surface, freshBelowHistorical }), { mode: 0o600 });
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
    // Read a new planning floor for this nonfunded probe; never renew or overwrite the archived authorization.
    stage = 'fresh-floor';
    const live = await readLiveSwapLeg(service, s.offer, s.request, BigInt(s.principal));
    freshBelowHistorical = live.minimumReceive < BigInt(s.forwardMinimum);
    stage = 'review';
    const review = await prepareMainnetSwapReview(walletB, service, s.offer, s.request, BigInt(s.principal), live.minimumReceive, (_summary, step) => {
      if (step?.key === 'quote_request') quoteSucceeded = step.status === 'passed';
      if (step?.key === 'quote_availability') quoteAvailability = step.errorCode ?? step.status;
    });
    assert.ok(BigInt(review.minimumReceive) >= live.minimumReceive);
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
      ['quote-terms', 'not fully fillable at the exact authorized terms'],
      ['quote-shape', 'no requested amount'],
      ['amount-drift', 'drifted outside its uploaded authorization'],
      ['receive-projection', 'page.waitForFunction:'],
      ['review-button', "getByTestId('swap-review-submit')"],
      ['submit-button', "getByTestId('swap-submit')"],
      ['auto-consume', "getByTestId('swap-auto-consume')"],
      ['navigation', 'page.goto:']
    ] as const;
    failure = targets.find(([, match]) => message.includes(match))?.[0] ?? 'other';
    surface = await walletB.page.evaluate(() => {
      const reason = document.querySelector('[data-testid="swap-unavailable-notice"]')?.getAttribute('data-reason');
      return {
        reason: ['restricted', 'not-configured', 'service-down', 'unknown-region', 'eligibility-pending'].includes(reason ?? '') ? reason : reason ? 'other' : null,
        flow: !!document.querySelector('[data-testid="swap-flow"]'),
        pay: !!document.querySelector('[data-testid="swap-pay-side"]'),
        receive: !!document.querySelector('[data-testid="swap-receive-side"]'),
        selectorCount: Math.min(4, document.querySelectorAll('[data-testid="send-token-selector"]').length),
        commandAmount: !!document.querySelector('[data-testid="command-swap-receive-amount"]'),
        reviewReady: !!document.querySelector('[data-testid="swap-review-submit"]:enabled'),
        submit: !!document.querySelector('[data-testid="swap-submit"]')
      };
    }).catch(() => undefined);
    emit(false);
    throw new Error(`Read-only Swap observation stopped at ${stage}`);
  }
});
