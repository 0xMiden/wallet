// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/cctp-status.ts (MIT).
import { isAddress, isHash, isHex, parseUnits, type Hex } from 'viem';

import { bridgeOperationOf } from 'lib/bridge/operation';
import type { ITransaction } from 'lib/miden/db/types';
import { fetchCctpMessages, type AttestedCctpMessage } from 'lib/usdcx/cctp';
import type { UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { encodeExecutorHookData } from 'lib/usdcx/executor';

import {
  assertCctpArcReceipt,
  assertCctpSourceMessage,
  matchesCctpSourceMessage,
  type CctpReceipt
} from './cctp-message';

/** Missing tagged provenance is proof-pending, never the legacy observation path or new consent. */
export function ownedCctpSourceProof(row: ITransaction, source: UsdcxExecutorSource): Hex | undefined {
  const operation = bridgeOperationOf(row);
  const leg = row.extraInputs?.cctp;
  const raw = leg?.sourceMessage;
  if (
    !operation ||
    row.restoredFromBackup ||
    row.recovered ||
    !isHex(raw) ||
    !source.tokenMessenger ||
    typeof leg?.messageTransmitter !== 'string' ||
    !isAddress(leg.messageTransmitter) ||
    /^0x0{40}$/i.test(leg.messageTransmitter) ||
    !operation.sourceAttempt?.hash ||
    operation.sourceAttempt.hash !== row.extraInputs?.evmTxHash
  )
    return undefined;
  const { review } = operation;
  const account = `0x${review.accounts.evmAddress.slice(2)}` satisfies `0x${string}`;
  try {
    assertCctpSourceMessage(
      raw,
      source,
      parseUnits(review.amount, 6),
      encodeExecutorHookData(source.target, usdcxRemoteRecipientFor(review.accounts.midenAccount), account)
    );
    return raw;
  } catch {
    return undefined;
  }
}

export async function fetchOwnedAttestedCctpMessage(
  row: ITransaction,
  source: UsdcxExecutorSource,
  original: Hex
): Promise<AttestedCctpMessage | undefined> {
  const hash = row.extraInputs?.evmTxHash;
  if (!isHash(hash)) return undefined;
  const candidates = (await fetchCctpMessages(source.domain, hash, { baseUrl: source.irisApi })).filter(
    entry =>
      entry.status === 'complete' &&
      entry.attestation !== 'PENDING' &&
      matchesCctpSourceMessage(original, entry.message)
  );
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (!candidate || candidate.attestation === 'PENDING') return undefined;
  return { ...candidate, attestation: candidate.attestation };
}

export function assertOwnedCctpArcReceipt(
  row: ITransaction,
  source: UsdcxExecutorSource,
  original: Hex,
  hash: Hex,
  receipt: CctpReceipt
): void {
  const message = row.extraInputs?.cctp?.message;
  if (!isHex(message) || !row.faucetId || row.amount === undefined) throw new Error('Circle execution proof pending');
  assertCctpArcReceipt(receipt, hash, source, original, message, {
    amount: row.amount,
    recipient: usdcxRemoteRecipientFor(row.accountId),
    token: usdcxExpectedRemoteTokenFor(row.faucetId)
  });
}
