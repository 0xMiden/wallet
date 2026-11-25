/**
 * The pending submission of the relay deposit engine (`deposit.ts`) in key-value storage. No storage hook reads the
 * key, so the engine writes it through the storage provider directly. A wallet reset removes it with every other key
 * that is not kept (`lib/miden/reset.ts`). The stored value is read back as untrusted JSON.
 */
import type { Address, Hex } from 'viem';

import type { IAgglayerDelivery } from 'lib/miden/db/types';
import type { AgglayerRecoveryConfig } from 'lib/remote-config/schema';

import type { RelaySubmissionBody } from './client';

/** What step 8 of a tick needs to write the row of a job. Amounts are decimal strings. */
export interface RelayRowDraft {
  accountId: string;
  /** The relay address: the EVM account that funds the deposit. */
  sourceAddress: string;
  chainId: number;
  token: Address;
  /** The bridged amount in source base units, as a WalletConnect Agglayer row stores it. */
  amount: string;
  sourceAmount: string;
  sourceSymbol: string;
  outputAmount: string;
  outputSymbol: string;
  agglayerRoute: AgglayerRecoveryConfig;
  agglayerDelivery?: IAgglayerDelivery;
}

/** A signed submission that the service may have accepted. It stays until a row holds its job. */
export interface RelayPendingSubmission {
  body: RelaySubmissionBody;
  /** The fee recipient of a `deduct` batch: the body names only the fee amount. */
  feeRecipient: Address | null;
  /** The EIP-712 digest of the batch. It is the id of the job. */
  digest: Hex;
  row: RelayRowDraft;
}

export function relayPendingKey(accountPublicKey: string, chainId: number): string {
  return `relay_pending_v1:${accountPublicKey}:${chainId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hex(value: unknown, length?: number): `0x${string}` | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  if (length !== undefined && value.length !== 2 + length) return null;
  return `0x${value.slice(2)}`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function decimal(value: unknown): string | null {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readAuthorization(value: unknown): RelaySubmissionBody['authorization'] | null {
  if (!isRecord(value)) return null;
  const address = hex(value.address, 40);
  const chainId = integer(value.chainId);
  const nonce = integer(value.nonce);
  const r = hex(value.r);
  const s = hex(value.s);
  const yParity = integer(value.yParity);
  if (!address || chainId === null || nonce === null || !r || !s || yParity === null) return null;
  return { address, chainId, nonce, r, s, yParity };
}

function readBody(value: unknown): RelaySubmissionBody | null {
  if (!isRecord(value) || !isRecord(value.params) || value.kind !== 'agglayer-deposit') return null;
  const { params } = value;
  const chainId = integer(value.chainId);
  const evmAddress = hex(value.evmAddress, 40);
  const token = hex(params.token, 40);
  const amount = decimal(params.amount);
  const midenAccountHex = text(params.midenAccountHex);
  const fee = decimal(params.fee);
  const batchNonce = decimal(value.batchNonce);
  const salt = hex(value.salt, 64);
  const deadline = integer(value.deadline);
  const signature = hex(value.signature);
  if (
    chainId === null ||
    !evmAddress ||
    !token ||
    amount === null ||
    midenAccountHex === null ||
    fee === null ||
    batchNonce === null ||
    !salt ||
    deadline === null ||
    !signature
  )
    return null;
  const body: RelaySubmissionBody = {
    chainId,
    kind: 'agglayer-deposit',
    evmAddress,
    params: { token, amount, midenAccountHex, fee },
    batchNonce,
    salt,
    deadline,
    signature
  };
  if (value.authorization === undefined) return body;
  const authorization = readAuthorization(value.authorization);
  return authorization ? { ...body, authorization } : null;
}

function readRoute(value: unknown): AgglayerRecoveryConfig | null {
  if (!isRecord(value)) return null;
  const contractAddress = hex(value.contractAddress, 40);
  const chainId = integer(value.chainId);
  const rollupId = integer(value.rollupId);
  const evmNetworkId = integer(value.evmNetworkId);
  const midenBridgeId = text(value.midenBridgeId);
  const indexerUrl = text(value.indexerUrl);
  if (!contractAddress || chainId === null || rollupId === null || evmNetworkId === null) return null;
  if (midenBridgeId === null || indexerUrl === null) return null;
  const route: AgglayerRecoveryConfig = { chainId, contractAddress, midenBridgeId, indexerUrl, rollupId, evmNetworkId };
  const nativeEthFaucetId = text(value.nativeEthFaucetId);
  const nativeEthScale = integer(value.nativeEthScale);
  return nativeEthFaucetId !== null && nativeEthScale !== null
    ? { ...route, nativeEthFaucetId, nativeEthScale }
    : route;
}

function readDelivery(value: unknown): IAgglayerDelivery | null {
  if (!isRecord(value)) return null;
  const originToken = text(value.originToken);
  const faucetId = text(value.faucetId);
  const scale = integer(value.scale);
  return originToken === null || faucetId === null || scale === null ? null : { originToken, faucetId, scale };
}

function readDraft(value: unknown): RelayRowDraft | null {
  if (!isRecord(value)) return null;
  const strings = [
    value.accountId,
    value.sourceAddress,
    value.sourceAmount,
    value.sourceSymbol,
    value.outputAmount,
    value.outputSymbol
  ].map(text);
  const [accountId, sourceAddress, sourceAmount, sourceSymbol, outputAmount, outputSymbol] = strings;
  const amount = decimal(value.amount);
  const chainId = integer(value.chainId);
  const token = hex(value.token, 40);
  const agglayerRoute = readRoute(value.agglayerRoute);
  const agglayerDelivery = value.agglayerDelivery === undefined ? undefined : readDelivery(value.agglayerDelivery);
  if (
    !accountId ||
    !sourceAddress ||
    !amount ||
    !sourceAmount ||
    !sourceSymbol ||
    !outputAmount ||
    !outputSymbol ||
    chainId === null ||
    !token ||
    !agglayerRoute ||
    agglayerDelivery === null
  )
    return null;
  const draft: RelayRowDraft = {
    accountId,
    sourceAddress,
    chainId,
    token,
    amount,
    sourceAmount,
    sourceSymbol,
    outputAmount,
    outputSymbol,
    agglayerRoute
  };
  return agglayerDelivery ? { ...draft, agglayerDelivery } : draft;
}

/** The stored value as a pending submission, or null when it is not one. */
export function readPendingSubmission(value: unknown): RelayPendingSubmission | null {
  if (!isRecord(value)) return null;
  const body = readBody(value.body);
  const digest = hex(value.digest, 64);
  const row = readDraft(value.row);
  const feeRecipient = value.feeRecipient === null ? null : hex(value.feeRecipient, 40);
  if (!body || !digest || !row || (value.feeRecipient !== null && !feeRecipient)) return null;
  return { body, feeRecipient, digest, row };
}
