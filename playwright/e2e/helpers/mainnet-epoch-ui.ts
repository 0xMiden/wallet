import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';
import { planOneClickRoundTrip, tokenValueUsdMicro, type OneClickRoundTripPlan } from './mainnet-one-click-plan';

export interface EpochInspectedCollateral {
  rowId: string;
  noteId: string;
  reclaimHeight: number;
}
export interface EpochForwardHooks<T> {
  enqueue: () => Promise<void>;
  inspect: () => Promise<EpochInspectedCollateral>;
  persist: (inspection: EpochInspectedCollateral) => Promise<void>;
  release: () => Promise<void>;
  settle: () => Promise<T>;
  cancelQueued: () => Promise<boolean>;
  unspent: () => Promise<void>;
  uncertain: () => Promise<void>;
}
export async function runGuardedEpochForward<T>(hooks: EpochForwardHooks<T>): Promise<T> {
  let mayHaveSubmitted = false;
  try {
    await hooks.enqueue();
    const inspected = await hooks.inspect();
    await hooks.persist(inspected);
    mayHaveSubmitted = true;
    await hooks.release();
    return await hooks.settle();
  } catch (error) {
    if (mayHaveSubmitted) {
      await hooks.uncertain();
    } else {
      let cancelled = false;
      try {
        cancelled = await hooks.cancelQueued();
      } catch {
        /* The held request remains unresolved. */
      }
      if (cancelled) await hooks.unspent();
      else await hooks.uncertain();
    }
    throw error;
  }
}

export function planEpochRoundTrip(state: MainnetEpochCheckpoint, returnInput: bigint): OneClickRoundTripPlan {
  parseMainnetEpochCheckpoint(state);
  const settled = ['forward-settled', 'reverse-authorized', 'complete'].includes(state.phase);
  const forward = BigInt(settled ? (state.forwardReceived ?? state.forwardMinimum) : state.forwardMinimum);
  if (returnInput <= 0n || returnInput > forward || BigInt(state.evm.nativeBalance) < BigInt(state.evmFeeBudget)) {
    throw new Error('Epoch return exceeds its attributed proceeds or existing gas balance');
  }
  const valuation = state.reverseAuthority?.valuation;
  const nativePrice = BigInt(valuation?.stableUsdMicros ?? state.native.usdMicros);
  const tokenPrice = BigInt(valuation?.stableUsdMicros ?? state.evm.tokenUsdMicros);
  const feeBudget = BigInt(state.feeBudget);
  const plan = planOneClickRoundTrip({
    routeId: `epoch:${state.evm.chainId}:${state.evm.token}`,
    symbol: state.native.symbol,
    amountBaseUnits: BigInt(state.principal),
    availableBaseUnits: BigInt(state.native.balance) - feeBudget,
    forward: {
      inputUsdMicros: tokenValueUsdMicro(BigInt(state.principal), 6, nativePrice, true),
      minimumOutputUsdMicros: tokenValueUsdMicro(forward, 6, tokenPrice, false),
      nativeFeeUsdMicros: tokenValueUsdMicro(feeBudget, 6, nativePrice, true)
    },
    reverse: {
      inputUsdMicros: tokenValueUsdMicro(returnInput, 6, tokenPrice, true),
      minimumOutputUsdMicros: tokenValueUsdMicro(BigInt(state.reverseMinimum), 6, nativePrice, false),
      nativeFeeUsdMicros: tokenValueUsdMicro(
        BigInt(state.evmFeeBudget),
        18,
        BigInt(valuation?.gasUsdMicros ?? state.evm.nativeUsdMicros),
        true
      )
    }
  });
  if (plan.worstCaseCostUsdMicros > BigInt(state.lossBudgetUsdMicros)) {
    throw new Error('Epoch quote exceeds the shared remaining mainnet loss allowance');
  }
  return plan;
}
