import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Address } from '@miden-sdk/miden-sdk';

import { expect, test, type GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import {
  vaultBalanceByFaucetId,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from '../../helpers/balance-truth';
import { hexFaucetToBech32 } from '../../helpers/faucet-address';
import {
  readTransactionRows,
  readTransactionRowsWithBytes,
  waitForTransactionRow,
  TxStatus,
  type TransactionRowSnapshot
} from '../../helpers/history';
import { readMainnetMidenOwnNoteCreator } from '../../helpers/mainnet-miden-indexer';
import { fetchMainnetOneClickUsdPrices } from '../../helpers/mainnet-one-click-prices';
import { remainingMainnetLoopBudget } from '../../helpers/mainnet-loop-budget';
import {
  loadMainnetSwapCheckpoint,
  saveMainnetSwapCheckpoint,
  matchAuthorizedSwap,
  mainnetSwapNextAction,
  mainnetSwapRequestExpiresAt,
  swapProceeds,
  type MainnetSwapCheckpoint,
  type SavedSwapHolding,
  type SwapOrderEvidence
} from '../../helpers/mainnet-swap-checkpoint';
import {
  chooseMainnetSwapLoop,
  planMainnetSwapLoop,
  swapSearchAmounts,
  swapValue,
  realizedSwapLoss,
  SWAP_LOSS_CAP,
  SWAP_TX_FEE_MULTIPLE,
  type SwapLoopPlan
} from '../../helpers/mainnet-swap-plan';
import {
  prepareMainnetSwapReview,
  readLiveSwapLeg,
  recoveredSwapAutoAccept,
  swapDisplayAmount,
  runPreparedSwap,
  cachedSolverRegistry
} from '../../helpers/mainnet-swap-ui';
import { exportPublicInputNote, readLineage } from '../../helpers/swap';
import { getEnvironmentConfig } from '../../config/environments';
import {
  authorizeMainnetSwapRecoveryReturn,
  authorizeMainnetSwapReturnReplacement,
  prepareMainnetSwapClaimRecovery,
  readMainnetSwapReturnAbsence,
  readMainnetSwapPayback,
  type MainnetSwapPaybackEvidence,
  type MainnetSwapPaybackScope
} from '../../helpers/mainnet-swap-claim';
import { mainnetConsumeRequestHash } from '../../helpers/mainnet-epoch-request';
import {
  armMainnetConsumeAuthorization,
  releaseMainnetConsumeAuthorization
} from '../../helpers/mainnet-consume-authorization';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { armMainnetSendAuthorization, releaseMainnetSendAuthorization } from '../../helpers/mainnet-send-authorization';

const STATE_PATH = 'test-results/mainnet-swap-state/roundtrip.json';
const PRICE_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  USDC: 'usd-coin',
  USDCX: 'usd-coin',
  USDT: 'tether',
  SOL: 'solana',
  NEAR: 'near',
  PAXG: 'pax-gold'
};
test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial', retries: 0 });

const holding = (saved: SavedSwapHolding) => ({
  ...saved,
  balance: BigInt(saved.balance),
  usdMicros: BigInt(saved.usdMicros)
});

function persist(state: MainnetSwapCheckpoint): void {
  state.updatedAt = new Date().toISOString();
  saveMainnetSwapCheckpoint(STATE_PATH, state);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/mainnet-swap-summary.json', `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(
    'test-results/mainnet-swap-summary.md',
    [
      '### Mainnet solver swap loop',
      `- State: ${state.phase}`,
      `- Route: ${state.offer.symbol} -> ${state.request.symbol} -> ${state.offer.symbol}`,
      `- Principal: ${state.principal} base units; forward: ${state.forwardOrderId ?? 'not identified'}; reverse: ${state.reverseOrderId ?? 'not identified'}`,
      `- Native fees paid/budget: ${state.paidFees}/${state.feeBudget} base units`,
      `- Realized loss: ${state.realizedCostUsdMicros === undefined ? 'pending' : `$${swapDisplayAmount(BigInt(state.realizedCostUsdMicros), 6)}`}`,
      `- USD price snapshot: ${state.pricedAt}`,
      '- Amount search: $1.00, $1.01, $1.02, $1.05, $1.10, $1.25, $1.50, $2.00, rounded up to token precision.',
      '- Loss ceiling: $2, not a spend target. A pending or recovered cancellation is not passing swap coverage.',
      ''
    ].join('\n')
  );
}

async function balances(
  wallet: GuardianAwareWalletPage,
  state: Pick<MainnetSwapCheckpoint, 'offer' | 'request' | 'native'>
) {
  await wallet.refreshBalancesLanded(90_000);
  return {
    offer: await vaultBalanceByFaucetId(wallet.page, state.offer.faucetId),
    request: await vaultBalanceByFaucetId(wallet.page, state.request.faucetId),
    native: await vaultBalanceByFaucetId(wallet.page, state.native.faucetId)
  };
}

