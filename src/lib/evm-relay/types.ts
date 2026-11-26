import type { Address, Hex } from 'viem';

import type { BatchCall } from './batch';

/** `sponsor`: the relayer pays the gas. `deduct`: the batch pays a fixed token fee to `feeRecipient`. */
export type RelayGasMode = 'sponsor' | 'deduct';

/** The fee of one token in `deduct` mode, in base units. The zero address is the native coin. */
export interface RelayTokenFee {
  token: Address;
  fee: bigint;
}

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
  /** The configured fees in `deduct` mode; empty in `sponsor` mode. */
  fees: RelayTokenFee[];
  /** The only targets that a batch can call (the fee call excepted), or null for no limit. */
  allowedTargets: Address[] | null;
  /** One entry for each distinct token that the read asked for, in the order of the request. */
  balances: RelayTokenBalance[];
}

export type RelayJobState = 'pending' | 'succeeded' | 'reverted';

/** A relay job. `id` is the EIP-712 digest of the batch. */
export interface RelayJob {
  id: Hex;
  state: RelayJobState;
  /** The last transaction hash. The hash of a final job is the mined hash. */
  txHash: Hex;
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
