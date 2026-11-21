import { performance } from 'node:perf_hooks';

import type { TestInfo } from '@playwright/test';

import { createOperation, createStage } from '../../../scripts/wallet-e2e/report.cjs';

type TokenAmount = { asset: string; baseUnits: string; decimals: number };

export type OperationContext = {
  key:
    | 'swap-forward'
    | 'swap-reverse'
    | 'swap-recovery'
    | 'epoch-forward'
    | 'epoch-reverse'
    | 'epoch-recovery'
    | 'near-forward'
    | 'near-reverse'
    | 'near-recovery'
    | 'usdcx-ethereum'
    | 'usdcx-base'
    | 'usdcx-arc'
    | 'usdcx-arbitrum'
    | 'agglayer-deposit'
    | 'agglayer-withdrawal'
    | 'native-round-trip'
    | 'registration';
  kind: 'swap' | 'bridge' | 'setup' | 'recovery' | 'other';
  surface?: 'wallet_ui' | 'helper_sdk' | 'wallet_ui_and_helper' | 'unknown';
  sourceRunId?: string;
  provider?: 'solver' | 'Epoch' | 'NEAR' | 'Circle xReserve' | 'Circle USDCx' | 'AggLayer';
  sourceNetwork?: 'Miden' | 'Ethereum' | 'Base' | 'Arc' | 'Polygon' | 'Arbitrum';
  destinationNetwork?: OperationContext['sourceNetwork'];
};

export type OperationOutcome = {
  outcome?:
    | 'prepared'
    | 'executed'
    | 'authorization_released'
    | 'included'
    | 'fully_filled'
    | 'partially_filled_and_refunded'
    | 'payment_unclaimed'
    | 'claimed'
    | 'usable_receipt'
    | 'refunded'
    | 'full_swap_asserted'
    | 'bridge_completion_asserted';
  recoveryEffect?: 'no_work' | 'read_only' | 'prior_authorized_claim' | 'prior_authorized_return';
  offered?: TokenAmount;
  minimum?: TokenAmount;
  received?: TokenAmount;
  fee?: TokenAmount;
};

/** A finished bridge recovery reports the outcome its settled checkpoint phase proves. */
export function recoveredBridgeOutcome(phase: string): OperationOutcome {
  const outcome = phase === 'cancelled' ? 'refunded' : phase === 'complete' ? 'bridge_completion_asserted' : undefined;
  return { recoveryEffect: 'prior_authorized_return', ...(outcome ? { outcome } : {}) };
}

type Stage = {
  key:
    | 'wallet_session'
    | 'quote_request'
    | 'quote_availability'
    | 'preparation'
    | 'approval'
    | 'execution'
    | 'proof'
    | 'submission'
    | 'inclusion'
    | 'order'
    | 'payback'
    | 'claim'
    | 'usable_receipt'
    | 'cleanup'
    | 'provider'
    | 'bridge_finality'
    | 'recovery_gate';
  origin: 'playwright' | 'wallet_assertion' | 'wallet_ui' | 'sdk_read' | 'provider';
  status: 'passed' | 'failed' | 'in_progress' | 'unknown';
  errorCode?: string;
  evidence?: 'observed' | 'not_recorded' | 'not_applicable';
  reason?: 'not_instrumented' | 'not_reached' | 'not_applicable' | 'report_incomplete';
  startAt?: string;
  endAt?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  deadlineAt?: string;
  endpoint?: 'inicio_swap_eta' | 'inicio_pair_price' | 'miden_mainnet_rpc';
  httpStatus?: number;
  priceAgeMs?: number;
};

export type ObserveNightly = (outcome?: OperationOutcome, stage?: Stage) => void;

// Record only hand-picked scalar evidence and never add reporting work for ordinary E2E runs.
export function observeNightly(info: TestInfo | undefined, context: OperationContext): ObserveNightly {
  if (!info || !process.env.E2E_WALLET_REPORT_INVOCATION) return () => {};
  return (outcome, stage) => {
    try {
      const operation = createOperation({ ...context, ...outcome });
      const stages = stage ? [createStage(stage)] : [];
      const description = JSON.stringify({ operation: { ...operation, stages }, timeout: info.timeout });
      info.annotations.push({ type: 'wallet-e2e-observation-v1', description });
    } catch {
      // Reporter data never decides whether the running wallet operation passes.
    }
  };
}

export function nightlyDuration() {
  const startAt = new Date().toISOString();
  const started = performance.now();
  return () => ({
    startAt,
    endAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started)
  });
}

export async function observedStage<T>(
  observe: ObserveNightly,
  stage: Omit<Stage, 'status'>,
  execute: () => Promise<T>
): Promise<T> {
  const timing = nightlyDuration();
  try {
    const result = await execute();
    const { errorCode, ...details } = stage;
    observe(undefined, { ...details, ...timing(), status: 'passed' });
    return result;
  } catch (error) {
    observe(undefined, { ...stage, ...timing(), status: 'failed' });
    throw error;
  }
}

export function nightlyAmount(asset: { symbol: string; decimals: number }, amount: bigint): TokenAmount | undefined {
  const symbol = asset.symbol.toUpperCase();
  if (
    ![
      'MIDEN',
      'USDC',
      'USDCX',
      'PAXG',
      'ETH',
      'BTC',
      'WBTC',
      'WETH',
      'WMATIC',
      'POL',
      'MATIC',
      'USDT',
      'SOL',
      'NEAR'
    ].includes(symbol)
  ) {
    return undefined;
  }
  if (
    amount < 0n ||
    amount >= 10n ** 30n ||
    !Number.isSafeInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > 24
  ) {
    return undefined;
  }
  return { asset: symbol === 'USDCX' ? 'USDCx' : symbol, decimals: asset.decimals, baseUnits: amount.toString() };
}
