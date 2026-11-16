import { sameAsset } from './assets';
import type { BridgeRoute } from './routes';

export interface TransferInputs {
  sourceConnected: boolean;
  destinationConnected: boolean;
  amount: string;
  insufficientBalance: boolean;
  quoteLoading: boolean;
  isSubmitting: boolean;
}
export type TransferAction =
  | 'submitting'
  | 'enter-amount'
  | 'connect-source'
  | 'connect-destination'
  | 'insufficient'
  | 'quote-loading'
  | 'review';

export function isValidAmount(amount: string): boolean {
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed > 0;
}

export function validateTransferAmount(route: BridgeRoute, amount: string): void {
  const value = amount.trim();
  const decimals = value.split('.')[1]?.length ?? 0;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || !isValidAmount(value) || decimals > route.source.decimals) {
    throw new Error('Invalid bridge source amount or precision');
  }
  if (route.provider === 'agglayer' && route.mode === 'receive') {
    const [whole, fraction = ''] = value.split('.');
    const precision = route.destination.decimals;
    if (/[1-9]/.test(fraction.slice(precision))) throw new Error('Unrepresentable bridge destination precision');
    const units = BigInt(whole + fraction.slice(0, precision).padEnd(precision, '0'));
    // The pinned SDK's FungibleAsset::MAX_AMOUNT, not a rounded display ceiling.
    if (units > (1n << 63n) - (1n << 31n)) throw new Error('Bridge amount exceeds Miden per-transfer limit');
  }
}

export function routeSwitchChangesAsset(from: BridgeRoute, to: BridgeRoute): boolean {
  return !sameAsset(from.source, to.source);
}

export function deriveTransferAction(input: TransferInputs): TransferAction {
  if (input.isSubmitting) return 'submitting';
  if (!isValidAmount(input.amount)) return 'enter-amount';
  if (!input.sourceConnected) return 'connect-source';
  if (!input.destinationConnected) return 'connect-destination';
  if (input.insufficientBalance) return 'insufficient';
  if (input.quoteLoading) return 'quote-loading';
  return 'review';
}
