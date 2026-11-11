import { tokenValueUsdMicro } from './mainnet-one-click-plan';

export const SWAP_LOSS_CAP = 2_000_000n;
// Same worst-case bound as the wallet's FEE_RESERVE_MULTIPLE, not the usual observed fee.
export const SWAP_TX_FEE_MULTIPLE = 30n;

export interface SwapHolding {
  faucetId: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  usdMicros: bigint;
}

export interface SwapLegBound {
  offered: SwapHolding;
  requested: SwapHolding;
  offer: bigint;
  minimumReceive: bigint;
  full: boolean;
  settlementsRunning: boolean;
}

export interface SwapLoopCandidate {
  forward: SwapLegBound;
  reverse: SwapLegBound;
  native: SwapHolding;
  baseFee: bigint;
  recoveryTxs: bigint;
}

export interface SwapLoopPlan extends SwapLoopCandidate {
  worstCaseLossUsdMicros: bigint;
  nativeReserve: bigint;
}

function validateHolding(holding: SwapHolding): void {
  if (
    !holding.faucetId ||
    !holding.symbol ||
    !Number.isSafeInteger(holding.decimals) ||
    holding.decimals < 0 ||
    holding.decimals > 12 ||
    holding.balance < 0n ||
    holding.usdMicros <= 0n
  ) {
    throw new Error('Invalid swap holding or USD price');
  }
}

export function swapValue(holding: SwapHolding, amount: bigint, roundUp = true): bigint {
  validateHolding(holding);
  return tokenValueUsdMicro(amount, holding.decimals, holding.usdMicros, roundUp);
}

export function planMainnetSwapLoop(candidate: SwapLoopCandidate): SwapLoopPlan {
  const { forward, reverse, native, baseFee, recoveryTxs } = candidate;
  validateHolding(native);
  if (baseFee <= 0n || recoveryTxs !== 2n) throw new Error('Invalid swap fee budget');
  if (
    forward.offered.faucetId !== reverse.requested.faucetId ||
    forward.requested.faucetId !== reverse.offered.faucetId ||
    forward.offered.faucetId === forward.requested.faucetId
  )
    throw new Error('Swap pair mismatch');
  for (const [left, right] of [
    [forward.offered, reverse.requested],
    [forward.requested, reverse.offered]
  ]) {
    if (!left || !right || left.decimals !== right.decimals || left.usdMicros !== right.usdMicros) {
      throw new Error('Swap scale or valuation mismatch');
    }
  }
  let loss = 0n;
  for (const leg of [forward, reverse]) {
    validateHolding(leg.offered);
    validateHolding(leg.requested);
    if (!leg.full || !leg.settlementsRunning) throw new Error('Swap cannot fully settle now');
    if (leg.offer <= 0n || leg.minimumReceive <= 0n) throw new Error('Invalid swap amount');
    const input = swapValue(leg.offered, leg.offer);
    if (swapValue(leg.offered, leg.offer, false) < 1_000_000n) throw new Error('Swap below $1 minimum');
    const output = swapValue(leg.requested, leg.minimumReceive, false);
    loss += input > output ? input - output : 0n;
  }
  const perTx = baseFee * SWAP_TX_FEE_MULTIPLE;
  const intermediateFees = forward.requested.faucetId === native.faucetId ? 2n * perTx : 0n;
  if (reverse.offer !== forward.minimumReceive - intermediateFees)
    throw new Error('Return must spend only net forward proceeds');
  if (forward.offer > forward.offered.balance) throw new Error('Swap principal is unfunded');
  const nativeReserve = 2n * (4n + recoveryTxs) * perTx;
  const nativePrincipal = forward.offered.faucetId === native.faucetId ? forward.offer : 0n;
  if (native.balance < nativePrincipal + nativeReserve) throw new Error('Native recovery/tomorrow reserve is unfunded');
  loss += (4n + recoveryTxs) * swapValue(native, perTx);
  if (loss > SWAP_LOSS_CAP) throw new Error('Swap exceeds $2 round-trip loss cap');
  return { ...candidate, worstCaseLossUsdMicros: loss, nativeReserve };
}

export function chooseMainnetSwapLoop(candidates: readonly SwapLoopPlan[]): SwapLoopPlan | undefined {
  return [...candidates].sort((left, right) => {
    for (const [a, b] of [
      [left.worstCaseLossUsdMicros, right.worstCaseLossUsdMicros],
      [swapValue(left.forward.offered, left.forward.offer), swapValue(right.forward.offered, right.forward.offer)]
    ]) {
      if (a !== undefined && b !== undefined && a !== b) return a < b ? -1 : 1;
    }
    return `${left.forward.offered.faucetId}/${left.forward.requested.faucetId}`.localeCompare(
      `${right.forward.offered.faucetId}/${right.forward.requested.faucetId}`
    );
  })[0];
}

export function realizedSwapLoss(samples: readonly { before: SwapHolding; after: bigint }[]): bigint {
  if (!samples.length) throw new Error('No balance evidence for swap loss');
  const seen = new Map<string, { before: SwapHolding; after: bigint }>();
  let loss = 0n;
  for (const sample of samples) {
    const { before, after } = sample;
    if (after < 0n) throw new Error('Invalid final swap balance');
    const previous = seen.get(before.faucetId);
    if (previous) {
      if (previous.before.balance !== before.balance || previous.after !== after ||
        previous.before.decimals !== before.decimals || previous.before.usdMicros !== before.usdMicros)
        throw new Error('Conflicting balance samples for the same swap asset');
      continue;
    }
    seen.set(before.faucetId, sample);
    const delta = before.balance - after;
    loss += delta >= 0n ? swapValue(before, delta) : -swapValue(before, -delta, false);
  }
  return loss > 0n ? loss : 0n;
}

export function swapSearchAmounts(holding: SwapHolding): bigint[] {
  validateHolding(holding);
  const scale = 10n ** BigInt(holding.decimals);
  return [
    ...new Set(
      [100n, 101n, 102n, 105n, 110n, 125n, 150n, 200n].map(
        cents => (cents * 10_000n * scale + holding.usdMicros - 1n) / holding.usdMicros
      )
    )
  ].filter(amount => amount <= holding.balance && swapValue(holding, amount) <= SWAP_LOSS_CAP);
}
