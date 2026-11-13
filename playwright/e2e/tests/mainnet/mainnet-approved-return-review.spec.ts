import { writeFileSync } from 'node:fs';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { readTransactionRows } from '../../helpers/history';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { cachedSolverRegistry, prepareMainnetSwapReview } from '../../helpers/mainnet-swap-ui';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });
test('read-only approved return review; never grant, arm, sign, submit or claim', async ({ walletB }) => {
  test.setTimeout(240_000);
  const started = Date.now();
  const state = loadMainnetSwapCheckpoint('test-results/original-authority/roundtrip.json');
  if (!state || state.sourceRunId !== '43427924008' || state.phase !== 'forward-authorized' || !state.forwardRequestAuthority)
    throw new Error('Missing exact original signed checkpoint');
  const report: Record<string, unknown> = { purpose: 'read-only approved original return review; no SDK authority or grant', reviewReady: false };
  let stage = 'restore';
  let before: { native: string; request: string } | undefined;
  const balances = async () => ({
    native: (await vaultBalanceByFaucetId(walletB.page, state.native.faucetId)).toString(),
    request: (await vaultBalanceByFaucetId(walletB.page, state.request.faucetId)).toString()
  });
  try {
    await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    expect(await walletB.getAccountAddress()).toBe(state.account);
    stage = 'balances';
    await walletB.refreshBalancesLanded(90_000);
    before = await balances();
    expect(before).toEqual({ native: '18987362', request: '1010890' });
    report.before = before;
    stage = 'registry';
    let accepted: ReturnType<typeof cachedSolverRegistry> | undefined;
    await expect.poll(async () => {
      const items = await walletB.page.evaluate(async () => chrome.storage.local.get([
        'bridge_config_v1:mainnet', 'bridge_config_derived_v2:mainnet',
        'token_list_cache_v2:mainnet', 'token_list_cache_v1:mainnet'
      ]));
      try {
        accepted = cachedSolverRegistry(items['bridge_config_v1:mainnet'], items['bridge_config_derived_v2:mainnet'], [items['token_list_cache_v2:mainnet'], items['token_list_cache_v1:mainnet']]);
        return true;
      } catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    if (!accepted) throw new Error('Read-only registry unavailable');
    stage = 'review';
    const review = await prepareMainnetSwapReview(walletB, accepted.service, state.request, state.offer, 1010890n, BigInt(state.reverseMinimum));
    expect(typeof review.submit).toBe('function');
    report.minimumReceive = review.minimumReceive;
    report.autoConsumeOff = await walletB.page.getByTestId('swap-auto-consume').evaluate(node => node.classList.contains('justify-start') && !node.classList.contains('justify-end'));
    report.reviewReady = true;
  } catch (error) {
    report.errorStage = stage;
    report.errorKind = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'rejected';
  } finally {
    await walletB.refreshBalancesLanded(90_000);
    const after = await balances();
    report.after = after;
    const rows = await readTransactionRows(walletB.page);
    report.freshProcessing = rows.some(row => row.processingStartedAt !== undefined && row.processingStartedAt >= started);
    const policyKeys = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization'];
    const keys = [...policyKeys, 'e2e_mainnet_consume_authorization_required'];
    const stored = await walletB.page.evaluate(async keys => chrome.storage.local.get(keys), keys);
    report.noAuthority = policyKeys.every(key => stored[key] === undefined);
    const blocked = stored.e2e_mainnet_consume_authorization_required;
    report.consumeBlocked = blocked && typeof blocked === 'object' && Object.keys(blocked).length === 1 && blocked.status === 'blocked';
    writeFileSync('test-results/read-only-approved-return.json', JSON.stringify(report, null, 2));
    expect(after).toEqual(before);
    expect(report.freshProcessing).toBe(false);
    expect(report.noAuthority).toBe(true);
    expect(report.consumeBlocked).toBe(true);
  }
  expect(report.reviewReady).toBe(true);
  expect(report.autoConsumeOff).toBe(true);
});
