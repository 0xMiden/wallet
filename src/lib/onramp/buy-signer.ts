/**
 * Sign the Calibur bridge batch of a buy order and post it to the backend.
 *
 * The backend sends only values (nonce, salt, deadline, amount, executor). The wallet checks each value, builds the
 * batch itself with `buy-batch.ts` and signs that. It never signs calldata or a digest from the API. A hacked backend
 * can therefore at most make the wallet sign a bridge of the bought token to the user's own Miden account, with a
 * bounded amount, through the pinned Calibur code.
 */
import { isAddress, isAddressEqual, parseUnits, type Address, type Hex } from 'viem';

import { TRNSK_DECIMALS, TRNSK_SEPOLIA_ADDRESS } from 'lib/agglayer/constant';
import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import { BuyAuthorization, BuyOrder, BuyOrderPrepare, BuyOrderState, postBuySignature } from './buy-api';
import {
  BUY_BATCH_TTL_SECONDS,
  BuyBatchInput,
  CALIBUR_SEPOLIA_ADDRESS,
  ONRAMP_NONCE_KEY,
  SEPOLIA_CHAIN_ID,
  buyBatchTypedData
} from './buy-batch';

/** Clock skew that the deadline check accepts, in seconds. */
const DEADLINE_SKEW_SECONDS = 60;
/** The signed amount can be at most the fiat amount plus this margin, in percent. */
const AMOUNT_MARGIN_PERCENT = 105n;

export type BuySignRefusal =
  | 'no-prepare'
  | 'chain'
  | 'calibur'
  | 'evm-address'
  | 'miden-account'
  | 'token'
  | 'nonce-key'
  | 'salt'
  | 'deadline'
  | 'amount'
  | 'fiat-amount'
  | 'signer';

export class BuySignRefusedError extends Error {
  readonly reason: BuySignRefusal;

  constructor(reason: BuySignRefusal, message: string) {
    super(message);
    this.name = 'BuySignRefusedError';
    this.reason = reason;
  }
}

export interface BuySignerAccount {
  /** Miden account public key (bech32). The vault signs with the EVM key of this account. */
  publicKey: string;
  evmAddress: string;
  /** Hex account ID of the same account, from `midenAccountIdToHex`. */
  midenAccountHex: string;
}

export interface SignBuyOrderInput {
  account: BuySignerAccount;
  /** Fiat amount of the local buy row, as a decimal string. */
  fiatAmount: string;
  order: BuyOrder;
  /** Unix time in seconds. Tests set it; the default is the clock. */
  nowSeconds?: number;
}

function refuse(reason: BuySignRefusal, message: string): never {
  throw new BuySignRefusedError(reason, message);
}

/** The largest token amount that the wallet signs for a fiat amount, in base units. */
export function maxBuyTokenAmount(fiatAmount: string, tokenDecimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(fiatAmount)) refuse('fiat-amount', 'Fiat amount is not a decimal number');
  return (parseUnits(fiatAmount, tokenDecimals) * AMOUNT_MARGIN_PERCENT) / 100n;
}

/**
 * Check every backend value against the local account and the pinned constants. Return the batch input to sign, or
 * throw `BuySignRefusedError`.
 */
export function validateBuyPrepare(input: SignBuyOrderInput): { prepare: BuyOrderPrepare; batch: BuyBatchInput } {
  const { account, order } = input;
  const prepare = order.prepare;
  if (!prepare) return refuse('no-prepare', 'Order has no signing values');

  if (prepare.chainId !== SEPOLIA_CHAIN_ID) refuse('chain', 'Order is not on Sepolia');
  if (!isAddressEqual(prepare.calibur, CALIBUR_SEPOLIA_ADDRESS)) refuse('calibur', 'Order names another Calibur');

  const evmAddress = account.evmAddress;
  if (!isAddress(evmAddress, { strict: false }) || !isAddressEqual(prepare.evmAddress, evmAddress)) {
    refuse('evm-address', 'Order names another EVM address');
  }
  if (prepare.midenAccountHex.toLowerCase() !== account.midenAccountHex.toLowerCase()) {
    refuse('miden-account', 'Order names another Miden account');
  }

  if (!isAddressEqual(order.tokenAddress, TRNSK_SEPOLIA_ADDRESS) || order.tokenDecimals !== TRNSK_DECIMALS) {
    refuse('token', 'Order names an unexpected token');
  }

  const batchNonce = BigInt(prepare.batchNonce);
  if (batchNonce >> 64n !== ONRAMP_NONCE_KEY) refuse('nonce-key', 'Order nonce is not in the on-ramp key');

  if (prepare.salt.slice(-40).toLowerCase() !== CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase()) {
    refuse('salt', 'Order salt names another Calibur implementation');
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (prepare.deadline <= now || prepare.deadline > now + BUY_BATCH_TTL_SECONDS + DEADLINE_SKEW_SECONDS) {
    refuse('deadline', 'Order deadline is not valid');
  }

  const amount = BigInt(prepare.tokenAmount);
  if (amount <= 0n || amount > maxBuyTokenAmount(input.fiatAmount, TRNSK_DECIMALS)) {
    refuse('amount', 'Order token amount is out of range');
  }

  return {
    prepare,
    batch: {
      evmAddress: prepare.evmAddress,
      midenAccountHex: account.midenAccountHex.toLowerCase(),
      token: order.tokenAddress,
      amount,
      batchNonce,
      salt: prepare.salt,
      executor: prepare.executor,
      deadline: BigInt(prepare.deadline)
    }
  };
}

/** Validate, sign and post the batch of one order. Return the new backend state. */
export async function signBuyOrder(input: SignBuyOrderInput): Promise<BuyOrderState> {
  const { prepare, batch } = validateBuyPrepare(input);
  const client = buildVaultEvmWalletClient(input.account.publicKey, batch.evmAddress);
  const signer = client.account;
  if (!signer) return refuse('signer', 'EVM signing account unavailable');

  const signature: Hex = await client.signTypedData({ account: signer, ...buyBatchTypedData(batch) });

  let authorization: BuyAuthorization | undefined;
  if (prepare.needsAuthorization) {
    const signed = await client.signAuthorization({
      account: signer,
      contractAddress: CALIBUR_SEPOLIA_ADDRESS,
      chainId: SEPOLIA_CHAIN_ID,
      nonce: prepare.authorizationNonce
    });
    if (signed.yParity === undefined) return refuse('signer', 'Authorization signature has no parity');
    const calibur: Address = CALIBUR_SEPOLIA_ADDRESS;
    authorization = {
      address: calibur,
      chainId: SEPOLIA_CHAIN_ID,
      nonce: prepare.authorizationNonce,
      r: signed.r,
      s: signed.s,
      yParity: signed.yParity
    };
  }

  const response = await postBuySignature(input.order.id, {
    batchNonce: prepare.batchNonce,
    salt: prepare.salt,
    deadline: prepare.deadline,
    tokenAmount: prepare.tokenAmount,
    signature,
    ...(authorization ? { authorization } : {})
  });
  return response.state;
}
