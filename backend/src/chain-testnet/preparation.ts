import type { Address, Hex } from 'viem';

import {
  BUY_BATCH_TTL_SECONDS,
  CALIBUR_SEPOLIA_ADDRESS,
  nonceKeyOf,
  SEPOLIA_CHAIN_ID,
  type BatchInput
} from './calibur.js';
import type { AccountState } from './sepolia.js';
import { tokenOf } from './token.js';
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
  /** Sell only: Transak's deposit address, the recipient of the transfer. Null for a buy. */
  depositAddress: Address | null;
}

/** The order fields that the batch and the prepare values read. */
export type BatchOrder = Pick<Order, 'side' | 'evmAddress' | 'midenAccountHex' | 'depositAddress' | 'autoExpiresAt'>;

export function batchNonceOf(side: Order['side'], sequence: bigint): bigint {
  return (nonceKeyOf(side) << 64n) | sequence;
}

/**
 * The latest deadline of a signed batch, in unix seconds: 1 day, or the Transak expiry of a sell when that comes
 * first, so the signature dies with the order.
 */
export function latestDeadline(order: Pick<Order, 'autoExpiresAt'>, nowMs: number): number {
  const oneDay = Math.floor(nowMs / 1000) + BUY_BATCH_TTL_SECONDS;
  return order.autoExpiresAt === null ? oneDay : Math.min(oneDay, order.autoExpiresAt);
}

/** Build the fresh prepare values of an order. `nowMs` is the time in milliseconds. */
export function buildPreparation(
  order: BatchOrder,
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
    batchNonce: batchNonceOf(order.side, state.sequence).toString(),
    salt: state.salt,
    deadline: latestDeadline(order, nowMs),
    needsAuthorization: state.needsAuthorization,
    authorizationNonce: state.authorizationNonce,
    tokenAmount,
    depositAddress: order.side === 'sell' ? order.depositAddress : null
  };
}

/** The batch input of an order with its signed values. */
export function batchInputOf(
  order: BatchOrder,
  signed: { tokenAmount: string; batchNonce: string; salt: Hex; deadline: number },
  executor: Address
): BatchInput {
  return {
    side: order.side,
    evmAddress: order.evmAddress,
    midenAccountHex: order.midenAccountHex,
    token: tokenOf(order.side).address,
    depositAddress: order.side === 'sell' ? order.depositAddress : null,
    amount: BigInt(signed.tokenAmount),
    batchNonce: BigInt(signed.batchNonce),
    salt: signed.salt,
    executor,
    deadline: BigInt(signed.deadline)
  };
}
