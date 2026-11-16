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
export function isValidAmount(_amount: string): boolean {
  throw new Error('Unsupported bridge core');
}
export function validateTransferAmount(_route: BridgeRoute, _amount: string): void {
  throw new Error('Unsupported bridge core');
}
export function routeSwitchChangesAsset(_from: BridgeRoute, _to: BridgeRoute): boolean {
  throw new Error('Unsupported bridge core');
}
export function deriveTransferAction(_input: TransferInputs): TransferAction {
  throw new Error('Unsupported bridge core');
}
