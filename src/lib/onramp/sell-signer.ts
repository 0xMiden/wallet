/**
 * Sign the Calibur transfer batch of a sell order and post it to the backend.
 *
 * The backend sends only values (nonce, salt, deadline, amount, executor, deposit address). The wallet checks each
 * value against what it saw itself, builds the batch with `buy-batch.ts` and signs that. It never signs calldata
 * or a digest from the API. The deposit address the wallet trusts is the one the Transak page showed the user; a
 * backend that names another address is refused. A hacked backend can therefore at most make the wallet sign a
 * transfer of the expected amount to the address the user saw, through the Calibur code the bridge config names
 * (`getOnramp`).
 */
import { getAddress, isAddress, isAddressEqual, parseUnits, type Address, type Hex } from 'viem';

import { TRNSK_DECIMALS, TRNSK_SEPOLIA_ADDRESS, TRNSK_SYMBOL } from 'lib/agglayer/constant';
import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';
import type { OnrampConfig } from 'lib/remote-config/schema';
import { getOnramp } from 'lib/remote-config/values';

import { BackendOrder, BuyAuthorization, BuyOrderPrepare, BuyOrderState, postBuySignature } from './buy-api';
import { OFFRAMP_NONCE_KEY, SellBatchInput, sellBatchTypedData } from './buy-batch';

/** Clock skew that the deadline check accepts, in seconds. */
const DEADLINE_SKEW_SECONDS = 60;

/**
 * The token the relay of a sell transfers: TRNSK on Sepolia, which the Agglayer bridge-out of the sale releases at
 * the account's EVM address. Twin of the backend's `OFFRAMP_TOKENS[11155111]`.
 */
export const SELL_RELAY_TOKEN: { address: Address; decimals: number; symbol: string } = {
  address: TRNSK_SEPOLIA_ADDRESS,
  decimals: TRNSK_DECIMALS,
  symbol: TRNSK_SYMBOL
};

export type SellSignRefusal =
  | 'no-prepare'
  | 'side'
  | 'chain'
  | 'calibur'
  | 'evm-address'
  | 'miden-account'
  | 'token'
  | 'deposit-address'
  | 'nonce-key'
  | 'salt'
  | 'deadline'
  | 'amount'
  | 'crypto-amount'
  | 'signer';

export class SellSignRefusedError extends Error {
  readonly reason: SellSignRefusal;

  constructor(reason: SellSignRefusal, message: string) {
    super(message);
    this.name = 'SellSignRefusedError';
    this.reason = reason;
  }
}

export interface SellSignerAccount {
  /** Miden account public key (bech32). The vault signs with the EVM key of this account. */
  publicKey: string;
  evmAddress: string;
  /** Hex account ID of the same account, from `midenAccountIdToHex`. */
  midenAccountHex: string;
}

export interface SignSellOrderInput {
  account: SellSignerAccount;
  /** The deposit address the Transak page showed the user. The one source of truth for where the relay sends. */
  depositAddress: string;
  /** The crypto amount the Transak page showed, as a decimal string. */
  cryptoAmount: string;
  order: BackendOrder;
  /** Unix time in seconds. Tests set it; the default is the clock. */
  nowSeconds?: number;
}

function refuse(reason: SellSignRefusal, message: string): never {
  throw new SellSignRefusedError(reason, message);
}

/**
 * The exact base units the relay of a sell transfers for a crypto amount shown by Transak: the full amount, in the
 * decimals of the relay token. An amount with more fraction digits than the token has is refused, because
 * `parseUnits` rounds it.
 */
export function sellRelayTokenAmount(cryptoAmount: string): bigint {
  const match = /^\d+(?:\.(\d+))?$/.exec(cryptoAmount);
  if (match === null) return refuse('crypto-amount', 'Crypto amount is not a decimal number');
  if ((match[1]?.length ?? 0) > SELL_RELAY_TOKEN.decimals) {
    return refuse('crypto-amount', 'Crypto amount has more decimals than the token');
  }
  return parseUnits(cryptoAmount, SELL_RELAY_TOKEN.decimals);
}

