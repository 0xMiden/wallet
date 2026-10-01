export type OrderState =
  | 'checkout'
  | 'awaiting_signature'
  | 'signed'
  | 'relay_sent'
  | 'deposited'
  | 'failed'
  | 'expired'
  | 'cancelled';

export const ORDER_STATES: readonly [OrderState, ...OrderState[]] = [
  'checkout',
  'awaiting_signature',
  'signed',
  'relay_sent',
  'deposited',
  'failed',
  'expired',
  'cancelled'
];

/**
 * The worker advances orders in these states. The other states are terminal.
 * The job of the backend stops at `deposited`: the relay is mined and the deposit is on Sepolia.
 * The wallet reads the Agglayer indexer for the claim on Miden.
 */
export const WORKER_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed', 'relay_sent'];

/** The worker watches the Transak feed for orders in these states. They can still get a Transak update. */
export const TRANSAK_FEED_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed'];

/**
 * An address has at most one order in these states. The states use the Calibur nonce of the EOA,
 * so one order at a time keeps the batch nonce serial.
 */
export const NONCE_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed', 'relay_sent'];