async function registry(wallet: GuardianAwareWalletPage) {
  let accepted: ReturnType<typeof cachedSolverRegistry> | undefined;
  await expect
    .poll(
      async () => {
        const stored = await wallet.page.evaluate(
          () =>
            new Promise<{ config: unknown; derived: unknown; tokenLists: unknown[] }>(resolve => {
              chrome.storage.local.get(
                [
                  'bridge_config_v1:mainnet',
                  'bridge_config_derived_v2:mainnet',
                  'token_list_cache_v2:mainnet',
                  'token_list_cache_v1:mainnet'
                ],
                items => {
                  resolve({
                    config: items['bridge_config_v1:mainnet'],
                    derived: items['bridge_config_derived_v2:mainnet'],
                    tokenLists: [items['token_list_cache_v2:mainnet'], items['token_list_cache_v1:mainnet']]
                  });
                }
              );
            })
        );
        try {
          accepted = cachedSolverRegistry(stored.config, stored.derived, stored.tokenLists);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 90_000, intervals: [1_000], message: 'The accepted mainnet solver registry did not hydrate' }
    )
    .toBe(true);
  if (!accepted) throw new Error('No accepted mainnet solver registry');
  const { pairs, service, priceAssets } = accepted;
  const assets = [
    ...pairs.tokens.flatMap(token => (token.binanceAsset ? [token.binanceAsset] : [])),
    ...priceAssets.values()
  ];
  const ids = [...new Set(assets.flatMap(asset => (PRICE_IDS[asset] ? [PRICE_IDS[asset]!] : [])))];
  const prices = await fetchMainnetOneClickUsdPrices(ids);
  const tokens: SavedSwapHolding[] = [];
  for (const token of pairs.tokens) {
    const faucetId = await hexFaucetToBech32(wallet, token.faucetId);
    const asset = priceAssets.get(faucetId.split('_')[0]!) ?? token.binanceAsset;
    const priceId = asset ? PRICE_IDS[asset] : undefined;
    const usdMicros = priceId ? prices.usdMicrosById[priceId] : undefined;
    if (!usdMicros) continue;
    tokens.push({
      faucetId,
      hex: token.faucetId,
      symbol: token.ticker,
      decimals: token.decimals,
      balance: (await vaultBalanceByFaucetId(wallet.page, faucetId)).toString(),
      usdMicros: usdMicros.toString()
    });
  }
  const nativeId = await walletDiscoveredNativeFaucetId(wallet.page);
  const native = tokens.find(token => token.faucetId === nativeId);
  if (!native) throw new Error('The native fee asset has no priced solver registry entry');
  const fee = await walletDiscoveredBaseFee(wallet.page);
  if (fee === null || !Number.isSafeInteger(fee) || fee <= 0)
    throw new Error('The wallet did not discover a positive native base fee');
  return { service, tokens, native, baseFee: BigInt(fee), pairs: pairs.pairs, prices };
}

async function prepare(
  wallet: GuardianAwareWalletPage,
  runId: string,
  live: Awaited<ReturnType<typeof registry>>
): Promise<MainnetSwapCheckpoint> {
  const allowance = remainingMainnetLoopBudget(runId, 'swap', []);
  const candidates: Array<{ plan: SwapLoopPlan; offer: SavedSwapHolding; request: SavedSwapHolding }> = [];
  for (const pair of live.pairs) {
    for (const direction of [pair.faucetIds, [...pair.faucetIds].reverse()]) {
      const offer = live.tokens.find(token => token.hex === direction[0]);
      const request = live.tokens.find(token => token.hex === direction[1]);
      if (!offer || !request || BigInt(offer.balance) === 0n) continue;
      for (const amount of swapSearchAmounts(holding(offer))) {
        try {
          const forward = await readLiveSwapLeg(live.service, offer, request, amount);
          const intermediateFees =
            request.faucetId === live.native.faucetId ? 2n * SWAP_TX_FEE_MULTIPLE * live.baseFee : 0n;
          const reverse = await readLiveSwapLeg(
            live.service,
            request,
            offer,
            forward.minimumReceive - intermediateFees
          );
          const plan = planMainnetSwapLoop({
            forward,
            reverse,
            native: holding(live.native),
            baseFee: live.baseFee,
            recoveryTxs: 2n
          });
          // Bound even an unexpected zero-value fill, not just the quoted spread.
          if (
            plan.worstCaseLossUsdMicros > allowance ||
            swapValue(holding(offer), amount) +
              swapValue(holding(live.native), 6n * SWAP_TX_FEE_MULTIPLE * live.baseFee) >
              allowance
          )
            continue;
          candidates.push({ plan, offer, request });
          break;
        } catch (error) {
          console.log(
            `Swap candidate ${offer.symbol}/${request.symbol} ${amount} refused: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }
  const chosen = chooseMainnetSwapLoop(candidates.map(candidate => candidate.plan));
  const candidate = candidates.find(entry => entry.plan === chosen);
  if (!chosen || !candidate)
    throw new Error('No funded two-way mainnet swap fits both $1 minima, reserves and the $2 safety cap');
  if (Date.now() - Date.parse(live.prices.pricesUpdatedAt) > 5 * 60_000)
    throw new Error('USD valuations expired during route selection');
  const oldRows = await readTransactionRows(wallet.page);
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    network: 'mainnet',
    account: await wallet.getAccountAddress(),
    sourceRunId: runId,
    authorizationRunId: runId,
    phase: 'forward-authorized',
    createdAt: timestamp,
    pricedAt: live.prices.pricesUpdatedAt,
    updatedAt: timestamp,
    offer: candidate.offer,
    request: candidate.request,
    native: live.native,
    baseFee: live.baseFee.toString(),
    principal: chosen.forward.offer.toString(),
    forwardMinimum: chosen.forward.minimumReceive.toString(),
    reverseMinimum: chosen.reverse.minimumReceive.toString(),
    knownOrderIds: oldRows.flatMap(row =>
      row.type === 'swap' && row.extraInputs?.orderId !== undefined ? [String(row.extraInputs.orderId)] : []
    ),
    feeBudget: (6n * SWAP_TX_FEE_MULTIPLE * live.baseFee).toString(),
    paidFees: '0',
    lossBudgetUsdMicros: allowance.toString()
  };
}

async function evidence(
  wallet: GuardianAwareWalletPage
): Promise<{ rows: TransactionRowSnapshot[]; orders: SwapOrderEvidence[] }> {
  const rows = await readTransactionRows(wallet.page);
  const orders: SwapOrderEvidence[] = [];
  for (const row of rows) {
    if (
      row.type !== 'swap' ||
      row.status !== 2 ||
      row.extraInputs?.orderId === undefined ||
      !row.accountId ||
      !row.faucetId ||
      !row.amount ||
      typeof row.extraInputs.requestedFaucetId !== 'string' ||
      row.extraInputs.requestedAmount === undefined ||
      row.completedAt === undefined
    )
      continue;
    const canonical = (id: string) => (id.startsWith('0x') ? hexFaucetToBech32(wallet, id) : Promise.resolve(id));
    orders.push({
      id: row.id,
      orderId: String(row.extraInputs.orderId),
      account: await canonical(row.accountId),
      offeredFaucet: await canonical(row.faucetId),
      requestedFaucet: await canonical(row.extraInputs.requestedFaucetId),
      offer: row.amount,
      minimumReceive: String(row.extraInputs.requestedAmount),
      initiatedAt: row.completedAt
    });
  }
  return { rows, orders };
}

async function settle(
  wallet: GuardianAwareWalletPage,
  state: MainnetSwapCheckpoint,
  leg: 'forward' | 'reverse',
  recover: boolean
): Promise<{ received: bigint; refunded: bigint; fees: bigint; now: Awaited<ReturnType<typeof balances>> }> {
  let order: SwapOrderEvidence | undefined;
  await expect
    .poll(
      async () => {
        await wallet.triggerSync(true);
        order = matchAuthorizedSwap(state, (await evidence(wallet)).orders, leg);
        return order !== undefined;
      },
      {
        timeout: 180_000,
        intervals: [5_000],
        message: 'No unique prior order found; submission is unresolved, never resubmit automatically'
      }
    )
    .toBe(true);
  if (!order) throw new Error('The authorized order is unresolved');
  const matched = order;
  if (leg === 'forward') state.forwardOrderId = matched.orderId;
  else state.reverseOrderId = matched.orderId;
  persist(state);
  const requestAuthority = leg === 'forward' ? state.forwardRequestAuthority : state.reverseRequestAuthority;
  if (!requestAuthority) throw new Error('Missing original SDK identity for exact payback verification');
  const scope: MainnetSwapPaybackScope = {
    kind: 'swap',
    accountId: Address.fromBech32(state.account).accountId().toString(),
    faucetId: (leg === 'forward' ? state.offer : state.request).hex,
    amount: leg === 'forward' ? state.principal : (state.returnAmount ?? '0'),
    requestedFaucetId: (leg === 'forward' ? state.request : state.offer).hex,
    requestedAmount: requestAuthority.minimumReceive,
    noteId: requestAuthority.noteId,
    orderId: requestAuthority.orderId
  };
  let payback: MainnetSwapPaybackEvidence | undefined;
  await expect
    .poll(
      async () => {
        payback = await readMainnetSwapPayback(getEnvironmentConfig().rpcUrl, scope);
        return payback !== undefined;
      },
      { timeout: 300_000, intervals: [5_000], message: 'Exact original full-fill payback not proved' }
    )
    .toBe(true);
  if (!payback) throw new Error('Missing exact original payback');
  const originalPayback = payback;
  const priorClaim = leg === 'forward' ? state.forwardClaimAuthority : state.reverseClaimAuthority;
  if (priorClaim) {
    if (
      priorClaim.noteId !== payback.noteId ||
      priorClaim.amount !== payback.amount.toString() ||
      payback.claimedAtBlock === undefined
    )
      throw new Error('Original claim outcome is unresolved; never rearm it');
  } else if (payback.claimedAtBlock !== undefined) {
    if (!recover) throw new Error('Payback already claimed without this run retained claim authority');
  } else {
    const gate = process.env.MAINNET_SWAP_SDK_GATE;
    if (!gate) throw new Error('Missing immutable SDK payback claim gate');
    const creation = (await readTransactionRows(wallet.page)).find(row => row.id === matched.id);
    const feeFaucet = creation?.feeFaucetId?.startsWith('0x')
      ? await hexFaucetToBech32(wallet, creation.feeFaucetId)
      : creation?.feeFaucetId;
    if (
      creation?.status !== 2 ||
      !creation.feeAmount ||
      !/^[1-9]\d{0,30}$/.test(creation.feeAmount) ||
      feeFaucet !== state.native.faucetId ||
      BigInt(state.paidFees) + BigInt(creation.feeAmount) + SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee) >
        BigInt(state.feeBudget)
    )
      throw new Error('Exact payback claim exceeds the remaining native fee budget');
    await wallet.triggerSync(true);
    const file = await exportPublicInputNote(wallet, payback.noteId);
    const handle = await armMainnetConsumeAuthorization(wallet.page, {
      accountId: scope.accountId,
      noteId: payback.noteId,
      canonicalSha256: mainnetConsumeRequestHash(Buffer.from(file, 'hex'), true)
    });
    const controller = new AbortController();
    try {
      await recoveredSwapAutoAccept(wallet.page, matched);
      await wallet.triggerSync(true);
      await releaseMainnetConsumeAuthorization(wallet.page, handle, {
        checkpointPath: STATE_PATH,
        gatePath: `${gate}.claim`,
        signal: controller.signal,
        persist: async authority => {
          const { requestCanonicalSha256, expiresAt } = authority;
          if (requestCanonicalSha256 === undefined || expiresAt === undefined)
            throw new Error('Missing final signed Guardian payback claim authority');
          const claim = {
            ...authority,
            requestCanonicalSha256,
            expiresAt,
            noteId: originalPayback.noteId,
            amount: originalPayback.amount.toString()
          };
          if (leg === 'forward') state.forwardClaimAuthority = claim;
          else state.reverseClaimAuthority = claim;
          persist(state);
        }
      });
    } finally {
      controller.abort();
    }
  }
  await wallet.page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/history-details/${matched.id}`);
  const target = leg === 'forward' ? state.request : state.offer;
  let received = 0n;
  let refunded = 0n;
  let fees = 0n;
  try {
    await expect
      .poll(
        async () => {
          await wallet.triggerSync(true);
          const current = await readTransactionRows(wallet.page);
          const orderRow = current.find(row => row.id === matched.id);
          const consumes = current.filter(
            row => row.type === 'consume' && row.extraInputs?.swapOrderTxId === matched.id && row.status === 2
          );
          const payments = consumes.filter(row => row.extraInputs?.swapSettleKind === 'settle');
          const reclaims = consumes.filter(row => row.extraInputs?.swapSettleKind === 'reclaim');
          if (!orderRow || (!payments.length && !(recover && reclaims.length))) return false;
          if (reclaims.length && !recover) throw new Error('Order was reclaimed, not a full swap');
          refunded = 0n;
          for (const row of reclaims) {
            const id = row.faucetId?.startsWith('0x') ? await hexFaucetToBech32(wallet, row.faucetId) : row.faucetId;
            const offeredId = leg === 'forward' ? state.offer.faucetId : state.request.faucetId;
            if (id !== offeredId || !row.amount)
              throw new Error('The reclaim has no attributable offered-token amount');
            refunded += BigInt(row.amount);
          }
          received = 0n;
          for (const row of payments) {
            const id = row.faucetId?.startsWith('0x') ? await hexFaucetToBech32(wallet, row.faucetId) : row.faucetId;
            if (id !== target.faucetId || !row.amount)
              throw new Error('The payback has no attributable requested-token amount');
            received += BigInt(row.amount);
          }
          fees = 0n;
          for (const row of [orderRow, ...consumes]) {
            const id = row.feeFaucetId?.startsWith('0x')
              ? await hexFaucetToBech32(wallet, row.feeFaucetId)
              : row.feeFaucetId;
            if (!row.feeAmount || id !== state.native.faucetId)
              throw new Error('A committed swap transaction has no verified native fee evidence');
            fees += BigInt(row.feeAmount);
          }
          const minimum = BigInt(leg === 'forward' ? state.forwardMinimum : state.reverseMinimum);
          if (received < minimum && !(recover && refunded > 0n)) return false;
          if (orderRow.extraInputs?.lineageClosedAt !== undefined) return true;
          const lineage = await readLineage(wallet, matched.orderId);
          return lineage.state === 'filled' || (recover && lineage.state === 'reclaimed');
        },
        { timeout: 300_000, intervals: [5_000], message: 'Swap did not fully settle and claim its payback' }
      )
      .toBe(true);
  } catch (error) {
    // One existing order may be reclaimed, but a failed fill is never reported as passing coverage.
    const cancel = wallet.page.getByTestId('swap-cancel-order-button');
    if (
      BigInt(state.paidFees) + fees + SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee) <= BigInt(state.feeBudget) &&
      (await cancel.isVisible().catch(() => false))
    ) {
      await cancel.click();
      await wallet.triggerSync(true);
    }
    throw error;
  }
  const now = await balances(wallet, state);
  const before =
    leg === 'forward'
      ? {
          offer: BigInt(state.offer.balance),
          request: BigInt(state.request.balance),
          native: BigInt(state.native.balance)
        }
      : state.returnBaseline
        ? {
            offer: BigInt(state.returnBaseline.offer),
            request: BigInt(state.returnBaseline.request),
            native: BigInt(state.returnBaseline.native)
          }
        : undefined;
  if (!before) throw new Error('Return authorization has no baseline');
  const offered = leg === 'forward' ? state.offer : state.request;
  const principal = BigInt(leg === 'forward' ? state.principal : (state.returnAmount ?? '0'));
  const targetBefore = leg === 'forward' ? before.request : before.offer;
  const targetAfter = leg === 'forward' ? now.request : now.offer;
  swapProceeds(targetBefore, targetAfter, received, target.faucetId === state.native.faucetId ? fees : 0n);
  const offerBefore = leg === 'forward' ? before.offer : before.request;
  const offerAfter = leg === 'forward' ? now.offer : now.request;
  expect(offerBefore - offerAfter, 'Unexpected offered-token debit or unclaimed remainder').toBe(
    principal - refunded + (offered.faucetId === state.native.faucetId ? fees : 0n)
  );
  const expectedNative =
    before.native -
    fees -
    (offered.faucetId === state.native.faucetId ? principal - refunded : 0n) +
    (target.faucetId === state.native.faucetId ? received : 0n);
  expect(now.native, 'Native balance does not reconcile with swap fees').toBe(expectedNative);
  return { received, refunded, fees, now };
}

async function authorizeReturn(
  state: MainnetSwapCheckpoint,
  runId: string,
  live: Awaited<ReturnType<typeof registry>>,
  result: Awaited<ReturnType<typeof settle>>
): Promise<void> {
  state.forwardReceived = result.received.toString();
  state.forwardRefunded = result.refunded.toString();
  state.paidFees = result.fees.toString();
  state.phase = 'forward-settled';
  persist(state);
  swapProceeds(
    BigInt(state.request.balance),
    result.now.request,
    result.received,
    state.request.faucetId === state.native.faucetId ? result.fees : 0n
  );
  const amount = result.now.request - BigInt(state.request.balance);
  if (amount <= 0n) throw new Error('The forward swap left no newly received return principal');
  const reverse = await readLiveSwapLeg(live.service, state.request, state.offer, amount);
  const paidUsd = swapValue(holding(state.native), result.fees);
  const loss =
    swapValue(holding(state.offer), BigInt(state.principal) - result.refunded) -
    swapValue(holding(state.offer), reverse.minimumReceive, false);
  const remaining = BigInt(state.feeBudget) - result.fees;
  if (remaining < 2n * SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee))
    throw new Error('No fee budget remains for the return create and claim');
  if (
    paidUsd + (loss > 0n ? loss : 0n) + swapValue(holding(state.native), remaining) >
    BigInt(state.lossBudgetUsdMicros ?? SWAP_LOSS_CAP)
  )
    throw new Error('Return exceeds the remaining $2 loss budget');
  if (swapValue(holding(state.request), amount, false) < 1_000_000n)
    throw new Error('Actual return proceeds are below the wallet $1 minimum');
  state.returnAmount = amount.toString();
  state.reverseMinimum = reverse.minimumReceive.toString();
  state.returnBaseline = {
    offer: result.now.offer.toString(),
    request: result.now.request.toString(),
    native: result.now.native.toString()
  };
  state.authorizationRunId = runId;
  state.phase = 'reverse-authorized';
  persist(state);
}

function completeReturn(state: MainnetSwapCheckpoint, result: Awaited<ReturnType<typeof settle>>): void {
  const totalFees = BigInt(state.paidFees) + result.fees;
  const loss = realizedSwapLoss([
    { before: holding(state.offer), after: result.now.offer },
    { before: holding(state.request), after: result.now.request },
    { before: holding(state.native), after: result.now.native }
  ]);
  if (result.refunded > 0n) throw new Error('Return was partially reclaimed; intermediate principal is unresolved');
  if (loss > BigInt(state.lossBudgetUsdMicros ?? SWAP_LOSS_CAP) || totalFees > BigInt(state.feeBudget))
    throw new Error('Realized round-trip loss or network fees exceeded the authorized budget');
  state.reverseReceived = result.received.toString();
  state.paidFees = totalFees.toString();
  state.realizedCostUsdMicros = loss.toString();
  state.phase = 'complete';
  persist(state);
  if (BigInt(state.forwardRefunded ?? '0') > 0n)
    throw new Error('Partial forward fill was safely recovered, not a passing full-fill acceptance');
}

async function recoverExistingSwapPayout(wallet: GuardianAwareWalletPage, state: MainnetSwapCheckpoint): Promise<void> {
  const authority = state.reverseRequestAuthority;
  const gate = process.env.MAINNET_SWAP_SDK_GATE;
  if (!authority || !gate) throw new Error('Missing original swap or immutable recovery claim gate');
  const scope: MainnetSwapPaybackScope = {
    kind: 'swap',
    accountId: Address.fromBech32(state.account).accountId().toString(),
    faucetId: state.request.hex,
    amount: state.returnAmount ?? '0',
    requestedFaucetId: state.offer.hex,
    requestedAmount: authority.minimumReceive,
    noteId: authority.noteId,
    orderId: authority.orderId
  };
  const payback = await readMainnetSwapPayback(getEnvironmentConfig().rpcUrl, scope);
  if (!payback) throw new Error('Original funded swap payout is unresolved; never resubmit');
  const before = await balances(wallet, state);
  const prepared = prepareMainnetSwapClaimRecovery(state, payback, before);
  const existing = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
    row.noteIds?.includes(payback.noteId)
  );
  if (
    existing.length ||
    (await readTransactionRows(wallet.page)).some(
      row =>
        row.status === TxStatus.Queued ||
        row.status === TxStatus.GeneratingTransaction ||
        row.status === TxStatus.Unconfirmed
    )
  )
    throw new Error('Existing claim or unrelated wallet activity prevents native claim');
  const creator = await readMainnetMidenOwnNoteCreator(authority.noteId, scope.accountId);
  if (creator.blockNumber !== payback.originalCreatedAtBlock)
    throw new Error('Original swap creator block differs from its inclusion proof');
  await wallet.triggerSync(true);
  const file = await exportPublicInputNote(wallet, payback.noteId);
  Object.assign(state, prepared);
  persist(state);
  const handle = await armMainnetConsumeAuthorization(wallet.page, {
    accountId: scope.accountId,
    noteId: payback.noteId,
    canonicalSha256: mainnetConsumeRequestHash(Buffer.from(file, 'hex'), true)
  });
  const controller = new AbortController();
  let queued: TransactionRowSnapshot | undefined;
  try {
    await wallet.page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/`);
    await wallet.page
      .locator(`[data-pending-note-id="${payback.noteId}"]`)
      .getByRole('button', { name: /^Accept$/ })
      .click();
    await expect
      .poll(
        async () => {
          const rows = (await readTransactionRowsWithBytes(wallet.page, 'consume')).filter(row =>
            row.noteIds?.includes(payback.noteId)
          );
          if (rows.length > 1) throw new Error('Ambiguous original payout claim rows');
          queued = rows[0];
          return queued?.id;
        },
        { timeout: 60_000 }
      )
      .toBeTruthy();
    if (!queued || queued.noteIds?.length !== 1) throw new Error('Claim includes unrelated notes');
    await releaseMainnetConsumeAuthorization(wallet.page, handle, {
      checkpointPath: STATE_PATH,
      gatePath: `${gate}.claim`,
      signal: controller.signal,
      persist: async captured => {
        if (captured.requestCanonicalSha256 === undefined || captured.expiresAt === undefined)
          throw new Error('Missing actual signed native claim authority');
        state.reverseClaimAuthority = {
          ...captured,
          requestCanonicalSha256: captured.requestCanonicalSha256,
          expiresAt: captured.expiresAt,
          noteId: payback.noteId,
          amount: payback.amount.toString()
        };
        persist(state);
      }
    });
    const receipt = await waitForTransactionRow(
      wallet.page,
      queued.id,
      row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
      { what: 'the exact recovered swap claim', timeoutMs: 300_000 }
    );
    const feeFaucet = receipt.feeFaucetId?.startsWith('0x')
      ? await hexFaucetToBech32(wallet, receipt.feeFaucetId)
      : receipt.feeFaucetId;
    if (
      receipt.status !== TxStatus.Completed ||
      !receipt.transactionId ||
      !/^0x[0-9a-f]{64}$/.test(receipt.transactionId) ||
      !receipt.feeAmount ||
      !/^[1-9]\d*$/.test(receipt.feeAmount) ||
      feeFaucet !== state.native.faucetId ||
      BigInt(receipt.feeAmount) > SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee)
    )
      throw new Error('Missing exact recovered consume receipt or authorized native fee');
    await wallet.refreshBalancesLanded(90_000);
    const now = await balances(wallet, state);
    const fees = BigInt(receipt.feeAmount);
    expect(now.request).toBe(before.request);
    expect(now.native).toBe(before.native + payback.amount - fees);
    let claimed: MainnetSwapPaybackEvidence | undefined;
    await expect
      .poll(
        async () => {
          claimed = await readMainnetSwapPayback(getEnvironmentConfig().rpcUrl, scope);
          return claimed?.claimedAtBlock !== undefined;
        },
        { timeout: 90_000 }
      )
      .toBe(true);
    completeReturn(state, { received: payback.amount, refunded: 0n, fees, now });
    writeFileSync(
      'test-results/mainnet-swap-recovery-claim.json',
      JSON.stringify(
        {
          sourceRunId: state.sourceRunId,
          authorityRunId: state.authorizationRunId,
          claimRunId: process.env.GITHUB_RUN_ID,
          originalNoteId: authority.noteId,
          creationTransactionId: creator.transactionId,
          creationAtBlock: creator.blockNumber,
          paybackNoteId: payback.noteId,
          paybackAmount: payback.amount.toString(),
          paybackCreatedAtBlock: payback.createdAtBlock,
          claimTransactionId: receipt.transactionId,
          claimedAtBlock: claimed?.claimedAtBlock,
          claimFee: receipt.feeAmount,
          aggregateNativeCosts: state.paidFees,
          nativeFinal: now.native.toString(),
          requestFinal: now.request.toString(),
          realizedCostUsdMicros: state.realizedCostUsdMicros
        },
        null,
        2
      )
    );
  } finally {
    controller.abort();
  }
}

test('real Guardian mainnet solver swaps out and back with recycled principal', async ({ walletB }) => {
  test.setTimeout(1_800_000);
  if (process.env.E2E_NETWORK !== 'mainnet') throw new Error('The funded swap loop requires mainnet');
  const runId = process.env.GITHUB_RUN_ID;
  const mode = process.env.MAINNET_SWAP_MODE;
  const key = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
  if (
    !runId ||
    !/^\d+$/.test(runId) ||
    !key ||
    !['recover', 'prepare', 'forward', 'reverse', 'authorize-recovery-return'].includes(mode ?? '')
  )
    throw new Error('Missing explicit mainnet swap mode, workflow identity or Guardian key');
  if (process.env.GITHUB_RUN_ATTEMPT !== '1')
    throw new Error('Do not rerun funded workflow jobs; use a new serialized run to reconcile prior state');
  await restoreMainnetLoopGuardian(walletB, key);
  await walletB.refreshBalancesLanded(90_000);
  let state = loadMainnetSwapCheckpoint(STATE_PATH);
  const account = await walletB.getAccountAddress();
  if (state && state.account !== account) throw new Error('The checkpoint belongs to a different Guardian account');
  if (mode === 'authorize-recovery-return') {
    const replacement = process.env.MAINNET_SWAP_RETURN_REPLACEMENT_APPROVED === 'true';
    const first = process.env.MAINNET_SWAP_RECOVERY_RETURN_APPROVED === 'true';
    if (first === replacement || !state?.forwardRequestAuthority)
      throw new Error('Missing distinct explicit recovery-return approval or original signed checkpoint');
    const original = state;
    const authority = state.forwardRequestAuthority;
    const scope: MainnetSwapPaybackScope = {
      kind: 'swap',
      accountId: Address.fromBech32(state.account).accountId().toString(),
      faucetId: state.offer.hex,
      amount: state.principal,
      requestedFaucetId: state.request.hex,
      requestedAmount: authority.minimumReceive,
      noteId: authority.noteId,
      orderId: authority.orderId
    };
    const proof = await readMainnetSwapPayback(getEnvironmentConfig().rpcUrl, scope);
    if (!proof || proof.claimedAtBlock === undefined)
      throw new Error('Original return proceeds are not proved and claimed');
    const live = await registry(walletB);
    if (live.baseFee > BigInt(state.baseFee))
      throw new Error('Native fee increased beyond the original recovery budget');
    const before = await balances(walletB, state);
    const quoted = await readLiveSwapLeg(live.service, state.request, state.offer, proof.amount);
    const floor =
      replacement &&
      state.reverseRequestAuthority &&
      BigInt(state.reverseRequestAuthority.minimumReceive) > BigInt(state.reverseMinimum)
        ? state.reverseRequestAuthority.minimumReceive
        : state.reverseMinimum;
    if (quoted.minimumReceive < BigInt(floor)) throw new Error('Recovery return quote weakened the original minimum');
    if (replacement) {
      if ((await readTransactionRows(walletB.page)).some(row => row.status === 0 || row.status === 1))
        throw new Error('Unresolved wallet activity prevents replacement authority');
      const absence = await readMainnetSwapReturnAbsence(getEnvironmentConfig().rpcUrl, state);
      state = authorizeMainnetSwapReturnReplacement(state, proof, before, runId, new Date().toISOString(), absence);
    } else state = authorizeMainnetSwapRecoveryReturn(state, proof, before, runId, new Date().toISOString());
    persist(state);
    writeFileSync(
      'test-results/mainnet-swap-recovery-grant.json',
      JSON.stringify(
        {
          sourceRunId: original.sourceRunId,
          recoveryRunId: runId,
          originalNoteId: authority.noteId,
          originalRequestSha256: authority.sha256,
          originalCanonicalSha256: authority.canonicalSha256,
          originalExpiresAt: authority.expiresAt,
          originalPricedAt: original.pricedAt,
          recordedOrderId: authority.orderId,
          verifiedProtocolOrderId: proof.orderId,
          returnAmount: state.returnAmount,
          recoveryReturnAuthorizedAt: state.recoveryReturnAuthorizedAt,
          recoveryReturnReplacement: state.recoveryReturnReplacement,
          returnExpiresAt: mainnetSwapRequestExpiresAt(state, 'reverse'),
          aggregateNativeCosts: state.paidFees,
          originalFeeBudget: state.feeBudget,
          paybackNoteId: proof.noteId,
          paybackCreatedAtBlock: proof.createdAtBlock,
          paybackClaimedAtBlock: proof.claimedAtBlock
        },
        null,
        2
      )
    );
    return;
  }
  if (
    mode === 'recover' &&
    state?.recoveryReturnAuthorizedAt !== undefined &&
    state.recoveredRunId === runId &&
    state.authorizationRunId === runId
  ) {
    const replacement = process.env.MAINNET_SWAP_RETURN_REPLACEMENT_APPROVED === 'true';
    const first = process.env.MAINNET_SWAP_RECOVERY_RETURN_APPROVED === 'true';
    if (
      first === replacement ||
      Boolean(state.recoveryReturnReplacement) !== replacement ||
      state.phase !== 'reverse-authorized' ||
      state.reverseRequestAuthority ||
      state.reverseOrderId ||
      Date.now() >= mainnetSwapRequestExpiresAt(state, 'reverse')
    )
      throw new Error('Fresh recovery grant changed, expired or already used; never renew it');
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow recovery output channel');
    appendFileSync(process.env.GITHUB_OUTPUT, 'recovery_only=true\n');
    return;
  }
  if (mode === 'prepare') {
    if (
      state?.recoveredRunId === runId ||
      (state?.phase === 'reverse-authorized' && state.authorizationRunId === runId)
    )
      return;
    if (mainnetSwapNextAction(state) !== 'prepare')
      throw new Error('Previous principal is unresolved; refusing a new forward swap');
    state = await prepare(walletB, runId, await registry(walletB));
    persist(state);
    return;
  }
  if (!state) {
    if (mode === 'recover' && process.env.MAINNET_SWAP_BOOTSTRAP === 'true') return;
    throw new Error('Missing durable swap authorization; do not bootstrap over a previous attempt');
  }
  if (mainnetSwapNextAction(state) === 'prepare') return;
  if (mainnetSwapNextAction(state) === 'stop')
    throw new Error('The checkpoint requires operator recovery before another spend');
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
      if (
        !baseline ||
        current.offer.toString() !== baseline.offer ||
        current.request.toString() !== baseline.request ||
        current.native.toString() !== baseline.native
      )
        throw new Error('Balances changed before return recovery');
      await authorizeReturn(state, runId, await registry(walletB), {
        received: BigInt(state.forwardReceived ?? '0'),
        refunded: BigInt(state.forwardRefunded ?? '0'),
        fees: BigInt(state.paidFees),
        now: await balances(walletB, state)
      });
      return;
    }
    if (state.phase === 'reverse-authorized' && state.reverseRequestAuthority && state.recoveryReturnReplacement) {
      await recoverExistingSwapPayout(walletB, state);
      return;
    }
    const leg = state.phase === 'reverse-authorized' ? 'reverse' : 'forward';
    const result = await settle(walletB, state, leg, true);
    if (leg === 'forward' && result.refunded === BigInt(state.principal) && result.received === 0n) {
      state.forwardReceived = '0';
      state.forwardRefunded = result.refunded.toString();
      state.paidFees = result.fees.toString();
      state.realizedCostUsdMicros = swapValue(holding(state.native), result.fees).toString();
      state.phase = 'cancelled';
      persist(state);
      throw new Error('Unfilled swap principal was fully reclaimed; full-fill acceptance failed');
    }
    if (leg === 'forward') await authorizeReturn(state, runId, await registry(walletB), result);
    else completeReturn(state, result);
    return;
  }
  if (mode === 'forward' && state.phase === 'reverse-authorized') return;
  const leg = mode === 'forward' ? 'forward' : 'reverse';
  if (state.phase !== `${leg}-authorized` || state.authorizationRunId !== runId)
    throw new Error('This run has no authorization to submit that swap leg');
  const authorized = state;
  if (leg === 'forward' ? authorized.forwardOrderId !== undefined : authorized.reverseOrderId !== undefined)
    throw new Error('This swap already has an order; reconcile it instead of submitting again');
  const observed = await evidence(walletB);
  if (
    observed.orders.some(
      row =>
        row.account === authorized.account &&
        row.initiatedAt >= Math.floor(Date.parse(authorized.createdAt) / 1000) - 30 &&
        !authorized.knownOrderIds.includes(row.orderId) &&
        !(leg === 'reverse' && row.orderId === authorized.forwardOrderId)
    )
  )
    throw new Error('A new unaccounted order exists; refusing to sign');
  const live = await runPreparedSwap(
    async () => {
      const snapshot = await registry(walletB);
      const before = await balances(walletB, authorized);
      const baseline =
        leg === 'forward'
          ? { offer: authorized.offer.balance, request: authorized.request.balance, native: authorized.native.balance }
          : authorized.returnBaseline;
      if (
        !baseline ||
        before.offer.toString() !== baseline.offer ||
        before.request.toString() !== baseline.request ||
        before.native.toString() !== baseline.native
      )
        throw new Error('Balances changed since swap authorization');
      if (snapshot.baseFee > BigInt(authorized.baseFee))
        throw new Error('Native fee increased beyond the authorization');
      if (leg === 'forward' && Date.now() - Date.parse(authorized.pricedAt) > 5 * 60_000)
        throw new Error('Forward authorization USD prices expired');
      const offered = leg === 'forward' ? authorized.offer : authorized.request;
      const requested = leg === 'forward' ? authorized.request : authorized.offer;
      const amount = BigInt(leg === 'forward' ? authorized.principal : (authorized.returnAmount ?? '0'));
      const minimum = BigInt(leg === 'forward' ? authorized.forwardMinimum : authorized.reverseMinimum);
      const gate = process.env.MAINNET_SWAP_SDK_GATE;
      if (!gate) throw new Error('Missing exact SDK swap authorization upload gate');
      const reviewed = await prepareMainnetSwapReview(walletB, snapshot.service, offered, requested, amount, minimum);
      const handle = await armMainnetSendAuthorization(walletB.page, {
        kind: 'swap',
        accountId: Address.fromBech32(authorized.account).accountId().toString(),
        faucetId: offered.hex,
        amount: amount.toString(),
        requestedFaucetId: requested.hex,
        requestedAmount: reviewed.minimumReceive,
        expiresAt: mainnetSwapRequestExpiresAt(authorized, leg)
      });
      return async () => {
        const controller = new AbortController();
        try {
          await Promise.all([
            reviewed.submit().catch(error => {
              controller.abort();
              throw error;
            }),
            releaseMainnetSendAuthorization(walletB.page, handle, {
              checkpointPath: STATE_PATH,
              gatePath: gate,
              signal: controller.signal,
              persist: async authority => {
                if (authority.orderId === undefined) throw new Error('Missing actual SDK PSWAP order identity');
                const request = {
                  ...authority,
                  orderId: authority.orderId,
                  minimumReceive: reviewed.minimumReceive,
                  expiresAt: handle.expiresAt
                };
                if (leg === 'forward') {
                  authorized.forwardRequestAuthority = request;
                  authorized.forwardOrderId = request.orderId;
                } else {
                  authorized.reverseRequestAuthority = request;
                  authorized.reverseOrderId = request.orderId;
                }
                persist(authorized);
              }
            })
          ]);
          return snapshot;
        } finally {
          controller.abort();
        }
      };
    },
    () => {
      authorized.phase = leg === 'forward' ? 'unspent' : 'forward-settled';
      persist(authorized);
    }
  );
  const result = await settle(walletB, state, leg, false);
  if (leg === 'forward') await authorizeReturn(state, runId, live, result);
  else completeReturn(state, result);
});
