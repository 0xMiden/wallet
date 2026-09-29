import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type SignedAuthorization
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { recoverAuthorizationAddress } from 'viem/utils';
import { z } from 'zod';

import {
  BUY_BATCH_TTL_SECONDS,
  buyBatchTypedData,
  CALIBUR_ABI,
  CALIBUR_DELEGATION,
  CALIBUR_RUNTIME_HASH,
  CALIBUR_SEPOLIA_ADDRESS,
  ERC20_ABI,
  ONRAMP_NONCE_KEY,
  SEPOLIA_CHAIN_ID,
  type BuyBatchInput
} from './calibur.js';
import type { Order } from './db.js';

/** The on-chain values that a prepare needs, read at one time. */
export interface AccountState {
  /** True when the EOA code is not the Calibur delegation (no code, or a different delegate). */
  needsAuthorization: boolean;
  /** The pending transaction count of the EOA. An authorization must use this nonce. */
  authorizationNonce: number;
  /** The Calibur sequence for `ONRAMP_NONCE_KEY`. */
  sequence: bigint;
  /** The `salt` of the Calibur `eip712Domain` of the EOA. */
  salt: Hex;
  /** The token balance of the EOA, in base units. */
  balance: bigint;
}

export type ReceiptStatus = 'success' | 'reverted' | null;

export interface RelayTransaction {
  /** The EOA. The relayer calls `execute` on it. */
  to: Address;
  data: Hex;
  authorization: SignedAuthorization | null;
}

export interface SentRelay {
  hash: Hex;
  /** The relayer nonce of the transaction. */
  nonce: number;
  /** True for an EIP-7702 (type 4) transaction. */
  type4: boolean;
}

/** The Sepolia access that the routes and the worker use. The tests give a fake. */
export interface Chain {
  /** The relayer address. It is the `executor` of each batch. */
  executor: Address;
  readAccount(evmAddress: Address, token: Address): Promise<AccountState>;
  readBalance(evmAddress: Address, token: Address): Promise<bigint>;
  /** Estimate the gas with the authorization list, then send. Do not wait for the receipt. */
  sendRelay(transaction: RelayTransaction): Promise<SentRelay>;
  /** Null when the node has no receipt yet. */
  getReceiptStatus(hash: Hex): Promise<ReceiptStatus>;
}

export interface SepoliaChainOptions {
  rpcUrl: string;
  relayerPrivateKey: Hex;
}

/** The Calibur implementation address in the last 20 bytes of the domain salt. */
function saltNamesCalibur(salt: Hex): boolean {
  return salt.slice(-40).toLowerCase() === CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase();
}

export function createSepoliaChain({ rpcUrl, relayerPrivateKey }: SepoliaChainOptions): Chain {
  const account = privateKeyToAccount(relayerPrivateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  function readBalance(evmAddress: Address, token: Address): Promise<bigint> {
    return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [evmAddress] });
  }

  async function readAccount(evmAddress: Address, token: Address): Promise<AccountState> {
    if (isAddressEqual(evmAddress, account.address)) {
      throw new Error('The relayer must be a different account from the buyer');
    }
    const [chainId, implementationCode, code, authorizationNonce, balance] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: CALIBUR_SEPOLIA_ADDRESS }),
      publicClient.getCode({ address: evmAddress }),
      publicClient.getTransactionCount({ address: evmAddress, blockTag: 'pending' }),
      readBalance(evmAddress, token)
    ]);
    if (chainId !== SEPOLIA_CHAIN_ID) {
      throw new Error('The RPC is not Ethereum Sepolia');
    }
    if (implementationCode === undefined || keccak256(implementationCode) !== CALIBUR_RUNTIME_HASH) {
      throw new Error('The Calibur runtime is not the pinned Sepolia deployment');
    }
    // Any code that is not the Calibur delegation (none, or a different delegate) needs a new authorization.
    const delegated = code !== undefined && code.toLowerCase() === CALIBUR_DELEGATION;
    // A code override for eth_call also reads the storage that stays from an earlier delegation.
    // Thus do not assume sequence 0 or a zero salt for an EOA that is not delegated now.
    const stateOverride = delegated ? undefined : [{ address: evmAddress, code: implementationCode }];
    const [sequence, domain] = await Promise.all([
      publicClient.readContract({
        address: evmAddress,
        abi: CALIBUR_ABI,
        functionName: 'getSeq',
        args: [ONRAMP_NONCE_KEY],
        stateOverride
      }),
      publicClient.readContract({ address: evmAddress, abi: CALIBUR_ABI, functionName: 'eip712Domain', stateOverride })
    ]);
    const [, name, version, domainChainId, verifyingContract, salt] = domain;
    if (
      name !== 'Calibur' ||
      version !== '1.0.0' ||
      domainChainId !== BigInt(SEPOLIA_CHAIN_ID) ||
      !isAddressEqual(verifyingContract, evmAddress) ||
      !saltNamesCalibur(salt)
    ) {
      throw new Error('The Calibur signing domain is not the expected domain');
    }
    return { needsAuthorization: !delegated, authorizationNonce, sequence, salt, balance };
  }

  async function sendRelay({ to, data, authorization }: RelayTransaction): Promise<SentRelay> {
    const authorizationList = authorization === null ? undefined : [authorization];
    // eth_estimateGas includes the authorization list, so it simulates the delegation and both calls together.
    // Do not use a plain eth_call on an EOA that is not delegated: it executes nothing and succeeds.
    const gas = await publicClient.estimateGas({ account, to, data, value: 0n, authorizationList });
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const hash = await walletClient.sendTransaction({
      account,
      chain: sepolia,
      to,
      data,
      value: 0n,
      authorizationList,
      nonce,
      gas: gas + gas / 5n
    });
    return { hash, nonce, type4: authorization !== null };
  }

  async function getReceiptStatus(hash: Hex): Promise<ReceiptStatus> {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return receipt.status;
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  return { executor: account.address, readAccount, readBalance, sendRelay, getReceiptStatus };
}

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

/**
 * Check a signed batch against the fresh prepare values and the stored amount.
 * Rebuild the batch from the order fields. Never take calldata from the client.
 * `nowMs` is the time in milliseconds. Throw `SignatureCheckError` when a check fails.
 */
export async function verifySignedBatch(
  order: Pick<Order, 'evmAddress' | 'midenAccountHex' | 'tokenAddress' | 'tokenAmount'>,
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
