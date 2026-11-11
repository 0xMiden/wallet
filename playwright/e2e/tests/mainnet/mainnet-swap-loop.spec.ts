import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { vaultBalanceByFaucetId, walletDiscoveredBaseFee, walletDiscoveredNativeFaucetId } from '../../helpers/balance-truth';
import { hexFaucetToBech32 } from '../../helpers/faucet-address';
import { readTransactionRows, type TransactionRowSnapshot } from '../../helpers/history';
import { fetchMainnetOneClickUsdPrices } from '../../helpers/mainnet-one-click-prices';
import { loadMainnetSwapCheckpoint, saveMainnetSwapCheckpoint, matchAuthorizedSwap, swapProceeds,
  type MainnetSwapCheckpoint, type SavedSwapHolding, type SwapOrderEvidence } from '../../helpers/mainnet-swap-checkpoint';
import { chooseMainnetSwapLoop, planMainnetSwapLoop, swapSearchAmounts, swapValue, SWAP_LOSS_CAP, SWAP_TX_FEE_MULTIPLE,
  type SwapLoopPlan } from '../../helpers/mainnet-swap-plan';
import { prepareMainnetSwapReview, readLiveSwapLeg, recoveredSwapAutoAccept } from '../../helpers/mainnet-swap-ui';
import { readLineage } from '../../helpers/swap';
import { parseSwapPairs } from '../../../../src/lib/remote-config/swap-pairs';

const STATE_PATH = 'test-results/mainnet-swap-state/roundtrip.json';
const PRICE_IDS: Record<string, string> = { ETH: 'ethereum', BTC: 'bitcoin', USDC: 'usd-coin' };
test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });

const holding = (saved: SavedSwapHolding) => ({ ...saved, balance: BigInt(saved.balance), usdMicros: BigInt(saved.usdMicros) });

function persist(state: MainnetSwapCheckpoint): void {
  state.updatedAt = new Date().toISOString();
  saveMainnetSwapCheckpoint(STATE_PATH, state);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/mainnet-swap-summary.json', `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync('test-results/mainnet-swap-summary.md', [
    '### Mainnet solver swap loop', `- State: ${state.phase}`,
    `- Route: ${state.offer.symbol} -> ${state.request.symbol} -> ${state.offer.symbol}`,
    `- Principal: ${state.principal} base units; forward: ${state.forwardOrderId ?? 'not identified'}; reverse: ${state.reverseOrderId ?? 'not identified'}`,
    `- Native fees paid/budget: ${state.paidFees}/${state.feeBudget} base units`,
    '- Amount search: $1.00, $1.01, $1.02, $1.05, $1.10, $1.25, $1.50, $2.00, rounded up to token precision.',
    '- Loss ceiling: $2, not a spend target. A pending or recovered cancellation is not passing swap coverage.', ''
  ].join('\n'));
}

async function balances(wallet: GuardianAwareWalletPage, state: Pick<MainnetSwapCheckpoint, 'offer' | 'request' | 'native'>) {
  await wallet.refreshBalancesLanded(90_000);
  return {
    offer: await vaultBalanceByFaucetId(wallet.page, state.offer.faucetId),
    request: await vaultBalanceByFaucetId(wallet.page, state.request.faucetId),
    native: await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)
  };
}

async function registry(wallet: GuardianAwareWalletPage) {
  const response = wallet.page.waitForResponse(res => new URL(res.url()).pathname === '/v2/pairs', { timeout: 90_000 });
  await wallet.page.reload({ waitUntil: 'domcontentloaded' });
  const res = await response;
  if (!res.ok() || new URL(res.url()).protocol !== 'https:') throw new Error('The wallet did not load a live HTTPS solver registry');
  const pairs = parseSwapPairs(await res.json());
  if (!pairs?.pairs.length) throw new Error('The accepted wallet config has no live swap pairs');
  const ids = [...new Set(pairs.tokens.flatMap(token => token.binanceAsset && PRICE_IDS[token.binanceAsset] ? [PRICE_IDS[token.binanceAsset]!] : []))];
  const prices = await fetchMainnetOneClickUsdPrices(ids);
  const tokens: SavedSwapHolding[] = [];
  for (const token of pairs.tokens) {
    const priceId = token.binanceAsset ? PRICE_IDS[token.binanceAsset] : undefined;
    const usdMicros = priceId ? prices.usdMicrosById[priceId] : undefined;
    if (!usdMicros) continue;
    const faucetId = await hexFaucetToBech32(wallet, token.faucetId);
    tokens.push({ faucetId, hex: token.faucetId, symbol: token.ticker, decimals: token.decimals,
      balance: (await vaultBalanceByFaucetId(wallet.page, faucetId)).toString(), usdMicros: usdMicros.toString() });
  }
  const nativeId = await walletDiscoveredNativeFaucetId(wallet.page);
  const native = tokens.find(token => token.faucetId === nativeId);
  if (!native) throw new Error('The native fee asset has no priced solver registry entry');
  const fee = await walletDiscoveredBaseFee(wallet.page);
  if (fee === null || !Number.isSafeInteger(fee) || fee <= 0) throw new Error('The wallet did not discover a positive native base fee');
  return { service: new URL(res.url()).origin, tokens, native, baseFee: BigInt(fee), pairs: pairs.pairs, prices };
}

