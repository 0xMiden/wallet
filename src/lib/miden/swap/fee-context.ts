import { getMessage } from 'lib/i18n/core';
import { getEffectiveFeeFaucetId } from 'lib/miden-chain/effective-endpoints';
import {
  cacheScope,
  getNativeAssetId,
  getNativeAssetIdSync,
  getVerificationBaseFee,
  getVerificationBaseFeeSync
} from 'lib/miden-chain/native-asset';

import { canonicalFaucetId } from './faucet-ids';

export interface SwapFeeContext {
  scope: string;
  nativeAssetId: string;
  feeFaucetId: string | null;
  baseFee: bigint;
}

const unavailable = () => new Error(getMessage('swapBalanceUnavailable'));

/** Resolve outside a WASM hold: fee discovery may use its own RPC client. */
export async function readSwapFeeContext(scope = cacheScope()): Promise<SwapFeeContext> {
  const feeFaucetId = activeFeeFaucetId();
  if (scope !== cacheScope()) throw unavailable();
  const nativeAssetId = await getNativeAssetId();
  const baseFee = await getVerificationBaseFee();
  return checkedFeeContext(scope, nativeAssetId, baseFee, feeFaucetId);
}

export function assertSwapFeeContextMatches(
  queued: SwapFeeContext,
  current: SwapFeeContext,
  expectedScope = queued.scope
): SwapFeeContext {
  if (
    queued.scope !== expectedScope ||
    current.scope !== expectedScope ||
    queued.nativeAssetId !== current.nativeAssetId ||
    queued.feeFaucetId !== current.feeFaucetId ||
    queued.baseFee !== current.baseFee
  ) {
    throw unavailable();
  }
  return current;
}

/** No RPC or nested WASM call; safe inside an execution hold after preflight primed discovery. */
export function getSwapFeeContextSync(scope = cacheScope()): SwapFeeContext {
  return checkedFeeContext(scope, getNativeAssetIdSync(), getVerificationBaseFeeSync(), activeFeeFaucetId());
}

function activeFeeFaucetId(): string | null {
  const id = getEffectiveFeeFaucetId();
  return id ? canonicalFaucetId(id) : null;
}

function checkedFeeContext(
  scope: string,
  nativeAssetId: string | null,
  baseFee: number | null,
  feeFaucetId: string | null
): SwapFeeContext {
  const canonicalNativeAssetId = nativeAssetId ? canonicalFaucetId(nativeAssetId) : null;
  if (!canonicalNativeAssetId || baseFee === null || !Number.isSafeInteger(baseFee) || baseFee < 0) throw unavailable();
  const context = { scope, nativeAssetId: canonicalNativeAssetId, feeFaucetId, baseFee: BigInt(baseFee) };
  assertSwapFeeContextCurrent(context, scope);
  return context;
}

export function assertSwapFeeContextCurrent(
  fee: SwapFeeContext,
  expectedScope = fee.scope,
  checkSyncBaseFee = false
): void {
  const currentNativeAssetId = getNativeAssetIdSync();
  const currentBaseFee = checkSyncBaseFee ? getVerificationBaseFeeSync() : null;
  if (
    fee.scope !== expectedScope ||
    fee.scope !== cacheScope() ||
    fee.feeFaucetId !== activeFeeFaucetId() ||
    (fee.feeFaucetId !== null && fee.nativeAssetId !== fee.feeFaucetId) ||
    (currentNativeAssetId !== null && canonicalFaucetId(currentNativeAssetId) !== fee.nativeAssetId) ||
    (currentBaseFee !== null &&
      (!Number.isSafeInteger(currentBaseFee) || currentBaseFee < 0 || BigInt(currentBaseFee) !== fee.baseFee))
  ) {
    throw unavailable();
  }
}
