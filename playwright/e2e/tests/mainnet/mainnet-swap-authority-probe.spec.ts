import { writeFileSync } from 'node:fs';
import { expect, test } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { hexFaucetToBech32 } from '../../helpers/faucet-address';
import { readTransactionRows } from '../../helpers/history';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetSwapCheckpoint, matchAuthorizedSwap, type SwapOrderEvidence } from '../../helpers/mainnet-swap-checkpoint';
import { readLineage } from '../../helpers/swap';

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });
test('read-only original signed swap correlation; no signing, consume or submit', async ({ walletB }) => {
  test.setTimeout(240_000);
  const state = loadMainnetSwapCheckpoint('test-results/original-authority/roundtrip.json');
  if (!state || state.sourceRunId !== '43427924008' || state.phase !== 'forward-authorized' || !state.forwardRequestAuthority)
    throw new Error('Missing exact original signed checkpoint');
  const orderId = state.forwardRequestAuthority.orderId;
  expect(state.forwardOrderId).toBe(orderId);
  expect(orderId).toBe('4527770481039375833');
  const required = ['e2e_mainnet_send_authorization_required', 'e2e_mainnet_consume_authorization_required'];
  await walletB.page.evaluate(async keys => chrome.storage.local.set(Object.fromEntries(keys.map(key => [key, true]))), required);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  expect(await walletB.getAccountAddress()).toBe(state.account);
  await walletB.refreshBalancesLanded(90_000);
  const balance = async () => ({
    native: (await vaultBalanceByFaucetId(walletB.page, state.native.faucetId)).toString(),
    request: (await vaultBalanceByFaucetId(walletB.page, state.request.faucetId)).toString()
  });
  const before = await balance();
  const started = Date.now();
  const initialIds = new Set((await readTransactionRows(walletB.page)).map(row => row.id));
  let lineage: unknown = { kind: 'unavailable' };
  try {
    const value = await readLineage(walletB, orderId);
    lineage = { ok: value.ok, state: value.state,
      remainingOffered: /^\d{1,30}$/.test(value.remainingOffered ?? '') ? value.remainingOffered : undefined,
      remainingRequested: /^\d{1,30}$/.test(value.remainingRequested ?? '') ? value.remainingRequested : undefined };
  } catch { /* Private SDK errors remain runner-local. */ }
  await walletB.triggerSync(true);
  await walletB.refreshBalancesLanded(90_000);
  const rows = await readTransactionRows(walletB.page);
  const canonical = async (value: string | undefined) => !value ? undefined : value.startsWith('0x') ? hexFaucetToBech32(walletB, value) : value;
  const original = rows.filter(row => row.type === 'swap' && String(row.extraInputs?.orderId) === orderId);
  const orders: SwapOrderEvidence[] = [];
  const candidates = [];
  const numeric = (value: unknown) => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : undefined;
  for (const row of original) {
    const account = await canonical(row.accountId);
    const offeredFaucet = await canonical(row.faucetId);
    const requestedFaucet = await canonical(typeof row.extraInputs?.requestedFaucetId === 'string' ? row.extraInputs.requestedFaucetId : undefined);
    const minimumReceive = String(row.extraInputs?.requestedAmount ?? '');
    if (row.status === 2 && account && offeredFaucet && requestedFaucet && row.amount && row.completedAt !== undefined) {
      orders.push({ id: row.id, orderId, account, offeredFaucet, requestedFaucet,
        offer: row.amount, minimumReceive, initiatedAt: row.completedAt });
    }
    const error = `${row.error ?? ''} ${row.rawError ?? ''}`.toLowerCase();
    const errorKind = !error.trim() ? 'none' : error.includes('authoriz') ? 'authorization' : error.includes('nonce') ? 'nonce' : error.includes('expir') ? 'expired' : error.includes('timeout') || error.includes('timed out') ? 'timeout' : error.includes('fee') ? 'fee' : error.includes('mismatch') ? 'identity' : 'other';
    candidates.push({ status: row.status, amount: numeric(row.amount), minimumReceive: numeric(minimumReceive),
      accountMatches: account === state.account, offeredMatches: offeredFaucet === state.offer.faucetId,
      requestedMatches: requestedFaucet === state.request.faucetId, completedAt: row.completedAt,
      completedAfterAuthorization: row.completedAt !== undefined && row.completedAt >= Math.floor(Date.parse(state.createdAt) / 1000) - 30,
      feeAmount: numeric(row.feeAmount), feeMatches: (await canonical(row.feeFaucetId)) === state.native.faucetId,
      hasChainTransaction: /^0x[0-9a-f]{64}$/.test(row.transactionId ?? ''),
      stage: ['syncing', 'sending', 'executing', 'proving', 'submitting'].includes(row.stage ?? '') ? row.stage : undefined,
      errorKind });
  }
  const added = rows.filter(row => !initialIds.has(row.id));
  const after = await balance();
  const policyKeys = ['e2e_mainnet_send_authorization', 'e2e_mainnet_consume_authorization'];
  const policies = await walletB.page.evaluate(async keys => chrome.storage.local.get(keys), [...required, ...policyKeys]);
  let exactMatcherFound = false;
  let matcherAmbiguous = false;
  try { exactMatcherFound = matchAuthorizedSwap(state, orders, 'forward') !== undefined; }
  catch { matcherAmbiguous = true; }
  const diagnostics = { purpose: 'read-only exact original authority correlation; deny-all sticky barriers',
    sourceRunId: state.sourceRunId, before, after, lineage, candidates,
    exactMatcherFound, matcherAmbiguous,
    freshProcessing: added.some(row => row.processingStartedAt !== undefined && row.processingStartedAt >= started),
    noAuthority: policyKeys.every(key => policies[key] === undefined),
    denyAll: required.every(key => policies[key] === true) };
  writeFileSync('test-results/read-only-swap-authority.json', JSON.stringify(diagnostics, null, 2));
  expect(after).toEqual(before);
  expect(diagnostics.freshProcessing).toBe(false);
  expect(diagnostics.noAuthority).toBe(true);
  expect(diagnostics.denyAll).toBe(true);
});