async function prepare(wallet: GuardianAwareWalletPage, runId: string, live: Awaited<ReturnType<typeof registry>>): Promise<MainnetSwapCheckpoint> {
  const candidates: Array<{ plan: SwapLoopPlan; offer: SavedSwapHolding; request: SavedSwapHolding }> = [];
  for (const pair of live.pairs) {
    for (const direction of [pair.faucetIds, [...pair.faucetIds].reverse()]) {
      const offer = live.tokens.find(token => token.hex === direction[0]);
      const request = live.tokens.find(token => token.hex === direction[1]);
      if (!offer || !request || BigInt(offer.balance) === 0n) continue;
      for (const amount of swapSearchAmounts(holding(offer))) {
        try {
          const forward = await readLiveSwapLeg(live.service, offer, request, amount);
          const intermediateFees = request.faucetId === live.native.faucetId ? 2n * SWAP_TX_FEE_MULTIPLE * live.baseFee : 0n;
          const reverse = await readLiveSwapLeg(live.service, request, offer, forward.minimumReceive - intermediateFees);
          const plan = planMainnetSwapLoop({ forward, reverse, native: holding(live.native), baseFee: live.baseFee, recoveryTxs: 2n });
          // Bound even an unexpected zero-value fill, not just the quoted spread.
          if (swapValue(holding(offer), amount) + swapValue(holding(live.native), 6n * SWAP_TX_FEE_MULTIPLE * live.baseFee) > SWAP_LOSS_CAP) continue;
          candidates.push({ plan, offer, request });
          break;
        } catch (error) {
          console.log(`Swap candidate ${offer.symbol}/${request.symbol} ${amount} refused: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  const chosen = chooseMainnetSwapLoop(candidates.map(candidate => candidate.plan));
  const candidate = candidates.find(entry => entry.plan === chosen);
  if (!chosen || !candidate) throw new Error('No funded two-way mainnet swap fits both $1 minima, reserves and the $2 safety cap');
  const oldRows = await readTransactionRows(wallet.page);
  const timestamp = new Date().toISOString();
  return {
    version: 1, network: 'mainnet', account: await wallet.getAccountAddress(), sourceRunId: runId, authorizationRunId: runId,
    phase: 'forward-authorized', createdAt: timestamp, updatedAt: timestamp,
    offer: candidate.offer, request: candidate.request, native: live.native, baseFee: live.baseFee.toString(),
    principal: chosen.forward.offer.toString(), forwardMinimum: chosen.forward.minimumReceive.toString(),
    reverseMinimum: chosen.reverse.minimumReceive.toString(),
    knownOrderIds: oldRows.flatMap(row => row.type === 'swap' && row.extraInputs?.orderId !== undefined ? [String(row.extraInputs.orderId)] : []),
    feeBudget: (6n * SWAP_TX_FEE_MULTIPLE * live.baseFee).toString(), paidFees: '0'
  };
}

async function evidence(wallet: GuardianAwareWalletPage): Promise<{ rows: TransactionRowSnapshot[]; orders: SwapOrderEvidence[] }> {
  const rows = await readTransactionRows(wallet.page);
  const orders: SwapOrderEvidence[] = [];
  for (const row of rows) {
    if (row.type !== 'swap' || row.extraInputs?.orderId === undefined || !row.accountId || !row.faucetId || !row.amount ||
      typeof row.extraInputs.requestedFaucetId !== 'string' || row.extraInputs.requestedAmount === undefined || row.completedAt === undefined) continue;
    const canonical = (id: string) => id.startsWith('0x') ? hexFaucetToBech32(wallet, id) : Promise.resolve(id);
    orders.push({ id: row.id, orderId: String(row.extraInputs.orderId), account: await canonical(row.accountId),
      offeredFaucet: await canonical(row.faucetId), requestedFaucet: await canonical(row.extraInputs.requestedFaucetId),
      offer: row.amount, minimumReceive: String(row.extraInputs.requestedAmount), initiatedAt: row.completedAt });
  }
  return { rows, orders };
}

async function settle(wallet: GuardianAwareWalletPage, state: MainnetSwapCheckpoint, leg: 'forward' | 'reverse', recover: boolean): Promise<{ received: bigint; refunded: bigint; fees: bigint; now: Awaited<ReturnType<typeof balances>> }> {
  let order: SwapOrderEvidence | undefined;
  await expect.poll(async () => {
    await wallet.triggerSync(true);
    order = matchAuthorizedSwap(state, (await evidence(wallet)).orders, leg);
    return order !== undefined;
  }, { timeout: 180_000, intervals: [5_000], message: 'No unique prior order found; submission is unresolved, never resubmit automatically' }).toBe(true);
  if (!order) throw new Error('The authorized order is unresolved');
  const matched = order;
  if (leg === 'forward') state.forwardOrderId = matched.orderId;
  else state.reverseOrderId = matched.orderId;
  persist(state);
  if (recover) await recoveredSwapAutoAccept(wallet.page, matched.id, matched.orderId);
  await wallet.page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/history-details/${matched.id}`);
  const target = leg === 'forward' ? state.request : state.offer;
  let received = 0n;
  let refunded = 0n;
  let fees = 0n;
  try {
    await expect.poll(async () => {
      await wallet.triggerSync(true);
      const current = await readTransactionRows(wallet.page);
      const orderRow = current.find(row => row.id === matched.id);
      const consumes = current.filter(row => row.type === 'consume' && row.extraInputs?.swapOrderTxId === matched.id && row.status === 2);
      const payments = consumes.filter(row => row.extraInputs?.swapSettleKind === 'settle');
      const reclaims = consumes.filter(row => row.extraInputs?.swapSettleKind === 'reclaim');
      if (!orderRow || !payments.length && !(recover && reclaims.length)) return false;
      if (reclaims.length && !recover) throw new Error('Order was reclaimed, not a full swap');
      refunded = 0n;
      for (const row of reclaims) {
        const id = row.faucetId?.startsWith('0x') ? await hexFaucetToBech32(wallet, row.faucetId) : row.faucetId;
        const offeredId = leg === 'forward' ? state.offer.faucetId : state.request.faucetId;
        if (id !== offeredId || !row.amount) throw new Error('The reclaim has no attributable offered-token amount');
        refunded += BigInt(row.amount);
      }
      received = 0n;
      for (const row of payments) {
        const id = row.faucetId?.startsWith('0x') ? await hexFaucetToBech32(wallet, row.faucetId) : row.faucetId;
        if (id !== target.faucetId || !row.amount) throw new Error('The payback has no attributable requested-token amount');
        received += BigInt(row.amount);
      }
      fees = 0n;
      for (const row of [orderRow, ...consumes]) {
        const id = row.feeFaucetId?.startsWith('0x') ? await hexFaucetToBech32(wallet, row.feeFaucetId) : row.feeFaucetId;
        if (!row.feeAmount || id !== state.native.faucetId) throw new Error('A committed swap transaction has no verified native fee evidence');
        fees += BigInt(row.feeAmount);
      }
      const minimum = BigInt(leg === 'forward' ? state.forwardMinimum : state.reverseMinimum);
      if (received < minimum && !(recover && refunded > 0n)) return false;
      if (orderRow.extraInputs?.lineageClosedAt !== undefined) return true;
      const lineage = await readLineage(wallet, matched.orderId);
      return lineage.state === 'filled' || recover && lineage.state === 'reclaimed';
    }, { timeout: 300_000, intervals: [5_000], message: 'Swap did not fully settle and claim its payback' }).toBe(true);
  } catch (error) {
    // One existing order may be reclaimed, but a failed fill is never reported as passing coverage.
    const cancel = wallet.page.getByTestId('swap-cancel-order-button');
    if (BigInt(state.paidFees) + fees + SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee) <= BigInt(state.feeBudget) &&
        await cancel.isVisible().catch(() => false)) {
      await cancel.click();
      await wallet.triggerSync(true);
    }
    throw error;
  }
  const now = await balances(wallet, state);
  const before = leg === 'forward' ? { offer: BigInt(state.offer.balance), request: BigInt(state.request.balance), native: BigInt(state.native.balance) }
    : state.returnBaseline ? { offer: BigInt(state.returnBaseline.offer), request: BigInt(state.returnBaseline.request), native: BigInt(state.returnBaseline.native) } : undefined;
  if (!before) throw new Error('Return authorization has no baseline');
  const offered = leg === 'forward' ? state.offer : state.request;
  const principal = BigInt(leg === 'forward' ? state.principal : state.returnAmount ?? '0');
  const targetBefore = leg === 'forward' ? before.request : before.offer;
  const targetAfter = leg === 'forward' ? now.request : now.offer;
  swapProceeds(targetBefore, targetAfter, received, target.faucetId === state.native.faucetId ? fees : 0n);
  const offerBefore = leg === 'forward' ? before.offer : before.request;
  const offerAfter = leg === 'forward' ? now.offer : now.request;
  expect(offerBefore - offerAfter, 'Unexpected offered-token debit or unclaimed remainder').toBe(principal - refunded + (offered.faucetId === state.native.faucetId ? fees : 0n));
  const expectedNative = before.native - fees - (offered.faucetId === state.native.faucetId ? principal - refunded : 0n) + (target.faucetId === state.native.faucetId ? received : 0n);
  expect(now.native, 'Native balance does not reconcile with swap fees').toBe(expectedNative);
  return { received, refunded, fees, now };
}

async function authorizeReturn(state: MainnetSwapCheckpoint, runId: string, live: Awaited<ReturnType<typeof registry>>, result: Awaited<ReturnType<typeof settle>>): Promise<void> {
  state.forwardReceived = result.received.toString();
  state.forwardRefunded = result.refunded.toString();
  state.paidFees = result.fees.toString();
  state.phase = 'forward-settled';
  persist(state);
  swapProceeds(BigInt(state.request.balance), result.now.request, result.received,
    state.request.faucetId === state.native.faucetId ? result.fees : 0n);
  const amount = result.now.request - BigInt(state.request.balance);
  if (amount <= 0n) throw new Error('The forward swap left no newly received return principal');
  const reverse = await readLiveSwapLeg(live.service, state.request, state.offer, amount);
  const paidUsd = swapValue(holding(state.native), result.fees);
  const loss = swapValue(holding(state.offer), BigInt(state.principal) - result.refunded) - swapValue(holding(state.offer), reverse.minimumReceive, false);
  const remaining = BigInt(state.feeBudget) - result.fees;
  if (remaining < 2n * SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee)) throw new Error('No fee budget remains for the return create and claim');
  if (paidUsd + (loss > 0n ? loss : 0n) + swapValue(holding(state.native), remaining) > SWAP_LOSS_CAP) throw new Error('Return exceeds the remaining $2 loss budget');
  if (swapValue(holding(state.request), amount, false) < 1_000_000n) throw new Error('Actual return proceeds are below the wallet $1 minimum');
  state.returnAmount = amount.toString();
  state.reverseMinimum = reverse.minimumReceive.toString();
  state.returnBaseline = { offer: result.now.offer.toString(), request: result.now.request.toString(), native: result.now.native.toString() };
  state.authorizationRunId = runId;
  state.phase = 'reverse-authorized';
  persist(state);
}

function completeReturn(state: MainnetSwapCheckpoint, result: Awaited<ReturnType<typeof settle>>): void {
  const totalFees = BigInt(state.paidFees) + result.fees;
  const principalUsd = swapValue(holding(state.offer), BigInt(state.principal) - BigInt(state.forwardRefunded ?? '0'));
  const returnedUsd = swapValue(holding(state.offer), result.received, false);
  const loss = (principalUsd > returnedUsd ? principalUsd - returnedUsd : 0n) + swapValue(holding(state.native), totalFees);
  if (result.refunded > 0n) throw new Error('Return was partially reclaimed; intermediate principal is unresolved');
  if (loss > SWAP_LOSS_CAP || totalFees > BigInt(state.feeBudget)) throw new Error('Realized round-trip loss or network fees exceeded the authorized budget');
  state.reverseReceived = result.received.toString();
  state.paidFees = totalFees.toString();
  state.phase = 'complete';
  persist(state);
  if (BigInt(state.forwardRefunded ?? '0') > 0n) throw new Error('Partial forward fill was safely recovered, not a passing full-fill acceptance');
}

test('real Guardian mainnet solver swaps out and back with recycled principal', async ({ walletB }) => {
  test.setTimeout(1_800_000);
  if (process.env.E2E_NETWORK !== 'mainnet') throw new Error('The funded swap loop requires mainnet');
  const runId = process.env.GITHUB_RUN_ID;
  const mode = process.env.MAINNET_SWAP_MODE;
  const key = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
  if (!runId || !/^\d+$/.test(runId) || !key || !['recover', 'prepare', 'forward', 'reverse'].includes(mode ?? '')) throw new Error('Missing explicit mainnet swap mode, workflow identity or Guardian key');
  if (process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('Do not rerun funded workflow jobs; use a new serialized run to reconcile prior state');
  await walletB.recoverGuardianFromHotKey(key.trim());
  await walletB.triggerSync(true);
  await walletB.refreshBalancesLanded(90_000);
  let state = loadMainnetSwapCheckpoint(STATE_PATH);
  const account = await walletB.getAccountAddress();
  if (state && state.account !== account) throw new Error('The checkpoint belongs to a different Guardian account');
  const live = await registry(walletB);
  if (mode === 'prepare') {
    if (state?.recoveredRunId === runId || state?.phase === 'reverse-authorized' && state.authorizationRunId === runId) return;
    if (state && !['complete', 'cancelled', 'unspent'].includes(state.phase)) throw new Error('Previous principal is unresolved; refusing a new forward swap');
    state = await prepare(walletB, runId, live);
    persist(state);
    return;
  }
  if (!state) {
    if (mode === 'recover' && process.env.MAINNET_SWAP_BOOTSTRAP === 'true') return;
    throw new Error('Missing durable swap authorization; do not bootstrap over a previous attempt');
  }
  if (['complete', 'cancelled', 'unspent'].includes(state.phase)) return;
  if (mode === 'recover') {
    if (state.phase === 'forward-authorized' && process.env.MAINNET_SWAP_PRIOR_FORWARD_ATTEMPTED === 'false') {
      state.phase = 'unspent';
      persist(state);
      return;
    }
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow recovery output channel');
    appendFileSync(process.env.GITHUB_OUTPUT, 'recovery_only=true\n');
    state.recoveredRunId = runId;
    persist(state);
    if (state.phase === 'reverse-authorized' && process.env.MAINNET_SWAP_PRIOR_REVERSE_ATTEMPTED === 'false') {
      const current = await balances(walletB, state);
      const baseline = state.returnBaseline;
      if (!baseline || current.offer.toString() !== baseline.offer || current.request.toString() !== baseline.request || current.native.toString() !== baseline.native) throw new Error('Balances changed before return recovery');
      await authorizeReturn(state, runId, live, { received: BigInt(state.forwardReceived ?? '0'), refunded: BigInt(state.forwardRefunded ?? '0'),
        fees: BigInt(state.paidFees), now: await balances(walletB, state) });
      return;
    }
    const leg = state.phase === 'reverse-authorized' ? 'reverse' : 'forward';
    const result = await settle(walletB, state, leg, true);
    if (leg === 'forward' && result.refunded === BigInt(state.principal) && result.received === 0n) {
      state.forwardReceived = '0'; state.forwardRefunded = result.refunded.toString(); state.paidFees = result.fees.toString();
      state.phase = 'cancelled'; persist(state);
      throw new Error('Unfilled swap principal was fully reclaimed; full-fill acceptance failed');
    }
    if (leg === 'forward') await authorizeReturn(state, runId, live, result);
    else completeReturn(state, result);
    return;
  }
  if (mode === 'forward' && state.phase === 'reverse-authorized') return;
  const leg = mode === 'forward' ? 'forward' : 'reverse';
  if (state.phase !== `${leg}-authorized` || state.authorizationRunId !== runId) throw new Error('This run has no authorization to submit that swap leg');
  const before = await balances(walletB, state);
  const baseline = leg === 'forward' ? { offer: state.offer.balance, request: state.request.balance, native: state.native.balance } : state.returnBaseline;
  if (!baseline || before.offer.toString() !== baseline.offer || before.request.toString() !== baseline.request || before.native.toString() !== baseline.native) throw new Error('Balances changed since swap authorization');
  if ((await evidence(walletB)).orders.some(row => !state!.knownOrderIds.includes(row.orderId) && row.orderId !== state!.forwardOrderId)) throw new Error('A new unaccounted order exists; refusing to sign');
  if (live.baseFee > BigInt(state.baseFee)) throw new Error('Native fee increased beyond the authorization');
  const offered = leg === 'forward' ? state.offer : state.request;
  const requested = leg === 'forward' ? state.request : state.offer;
  const amount = BigInt(leg === 'forward' ? state.principal : state.returnAmount ?? '0');
  const minimum = BigInt(leg === 'forward' ? state.forwardMinimum : state.reverseMinimum);
  const submit = await prepareMainnetSwapReview(walletB, live.service, offered, requested, amount, minimum);
  await submit();
  const result = await settle(walletB, state, leg, false);
  if (leg === 'forward') await authorizeReturn(state, runId, live, result);
  else completeReturn(state, result);
});
