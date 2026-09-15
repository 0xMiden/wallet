import type { DeltaObject, HistoryEntry, ProposalMetadata } from '@openzeppelin/guardian-client';

import type { IConsumedAssetTotal, ITransaction, ITransactionType } from '../db/types';
import { ITransactionStatus } from '../db/types';
import type { GuardianHistoryNote, GuardianSummary } from '../sdk/guardian-history';
import { NoteTypeEnum } from '../types';

export const GUARDIAN_HISTORY_VERSION = 1;
export class GuardianHistoryDataError extends Error {}

export interface GuardianHistoryRecovery {
  version: number;
  network: string;
  operators: string[];
  nonce: number;
  finalCommitment?: string;
  proposal?: ProposalMetadata;
  inputNotes: GuardianHistoryNote[];
  outputNotes: GuardianHistoryNote[];
  completeness: 'decoded' | 'partial';
  reclaimed: boolean;
}

export type GuardianHistoryFailure = 'account-not-found' | 'authentication' | 'unsupported' | 'network' | 'invalid-data';

export interface GuardianHistoryCheckpoint {
  id: string;
  network: string;
  accountId: string;
  operator: string;
  version: number;
  cursor?: string;
  seenCursors: string[];
  completed: boolean;
  restored: number;
  failure?: GuardianHistoryFailure;
}

export function recoveredAction(proposal?: ProposalMetadata): ITransactionType {
  switch (proposal?.proposalType) {
    case 'p2id':
    case 'recallable_send':
      return 'send';
    case 'consume_notes':
      return 'consume';
    case 'swap':
      return 'swap';
    case 'bridged_send':
    case 'agglayer_bridged_send':
      return 'bridged-send';
    case 'earn_deposit':
      return 'earn-deposit';
    case 'switch_guardian':
      return 'switch-guardian';
    case 'add_signer':
      return proposal.description === 'Replace device (hot) signer' ? 'replace-hot-key' : 'execute';
    case 'update_procedure_threshold':
      return 'update-procedure-threshold';
    default:
      return 'execute';
  }
}

export function normalizeHistoryOperators(endpoints: string[]): string[] {
  const operators = new Set<string>();
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      url.search = '';
      operators.add(url.toString().replace(/\/+$/, ''));
    } catch {
      // Ignore an invalid saved endpoint.
    }
  }
  return [...operators];
}

export function sumHistoryAssets(notes: GuardianHistoryNote[]): IConsumedAssetTotal[] {
  const totals = new Map<string, bigint>();
  for (const note of notes) {
    for (const asset of note.assets) {
      totals.set(asset.faucetId, (totals.get(asset.faucetId) ?? 0n) + BigInt(asset.amount));
    }
  }
  return [...totals].map(([faucetId, amount]) => ({ faucetId, amount }));
}

export function sameNonemptyNotes(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left?.length || !right?.length) return false;
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every(id => b.has(id));
}

export function historyCheckpointId(network: string, accountId: string, operator: string): string {
  return JSON.stringify([network, accountId, operator, GUARDIAN_HISTORY_VERSION]);
}

export function recoveredHistoryRecord(
  accountId: string,
  canonicalAccountId: string,
  network: string,
  operator: string,
  entry: HistoryEntry,
  delta: DeltaObject,
  summary?: GuardianSummary
): ITransaction {
  if (delta.accountId.toLowerCase() !== canonicalAccountId.toLowerCase() || delta.nonce !== entry.nonce) {
    throw new GuardianHistoryDataError('Guardian delta identity does not match the history entry');
  }
  if (entry.status !== 'canonical' || delta.status.status !== 'canonical' || !Number.isSafeInteger(entry.nonce)) {
    throw new GuardianHistoryDataError('Guardian history entry is not canonical');
  }
  if (entry.newCommitment && delta.newCommitment && entry.newCommitment !== delta.newCommitment) {
    throw new GuardianHistoryDataError('Guardian history commitments do not match');
  }
  if (summary && summary.accountId.toLowerCase() !== canonicalAccountId.toLowerCase()) {
    throw new GuardianHistoryDataError('Guardian summary belongs to another account');
  }
  const timestamp = Math.floor(Date.parse(delta.status.timestamp) / 1000);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new GuardianHistoryDataError('Invalid Guardian canonical timestamp');
  const proposal = delta.metadata?.proposal ?? delta.deltaPayload.metadata;
  const type = recoveredAction(proposal);
  const inputNotes: GuardianHistoryNote[] = summary?.inputNotes ?? entry.inputNotes.map(note => ({
    id: note.noteId, assets: [], visibility: note.noteType
  }));
  const outputNotes: GuardianHistoryNote[] = summary?.outputNotes ?? entry.outputNotes.map(note => ({
    id: note.noteId, assets: [], visibility: note.noteType
  }));
  const selectedNotes = type === 'consume' ? inputNotes : outputNotes;
  const totals = sumHistoryAssets(selectedNotes);
  const first = totals.length === 1 ? totals[0] : undefined;
  const finalCommitment = delta.newCommitment || entry.newCommitment || undefined;
  const identity = finalCommitment ?? JSON.stringify([operator, entry.nonce]);
  const recipients = new Set(selectedNotes.map(note => type === 'consume' ? note.sender : note.recipient)
    .filter(value => value !== undefined));
  const recipient = recipients.size === 1 ? [...recipients][0] : undefined;
  const noteIds = selectedNotes.map(note => note.id);
  const reclaimed = type === 'consume' && inputNotes.length > 0 && inputNotes.every(note => note.sender === accountId.split('_')[0]);
  return {
    id: `guardian-history:${JSON.stringify([network, canonicalAccountId, identity])}`,
    type,
    accountId,
    status: ITransactionStatus.Completed,
    initiatedAt: timestamp,
    completedAt: timestamp,
    displayIcon: type === 'consume' ? 'RECEIVE' : 'DEFAULT',
    amount: first?.amount,
    faucetId: first?.faucetId,
    assetTotals: totals,
    secondaryAccountId: recipient ?? (type !== 'consume' && outputNotes.length <= 1 ? proposal?.recipientId : undefined),
    noteId: noteIds[0],
    noteIds,
    inputNoteIds: inputNotes.map(note => note.id),
    outputNoteIds: outputNotes.map(note => note.id),
    noteType: selectedNotes[0]?.visibility === 'private' ? NoteTypeEnum.Private : NoteTypeEnum.Public,
    feeAmount: summary?.fee ? BigInt(summary.fee.amount) : undefined,
    feeFaucetId: summary?.fee?.faucetId,
    // The existing archive marker also blocks automation for recovered receipts.
    restoredFromBackup: true,
    recovery: {
      version: GUARDIAN_HISTORY_VERSION,
      network,
      operators: [operator],
      nonce: entry.nonce,
      finalCommitment,
      proposal,
      inputNotes,
      outputNotes,
      completeness: summary && proposal ? 'decoded' : 'partial',
      reclaimed
    }
  };
}
