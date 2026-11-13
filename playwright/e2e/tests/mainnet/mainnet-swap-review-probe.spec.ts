import { writeFileSync } from 'node:fs';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { readTransactionRows } from '../../helpers/history';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { cachedSolverRegistry, prepareMainnetSwapReview } from '../../helpers/mainnet-swap-ui';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });
test('read-only original swap review, never arm or submit', async ({ walletB }) => {
  test.setTimeout(240_000);
  const state = loadMainnetSwapCheckpoint('test-results/original-unspent/roundtrip.json');
  if (!state) throw new Error('Missing original read-only checkpoint');
  expect(state.sourceRunId).toBe('43410679381');
  expect(state.phase).toBe('unspent');
  expect(state.paidFees).toBe('0');
  expect(state.forwardOrderId).toBeUndefined();
  expect(state.forwardRequestAuthority).toBeUndefined();
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  expect(await walletB.getAccountAddress()).toBe(state.account);
  await walletB.refreshBalancesLanded(90_000);
  const initial = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
  expect(initial.toString()).toBe(state.native.balance);
  const rows = (await readTransactionRows(walletB.page)).map(row => row.id).sort();
  let accepted: ReturnType<typeof cachedSolverRegistry> | undefined;
  await expect.poll(async () => {
    const items = await walletB.page.evaluate(async () => chrome.storage.local.get([
      'bridge_config_v1:mainnet', 'bridge_config_derived_v2:mainnet',
      'token_list_cache_v2:mainnet', 'token_list_cache_v1:mainnet'
    ]));
    try {
      accepted = cachedSolverRegistry(items['bridge_config_v1:mainnet'], items['bridge_config_derived_v2:mainnet'], [
        items['token_list_cache_v2:mainnet'], items['token_list_cache_v1:mainnet']
      ]);
      return true;
    } catch { return false; }
  }, { timeout: 90_000 }).toBe(true);
  if (!accepted) throw new Error('Read-only registry unavailable');
  const service = accepted.service;
  const diagnostics: Record<string, unknown> = { purpose: 'read-only review; no authority or submit', initialBalance: initial.toString(), eta: [] };
  const eta: { status: number; requestedAmount?: string }[] = [];
  walletB.page.on('response', async response => {
    const url = new URL(response.url());
    if (url.origin !== new URL(service).origin || !url.pathname.endsWith('/v2/swap-eta')) return;
    const item: { status: number; requestedAmount?: string } = { status: response.status() };
    try {
      const value: unknown = await response.json();
      if (typeof value === 'object' && value !== null && 'requestedAmount' in value &&
          typeof value.requestedAmount === 'string' && /^\d{1,30}$/.test(value.requestedAmount))
        item.requestedAmount = value.requestedAmount;
    } catch { /* Only approved numeric metadata is retained. */ }
    eta.push(item);
  });
  try {
    const review = await prepareMainnetSwapReview(walletB, service, state.offer, state.request, BigInt(state.principal), BigInt(state.forwardMinimum));
    expect(typeof review.submit).toBe('function');
    diagnostics.reviewReady = true;
    diagnostics.minimumReceive = review.minimumReceive;
  } catch (error) {
    diagnostics.reviewReady = false;
    diagnostics.errorKind = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'preparation-rejected';
    const message = error instanceof Error ? error.message : '';
    diagnostics.errorStage = message.includes(`swap-token-${state.offer.symbol}`) ? 'offered-token' :
      message.includes(`swap-token-${state.request.symbol}`) ? 'requested-token' :
      message.includes('swap-flow') ? 'flow' : message.includes('send-token-selector') ? 'selector' :
      message.includes('waitForResponse') ? 'eta' : message.includes('waitForFunction') ? 'projection' : 'other';
  } finally {
    diagnostics.eta = eta;
    diagnostics.tokenChoices = (await walletB.page.locator('[data-testid^="swap-token-"]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('data-testid')).filter((id): id is string =>
        typeof id === 'string' && /^swap-token-[A-Za-z0-9._-]{1,24}$/.test(id))
    )).slice(0, 30);
    const numeric = (value: string) => /^\d*(?:\.\d*)?$/.test(value) ? value : '<not-numeric>';
    diagnostics.flowVisible = await walletB.page.getByTestId('swap-flow').isVisible().catch(() => false);
    diagnostics.reviewVisible = await walletB.page.getByTestId('swap-submit').isVisible().catch(() => false);
    diagnostics.pay = numeric(await walletB.page.getByTestId('swap-pay-side').getByTestId('send-amount-input').inputValue().catch(() => ''));
    diagnostics.receive = numeric(await walletB.page.getByTestId('swap-receive-side').getByTestId('send-amount-input').inputValue().catch(() => ''));
    await walletB.refreshBalancesLanded(90_000);
    const final = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
    diagnostics.finalBalance = final.toString();
    const after = (await readTransactionRows(walletB.page)).map(row => row.id).sort();
    diagnostics.rowsUnchanged = JSON.stringify(after) === JSON.stringify(rows);
    const keys = ['e2e_mainnet_send_authorization', 'e2e_mainnet_send_authorization_required', 'e2e_mainnet_consume_authorization', 'e2e_mainnet_consume_authorization_required'];
    const policies = await walletB.page.evaluate(async keys => chrome.storage.local.get(keys), keys);
    diagnostics.noAuthority = keys.every(key => policies[key] === undefined);
    writeFileSync('test-results/read-only-swap-review.json', JSON.stringify(diagnostics, null, 2));
    expect(final).toBe(initial);
    expect(after).toEqual(rows);
    expect(diagnostics.noAuthority).toBe(true);
  }
  expect(diagnostics.reviewReady, 'Read-only review failed; see approved public diagnostics').toBe(true);
});
