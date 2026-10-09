/** A buy brings fiat in and bridges the bought token to Miden. A sell sends the released token to Transak. */
export type OrderSide = 'buy' | 'sell';

export const ORDER_SIDES: readonly [OrderSide, ...OrderSide[]] = ['buy', 'sell'];

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
 * The job of the backend stops at `deposited`: the relay is mined. For a buy the deposit is in the bridge on
 * Sepolia and the wallet reads the Agglayer indexer for the claim on Miden. For a sell the token is at Transak's
 * deposit address and Transak pays the fiat out.
 */
export const WORKER_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed', 'relay_sent'];

/** The worker watches the Transak feed for orders in these states. They can still get a Transak update. */
export const TRANSAK_FEED_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed'];

/**
 * An address has at most one order of each side in these states. The states use the Calibur nonce of the EOA,
 * so one order at a time keeps the batch nonce of that side serial.
 */
export const NONCE_STATES: readonly OrderState[] = ['checkout', 'awaiting_signature', 'signed', 'relay_sent'];
