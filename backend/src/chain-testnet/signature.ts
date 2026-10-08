import {
  isAddress,
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type SignedAuthorization
} from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';
import { z } from 'zod';

import { BUY_BATCH_TTL_SECONDS, buyBatchTypedData, CALIBUR_SEPOLIA_ADDRESS, SEPOLIA_CHAIN_ID } from './calibur.js';
import { batchInputOf, type Preparation } from './preparation.js';
import type { Order } from '../orders/store.js';

const hexOfBytes = (bytes: number) =>
  z.custom<Hex>(
    value => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value),
    `must be ${bytes} bytes of hex`
  );

export const authorizationSchema = z.object({
  address: z.custom<Address>(value => typeof value === 'string' && isAddress(value), 'address is not valid'),
  chainId: z.number().int().nonnegative(),
  nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  r: hexOfBytes(32),
  s: hexOfBytes(32),
  yParity: z.union([z.literal(0), z.literal(1)])
});

export type AuthorizationBody = z.infer<typeof authorizationSchema>;

export const signatureBodySchema = z.object({
  batchNonce: z.string().regex(/^(0|[1-9][0-9]{0,77})$/, 'batchNonce is not a decimal integer'),
  salt: hexOfBytes(32),
  deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tokenAmount: z.string().regex(/^[1-9][0-9]{0,77}$/, 'tokenAmount is not a positive decimal integer'),
  signature: hexOfBytes(65),
  authorization: authorizationSchema.optional()
});

export type SignatureBody = z.infer<typeof signatureBodySchema>;

/** A check of a signed batch failed. The message is safe to send to the client. */
export class SignatureCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureCheckError';
  }
}

export function toSignedAuthorization(body: AuthorizationBody): SignedAuthorization {
  return {
    address: body.address,
    chainId: body.chainId,
    nonce: body.nonce,
    r: body.r,
    s: body.s,
    yParity: body.yParity
  };
}

/**
 * Check a signed batch against the fresh prepare values and the stored amount.
 * Rebuild the batch from the order fields. Never take calldata from the client.
 * `nowMs` is the time in milliseconds. Throw `SignatureCheckError` when a check fails.
 */
export async function verifySignedBatch(
  order: Pick<Order, 'evmAddress' | 'midenAccountHex' | 'tokenAmount'>,
  body: SignatureBody,
  current: Preparation,
  nowMs: number
): Promise<void> {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (order.tokenAmount === null || body.tokenAmount !== order.tokenAmount) {
    throw new SignatureCheckError('tokenAmount is not the amount of the order');
  }
  if (body.batchNonce !== current.batchNonce) {
    throw new SignatureCheckError('batchNonce is stale; prepare and sign again');
  }
  if (body.salt.toLowerCase() !== current.salt.toLowerCase()) {
    throw new SignatureCheckError('salt is not the Calibur domain salt');
  }
  if (body.deadline <= nowSeconds || body.deadline > nowSeconds + BUY_BATCH_TTL_SECONDS + 60) {
    throw new SignatureCheckError('deadline is not in the permitted window');
  }

  const typedData = buyBatchTypedData(batchInputOf(order, body, current.executor));
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typedData, signature: body.signature });
  } catch {
    throw new SignatureCheckError('signature does not parse');
  }
  if (!isAddressEqual(signer, order.evmAddress)) {
    throw new SignatureCheckError('signature is not from the order address');
  }

  const authorization = body.authorization;
  switch (true) {
    case !current.needsAuthorization && authorization !== undefined:
      throw new SignatureCheckError('the address is already delegated to Calibur; send no authorization');
    case !current.needsAuthorization:
      return;
    case authorization === undefined:
      throw new SignatureCheckError('authorization is missing');
    default:
      await verifyAuthorization(authorization, current, order.evmAddress);
  }
}

async function verifyAuthorization(
  authorization: AuthorizationBody,
  current: Preparation,
  evmAddress: Address
): Promise<void> {
  if (
    authorization.chainId !== SEPOLIA_CHAIN_ID ||
    authorization.nonce !== current.authorizationNonce ||
    !isAddressEqual(authorization.address, CALIBUR_SEPOLIA_ADDRESS)
  ) {
    throw new SignatureCheckError('authorization is stale or not for Calibur on Sepolia');
  }
  let authority: Address;
  try {
    authority = await recoverAuthorizationAddress({ authorization: toSignedAuthorization(authorization) });
  } catch {
    throw new SignatureCheckError('authorization signature does not parse');
  }
  if (!isAddressEqual(authority, evmAddress)) {
    throw new SignatureCheckError('authorization is not from the order address');
  }
}
