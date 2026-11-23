import type { MainnetSwapCheckpoint, SavedSwapHolding } from './mainnet-swap-checkpoint';
import { SWAP_LOSS_CAP, SWAP_TX_FEE_MULTIPLE, swapValue } from './mainnet-swap-plan';

const WALLET_MINIMUM_USD_MICROS = 1_000_000n;
export const CANARY_SLOT_MS = 5 * 60_000;

export class CanaryBudgetError extends Error {}
export class CanaryQuoteError extends Error {}

export function canaryHolding(saved: SavedSwapHolding) {
  return { ...saved, balance: BigInt(saved.balance), usdMicros: BigInt(saved.usdMicros) };
}

export function canaryInteger(value: string | undefined, name: string): bigint {
  if (!value || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('Missing or invalid ' + name);
  return BigInt(value);
}

export function canarySlotEnd(slot: string): number {
  const stamp = Date.parse(slot);
  if (
    !Number.isSafeInteger(stamp) ||
    stamp % CANARY_SLOT_MS !== 0 ||
    new Date(stamp).toISOString().replace('.000Z', 'Z') !== slot
  ) {
    throw new Error('Invalid five-minute canary slot');
  }
  return stamp + CANARY_SLOT_MS;
}

export function planCanarySwap(input: {
  account: string;
  runId: string;
  offer: SavedSwapHolding;
  request: SavedSwapHolding;
  native: SavedSwapHolding;
  principal: bigint;
  baseFee: bigint;
  pricedAt: string;
  now: number;
  maxPrincipalUsdMicros: bigint;
  maxFeeBaseUnits: bigint;
  maxLossUsdMicros: bigint;
}) {
  const { account, runId, offer, request, native, principal, baseFee, pricedAt, now } = input;
  const age = now - Date.parse(pricedAt);
  if (!Number.isFinite(age) || age > CANARY_SLOT_MS || age < -30_000)
    throw new CanaryQuoteError('Canary needs contemporaneous USD valuation');
  const principalUsdMicros = swapValue(canaryHolding(offer), principal, false);
  const upperPrincipal = swapValue(canaryHolding(offer), principal);
  if (
    offer.hex === request.hex ||
    principalUsdMicros <= WALLET_MINIMUM_USD_MICROS ||
    upperPrincipal > input.maxPrincipalUsdMicros
  ) {
    throw new CanaryBudgetError('Canary principal outside authorized greater-than-$1 cohort');
  }
  const feeReserveBaseUnits = 2n * baseFee * SWAP_TX_FEE_MULTIPLE;
  const lossReserveUsdMicros = upperPrincipal + swapValue(canaryHolding(native), feeReserveBaseUnits);
  const nativePrincipal = offer.hex === native.hex ? principal : 0n;
  if (
    baseFee <= 0n ||
    feeReserveBaseUnits > input.maxFeeBaseUnits ||
    lossReserveUsdMicros > input.maxLossUsdMicros ||
    lossReserveUsdMicros > SWAP_LOSS_CAP ||
    BigInt(offer.balance) < principal ||
    BigInt(native.balance) < nativePrincipal + 2n * feeReserveBaseUnits
  ) {
    throw new CanaryBudgetError('Canary order or claim exceeds the authorized reserve');
  }
  const timestamp = new Date(now).toISOString();
  const checkpoint = (minimum: bigint, knownOrderIds: string[]): MainnetSwapCheckpoint => {
    if (swapValue(canaryHolding(request), minimum, false) < WALLET_MINIMUM_USD_MICROS)
      throw new CanaryQuoteError('Canary quote below wallet minimum');
    return {
      version: 1,
      network: 'mainnet',
      account,
      sourceRunId: runId,
      authorizationRunId: runId,
      phase: 'forward-authorized',
      createdAt: timestamp,
      pricedAt,
      updatedAt: timestamp,
      offer,
      request,
      native,
      principal: principal.toString(),
      baseFee: baseFee.toString(),
      forwardMinimum: minimum.toString(),
      // The shared checkpoint stores both minimum fields. The canary uses only the forward leg.
      reverseMinimum: minimum.toString(),
      knownOrderIds,
      feeBudget: feeReserveBaseUnits.toString(),
      lossBudgetUsdMicros: lossReserveUsdMicros.toString(),
      paidFees: '0'
    };
  };
  return { principalUsdMicros, feeReserveBaseUnits, lossReserveUsdMicros, checkpoint };
}
