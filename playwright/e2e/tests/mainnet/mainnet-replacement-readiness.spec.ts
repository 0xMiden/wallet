import { writeFileSync } from 'node:fs';
import { Endpoint, NoteId, RpcClient } from '@miden-sdk/miden-sdk';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { readTransactionRows } from '../../helpers/history';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint } from '../../helpers/mainnet-swap-checkpoint';
import { cachedSolverRegistry, prepareMainnetSwapReview } from '../../helpers/mainnet-swap-ui';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });
test('read-only issued return outcome; never replace its authority', async ({ walletB }) => {
  test.setTimeout(240_000);
  const started = Date.now();
  const state = loadMainnetSwapCheckpoint('test-results/original-authority/roundtrip.json');
  if (!state || state.authorizationRunId !== '43461752016' || state.phase !== 'reverse-authorized' || !state.reverseRequestAuthority)
    throw new Error('Missing exact retained return authority');
  const authority = state.reverseRequestAuthority;
  expect(authority.nonce).toBe('12bd7e3a-05b0-494d-8c0b-648b68ffc5bb');
  expect(authority.noteId).toBe('0x444d415a106341d4b7005bdb41c8af3f87d97ee49cc1010e420297632621cb1e');
  const report: Record<string, unknown> = { purpose: 'read-only issued return outcome; no new authority or grant', outcomeVerified: false, retainedReturnNonce: authority.nonce, returnExpiresAt: authority.expiresAt };
  const rpc = new RpcClient(new Endpoint('https://rpc.mainnet.miden.io'));
  const lookup = async () => {
    const header = await rpc.getBlockHeaderByNumber();
    const notes = await rpc.getNotesById([NoteId.fromHex(authority.noteId)]);
    return { height: header.blockNum(), returnNoteCount: notes.length };
  };
  const balances = async () => ({
    native: (await vaultBalanceByFaucetId(walletB.page, state.native.faucetId)).toString(),
    request: (await vaultBalanceByFaucetId(walletB.page, state.request.faucetId)).toString()
  });
  let stage = 'restore';
  try {
    await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
    expect(await walletB.getAccountAddress()).toBe(state.account);
    stage = 'balances';
    await walletB.refreshBalancesLanded(90_000);
    const before = await balances();
    report.before = before;
    expect(before).toEqual({ native: '18987362', request: '1010890' });
    stage = 'public-note';
    const first = await lookup();
    report.first = first;
    expect(first.height).toBeGreaterThan(855903);
    expect(first.returnNoteCount).toBe(0);
    await walletB.page.waitForTimeout(5000);
    await walletB.refreshBalancesLanded(90_000);
    const after = await balances();
    report.after = after;
    expect(after).toEqual(before);
    const last = await lookup();
    report.last = last;
    expect(last.height).toBeGreaterThanOrEqual(first.height);
    expect(last.returnNoteCount).toBe(0);
    const rows = await readTransactionRows(walletB.page);
    report.freshProcessing = rows.some(row => row.processingStartedAt !== undefined && row.processingStartedAt >= started);
    report.unresolvedRows = rows.some(row => row.status === 0 || row.status === 1);
    expect(report.unresolvedRows).toBe(false);
    stage = 'replacement-review';
    let accepted: ReturnType<typeof cachedSolverRegistry> | undefined;
    await expect.poll(async () => {
      const items = await walletB.page.evaluate(async () => chrome.storage.local.get(['bridge_config_v1:mainnet','bridge_config_derived_v2:mainnet','token_list_cache_v2:mainnet','token_list_cache_v1:mainnet']));
      try { accepted = cachedSolverRegistry(items['bridge_config_v1:mainnet'],items['bridge_config_derived_v2:mainnet'],[items['token_list_cache_v2:mainnet'],items['token_list_cache_v1:mainnet']]); return true; } catch { return false; }
    }, { timeout: 90000 }).toBe(true);
    if (!accepted) throw new Error('Registry unavailable');
    const review = await prepareMainnetSwapReview(walletB,accepted.service,state.request,state.offer,BigInt(state.returnAmount ?? '0'),BigInt(authority.minimumReceive));
    report.minimumReceive = review.minimumReceive;
    report.autoConsumeOff = await walletB.page.getByTestId('swap-auto-consume').evaluate(node => node.classList.contains('justify-start') && !node.classList.contains('justify-end'));
    expect(report.autoConsumeOff).toBe(true);
    expect(typeof review.submit).toBe('function');
    report.replacementReviewReady = true;
    await walletB.refreshBalancesLanded(90000);
    expect(await balances()).toEqual(before);
    const policyKeys = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization'];
    const stored = await walletB.page.evaluate(async keys => chrome.storage.local.get(keys), [...policyKeys, 'e2e_mainnet_consume_authorization_required']);
    report.noLivePolicy = policyKeys.every(key => stored[key] === undefined);
    const marker = stored.e2e_mainnet_consume_authorization_required;
    report.consumeBlocked = marker && typeof marker === 'object' && Object.keys(marker).length === 1 && marker.status === 'blocked';
    expect(report.noLivePolicy).toBe(true);
    expect(report.consumeBlocked).toBe(true);
    expect(report.freshProcessing).toBe(false);
    report.outcomeVerified = true;
  } catch (error) {
    report.errorStage = stage;
    report.errorKind = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'rejected';
  } finally {
    writeFileSync('test-results/read-only-replacement-readiness.json', JSON.stringify(report, null, 2));
  }
  expect(report.outcomeVerified).toBe(true);
});
