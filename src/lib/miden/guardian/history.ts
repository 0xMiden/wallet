import type { DeltaObject, HistoryEntry, ProposalMetadata } from '@openzeppelin/guardian-client';

import type { IConsumedAssetTotal, ITransaction, ITransactionType } from '../db/types';
import {
  ConsumeTransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwitchGuardianTransaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import type { GuardianHistoryNote, GuardianSummary } from '../sdk/guardian-history';
import type { ConsumableNote, NoteType } from '../types';
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

export type GuardianHistoryFailure =
  | 'account-not-found'
  | 'authentication'
  | 'unsupported'
  | 'network'
  | 'invalid-data';

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

function historyNoteVisibility(note: GuardianHistoryNote): NoteType {
  return note.visibility === 'private' ? NoteTypeEnum.Private : NoteTypeEnum.Public;
}

interface RecoveredTransactionInputs {
  accountId: string;
  type: ITransactionType;
  operator: string;
  proposal?: ProposalMetadata;
  amount?: bigint;
  faucetId?: string;
  recipient?: string;
  noteType: NoteType;
  inputNotes: GuardianHistoryNote[];
}

/**
 * Build the concrete transaction class for a recovered action when the
 * Guardian data carries every field its constructor requires. The caller then
 * overrides the queue fields the constructor set. Returns `undefined` when the
 * class needs data the Guardian does not retain: the swap requested side, the
 * bridge destination, the earn market, or the execute request bytes.
 *
 * A guardian switch records the retaining operator as the previous endpoint,
 * because that operator is the one the switch left.
 */
export function concreteRecoveredTransaction(inputs: RecoveredTransactionInputs): ITransaction | undefined {
  const { accountId, operator, proposal } = inputs;
  switch (inputs.type) {
    case 'send':
      if (inputs.amount === undefined || !inputs.faucetId || !inputs.recipient) return undefined;
      return new SendTransaction(accountId, inputs.amount, inputs.recipient, inputs.faucetId, inputs.noteType);
    case 'consume': {
      const notes: ConsumableNote[] = inputs.inputNotes.map(note => ({
        id: note.id,
        faucetId: note.assets[0]?.faucetId ?? '',
        amount: note.assets[0]?.amount ?? '',
        senderAddress: note.sender ?? '',
        isBeingClaimed: false,
        type: historyNoteVisibility(note)
      }));
      return notes.length > 0 ? new ConsumeTransaction(accountId, notes) : undefined;
    }
    case 'switch-guardian':
      if (!proposal?.newGuardianEndpoint) return undefined;
      return new SwitchGuardianTransaction(accountId, proposal.newGuardianEndpoint, undefined, operator);
    case 'replace-hot-key':
      return new ReplaceHotKeyTransaction(accountId);
    case 'update-procedure-threshold':
      if (!proposal?.targetProcedure || proposal.targetThreshold === undefined) return undefined;
      return new UpdateProcedureThresholdTransaction(accountId, proposal.targetProcedure, proposal.targetThreshold);
    default:
      return undefined;
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
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    throw new GuardianHistoryDataError('Invalid Guardian canonical timestamp');
  const proposal = delta.metadata?.proposal ?? delta.deltaPayload.metadata;
  const type = recoveredAction(proposal);
  const inputNotes: GuardianHistoryNote[] =
    summary?.inputNotes ??
    entry.inputNotes.map(note => ({
      id: note.noteId,
      assets: [],
      visibility: note.noteType
    }));
  const outputNotes: GuardianHistoryNote[] =
    summary?.outputNotes ??
    entry.outputNotes.map(note => ({
      id: note.noteId,
      assets: [],
      visibility: note.noteType
    }));
  const selectedNotes = type === 'consume' ? inputNotes : outputNotes;
  const totals = sumHistoryAssets(selectedNotes);
  const first = totals.length === 1 ? totals[0] : undefined;
  const finalCommitment = delta.newCommitment || entry.newCommitment || undefined;
  // The id travels in the route path, and the router does not decode a segment.
  // Keep it to characters no browser encodes in a hash and that never form a `/`.
  const identity = finalCommitment ?? `nonce-${entry.nonce}-${operator.replace(/[^a-z0-9]+/gi, '_')}`;
  const recipients = new Set(
    selectedNotes.map(note => (type === 'consume' ? note.sender : note.recipient)).filter(value => value !== undefined)
  );
  const recipient = recipients.size === 1 ? [...recipients][0] : undefined;
  const noteIds = selectedNotes.map(note => note.id);
  const reclaimed =
    type === 'consume' && inputNotes.length > 0 && inputNotes.every(note => note.sender === accountId.split('_')[0]);
  const secondaryAccountId =
    recipient ?? (type !== 'consume' && outputNotes.length <= 1 ? proposal?.recipientId : undefined);
  const noteType = selectedNotes[0] ? historyNoteVisibility(selectedNotes[0]) : NoteTypeEnum.Public;
  const id = `guardian-history:${network}:${canonicalAccountId}:${identity}`.replace(/[^a-z0-9:_-]+/gi, '_');
  const concrete = concreteRecoveredTransaction({
    accountId,
    type,
    operator,
    proposal,
    amount: first?.amount,
    faucetId: first?.faucetId,
    recipient: secondaryAccountId,
    noteType,
    inputNotes
  });
  const base: ITransaction = concrete ?? {
    id,
    type,
    accountId,
    status: ITransactionStatus.Completed,
    initiatedAt: timestamp,
    displayIcon: type === 'consume' ? 'RECEIVE' : 'DEFAULT'
  };
  // A constructor makes a queued row with a fresh id. Replace every queue field
  // with the canonical record, and keep the per-faucet totals of every asset.
  return Object.assign(base, {
    id,
    status: ITransactionStatus.Completed,
    initiatedAt: timestamp,
    completedAt: timestamp,
    queuedSeq: undefined,
    displayMessage: undefined,
    amount: first?.amount,
    faucetId: first?.faucetId,
    assetTotals: totals,
    secondaryAccountId,
    noteId: noteIds[0],
    noteIds,
    inputNoteIds: inputNotes.map(note => note.id),
    outputNoteIds: outputNotes.map(note => note.id),
    noteType,
    feeAmount: summary?.fee ? BigInt(summary.fee.amount) : undefined,
    feeFaucetId: summary?.fee?.faucetId,
    // The existing archive marker also blocks automation for recovered receipts.
    restoredFromBackup: true,
    recovered: true,
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
  });
}