/**
 * Check every backend value against the local account, what the Transak page showed and the bridge config's on-ramp
 * section. Return the batch input to sign and the section it was checked against, or throw `SellSignRefusedError`.
 * Throws `BridgeConfigUnavailableError` while no accepted document names an on-ramp; the caller tries again later.
 */
export function validateSellPrepare(input: SignSellOrderInput): {
  prepare: BuyOrderPrepare;
  batch: SellBatchInput;
  onramp: OnrampConfig;
} {
  const { account, order } = input;
  const prepare = order.prepare;
  if (!prepare) return refuse('no-prepare', 'Order has no signing values');
  if (order.side !== 'sell') refuse('side', 'Order is not a sell');

  const onramp = getOnramp();
  const { calibur } = onramp;
  if (prepare.chainId !== onramp.chainId) refuse('chain', 'Order is not on the on-ramp chain');
  if (!isAddressEqual(prepare.calibur, calibur.address)) refuse('calibur', 'Order names another Calibur');

  const evmAddress = account.evmAddress;
  if (!isAddress(evmAddress, { strict: false }) || !isAddressEqual(prepare.evmAddress, evmAddress)) {
    refuse('evm-address', 'Order names another EVM address');
  }
  if (prepare.midenAccountHex.toLowerCase() !== account.midenAccountHex.toLowerCase()) {
    refuse('miden-account', 'Order names another Miden account');
  }

  if (
    !isAddressEqual(order.tokenAddress, SELL_RELAY_TOKEN.address) ||
    order.tokenDecimals !== SELL_RELAY_TOKEN.decimals
  ) {
    refuse('token', 'Order names an unexpected token');
  }

  const depositAddress = input.depositAddress;
  const prepared = prepare.depositAddress;
  if (
    !isAddress(depositAddress, { strict: false }) ||
    prepared === undefined ||
    prepared === null ||
    !isAddressEqual(prepared, depositAddress)
  ) {
    refuse('deposit-address', 'Order names another deposit address than the Transak page');
  }

  const batchNonce = BigInt(prepare.batchNonce);
  if (batchNonce >> 64n !== OFFRAMP_NONCE_KEY) refuse('nonce-key', 'Order nonce is not in the off-ramp key');

  if (prepare.salt.slice(-40).toLowerCase() !== calibur.address.slice(2)) {
    refuse('salt', 'Order salt names another Calibur implementation');
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const latest = Math.min(now + calibur.batchTtlSeconds, order.autoExpiresAt ?? Number.MAX_SAFE_INTEGER);
  if (prepare.deadline <= now || prepare.deadline > latest + DEADLINE_SKEW_SECONDS) {
    refuse('deadline', 'Order deadline is not valid');
  }

  const amount = BigInt(prepare.tokenAmount);
  if (amount <= 0n || amount !== sellRelayTokenAmount(input.cryptoAmount)) {
    refuse('amount', 'Order token amount is not the amount of the sale');
  }

  return {
    prepare,
    batch: {
      evmAddress: prepare.evmAddress,
      token: order.tokenAddress,
      depositAddress,
      amount,
      batchNonce,
      salt: prepare.salt,
      executor: prepare.executor,
      deadline: BigInt(prepare.deadline)
    },
    onramp
  };
}

/** Validate, sign and post the transfer batch of one sell order. Return the new backend state. */
export async function signSellOrder(input: SignSellOrderInput): Promise<BuyOrderState> {
  const { prepare, batch, onramp } = validateSellPrepare(input);
  const client = buildVaultEvmWalletClient(input.account.publicKey, batch.evmAddress);
  const signer = client.account;
  if (!signer) return refuse('signer', 'EVM signing account unavailable');

  const signature: Hex = await client.signTypedData({ account: signer, ...sellBatchTypedData(batch) });

  let authorization: BuyAuthorization | undefined;
  if (prepare.needsAuthorization) {
    // Checksummed, as the vault's EVM client and the backend's authorization body carry it.
    const calibur: Address = getAddress(onramp.calibur.address);
    const signed = await client.signAuthorization({
      account: signer,
      contractAddress: calibur,
      chainId: onramp.chainId,
      nonce: prepare.authorizationNonce
    });
    if (signed.yParity === undefined) return refuse('signer', 'Authorization signature has no parity');
    authorization = {
      address: calibur,
      chainId: onramp.chainId,
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
