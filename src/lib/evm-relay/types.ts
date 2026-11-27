import type { Address, Hash, Hex } from 'viem';

import type { BatchCall } from './batch';

/**
 * `sponsor`: the relayer pays the gas. `deduct`: the batch pays a fee to `feeRecipient` in a fee token. The relay
 * quotes the fee from its simulation of the batch (`POST /v1/quote`).
 */
export type RelayGasMode = 'sponsor' | 'deduct';

/** The balance of one token of a relay address, in base units. The zero address is the native coin. */
export interface RelayTokenBalance {
  token: Address;
  balance: bigint;
}

/** The answer of `GET /v1/account`: everything the wallet needs to sign a batch. Addresses and hashes are lower case. */
export interface RelayAccount {
  chainId: number;
  address: Address;
  mode: RelayGasMode;
  /** The relayer account. Only this account can execute the batch. */
  executor: Address;
  /** The fee recipient in `deduct` mode, null in `sponsor` mode. */
  feeRecipient: Address | null;
  /** True when the address does not delegate to the pinned Calibur yet. */
  needsAuthorization: boolean;
  /** The pending transaction count of the address. */
  authorizationNonce: number;
  /** The Calibur EIP-712 domain salt of the address. */
  salt: Hex;
  /** `getSeq(RELAY_NONCE_KEY)` of the address: a uint64. */
  sequence: bigint;
  /**
   * The tokens that the relay takes a fee in, in `deduct` mode (the zero address, the native coin, first); empty in
   * `sponsor` mode. Each token is there one time. The fee itself comes from a quote (`RelayQuote`).
   */
  feeTokens: Address[];
  /** The only targets that a batch can call (the fee call excepted), or null for no limit. */
  allowedTargets: Address[] | null;
  /** One entry for each distinct token that the read asked for, in the order of the request. */
  balances: RelayTokenBalance[];
}

/**
 * The answer of `POST /v1/quote`: the fee that the relay asks for one batch now, from its simulation of the calls.
 * Addresses are lower case. The relay does not store or sign a quote: the relay route decides again from its own
 * simulation of the signed batch.
 */
export interface RelayQuote {
  chainId: number;
  /** The fee token. The zero address is the native coin. */
  token: Address;
  /** The fee recipient. The guard requires the configured `relay.feeRecipient`. */
  recipient: Address;
  /** The fee in base units of `token`. */
  fee: bigint;
  /** The gas that the relay estimated for the batch with the fee call. */
  gas: bigint;
  /** Unix seconds. After this time the relay can ask for another fee. */
  validUntil: number;
}

/**
 * `pending`: not final. `succeeded`, `reverted`: the batch was mined. `expired`: final; the batch was not executed and
 * never will be, and `txHash` is the relayer's cancel transaction.
 */
export type RelayJobState = 'pending' | 'succeeded' | 'reverted' | 'expired';

/** A relay job. `id` is the EIP-712 digest of the batch. */
export interface RelayJob {
  id: Hex;
  state: RelayJobState;
  /** The last transaction hash. The hash of a final job is the mined hash (the cancel transaction when `expired`). */
  txHash: Hex;
}

/**
 * What a caller stores to follow a relay job after a lost answer or a restart. `id` is the batch digest that the
 * wallet computed before the POST, and `deadline` is the batch deadline in unix seconds.
 */
export interface RelayJobRef {
  chainId: number;
  id: Hex;
  deadline: number;
}

/** A relay job that succeeded. `hash` is the mined transaction hash. */
export interface RelayResult {
  id: Hex;
  hash: Hash;
}

/** The signed EIP-7702 authorization that delegates the address to Calibur. */
export interface RelayAuthorization {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

/** The input of `POST /v1/relay`. */
export interface RelaySubmission {
  chainId: number;
  evmAddress: Address;
  /** The calls exactly as signed. In `deduct` mode the last call pays the fee. */
  calls: BatchCall[];
  /** The full Calibur nonce: `RELAY_NONCE_KEY << 64 | sequence`. */
  batchNonce: bigint;
  salt: Hex;
  /** Unix seconds. */
  deadline: bigint;
  /** 65 bytes. */
  signature: Hex;
  authorization?: RelayAuthorization;
}
