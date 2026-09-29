import type { Address, Hex } from 'viem';

import {
  BUY_BATCH_TTL_SECONDS,
  CALIBUR_SEPOLIA_ADDRESS,
  ONRAMP_NONCE_KEY,
  SEPOLIA_CHAIN_ID,
  type BuyBatchInput
} from './calibur.js';
import type { AccountState } from './sepolia.js';
import type { Order } from '../orders/store.js';

/** The values that the wallet signs. `GET /orders/:id` returns this object in `awaiting_signature`. */
export interface Preparation {
  chainId: number;
  calibur: Address;
  evmAddress: Address;
  midenAccountHex: string;
  executor: Address;
  /** Decimal string. */
  batchNonce: string;
  salt: Hex;
  /** Unix seconds. */
  deadline: number;
  needsAuthorization: boolean;
  authorizationNonce: number;
  /** Token base units, decimal string. */
  tokenAmount: string;
}

export function batchNonceOf(sequence: bigint): bigint {
  return (ONRAMP_NONCE_KEY << 64n) | sequence;
}

/** Build the fresh prepare values of an order. `nowMs` is the time in milliseconds. */
export function buildPreparation(
  order: Pick<Order, 'evmAddress' | 'midenAccountHex'>,
  tokenAmount: string,
  state: AccountState,
  executor: Address,
  nowMs: number
): Preparation {
  return {
    chainId: SEPOLIA_CHAIN_ID,
    calibur: CALIBUR_SEPOLIA_ADDRESS,
    evmAddress: order.evmAddress,
    midenAccountHex: order.midenAccountHex,
    executor,
    batchNonce: batchNonceOf(state.sequence).toString(),
    salt: state.salt,
    deadline: Math.floor(nowMs / 1000) + BUY_BATCH_TTL_SECONDS,
    needsAuthorization: state.needsAuthorization,
    authorizationNonce: state.authorizationNonce,
    tokenAmount
  };
}

/** The batch input of an order with its signed values. */
export function batchInputOf(
  order: Pick<Order, 'evmAddress' | 'midenAccountHex' | 'tokenAddress'>,
  signed: { tokenAmount: string; batchNonce: string; salt: Hex; deadline: number },
  executor: Address
): BuyBatchInput {
  return {
    evmAddress: order.evmAddress,
    midenAccountHex: order.midenAccountHex,
    token: order.tokenAddress,
    amount: BigInt(signed.tokenAmount),
    batchNonce: BigInt(signed.batchNonce),
    salt: signed.salt,
    executor,
    deadline: BigInt(signed.deadline)
  };
}
