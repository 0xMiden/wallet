import { NoteType as SdkNoteType, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';
import { GuardianHttpClient, type DeltaObject, type ProposalMetadata } from '@openzeppelin/guardian-client';

import {
  IBridgedSendExtraInputs,
  IEarnDepositExtraInputs,
  ITransaction,
  ITransactionIcon,
  ITransactionRecovery,
  ITransactionStatus,
  ITransactionType
} from 'lib/miden/db/types';
import { getSignerDetailsFromAccount, resolveGuardianEndpoint } from 'lib/miden/guardian/account';
import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';
import { WalletSigner } from 'lib/miden/guardian/signer';
import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getUncompletedTransactions } from 'lib/miden/transaction/get';
import { NoteType, NoteTypeEnum } from 'lib/miden/types';
import { b64ToU8 } from 'lib/shared/helpers';
import { GuardianTransactionRecoveryStatus, WalletAccount } from 'lib/shared/types';
import {
  clearGuardianNoteRecoveryProgress,
  reportGuardianNoteRecoveryProgress
} from 'lib/guardian-note-recovery-progress';

import { accountsUpdated } from './store';
import { midenClientProxy } from './miden-client-proxy';
import { doSync } from './sync-manager';
import type { Vault } from './vault';

export interface GuardianRecoveredAsset {
  faucetId: string;
  amount: bigint;
}

export interface GuardianRecoveredNote {
  noteId: string;
  senderAccountId?: string;
  noteType?: NoteType;
  assets: GuardianRecoveredAsset[];
}

export interface GuardianSummaryDetails {
  inputNotes: GuardianRecoveredNote[];
  outputNotes: GuardianRecoveredNote[];
}

export interface GuardianTransactionRecoveryResult {
  recoveredDeltas: number;
  missingDeltas: number;
  partialRows: number;
}

export interface GuardianPendingNoteRecoveryResult {
  proposalNotes: number;
  publicNotes: number;
  sourceFailures: number;
}

interface GuardianClientContext {
  guardian: GuardianHttpClient;
  accountNonce: number;
  /** Hex account id (`0x…`) — Guardian request signing (`AuthDigest`) rejects the composite bech32 publicKey. */
  guardianAccountId: string;
}

interface GuardianPendingNotePayload {
  proposalNoteBytes: Uint8Array[];
  proposalFetchFailed: boolean;
}

interface RecoveredSwapExtraInputs {
  requestedFaucetId: string;
  requestedAmount: bigint;
  autoConsume: boolean;
}

function withHexPrefix(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

function parseGuardianTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function parseAmount(amount: string | undefined): bigint | undefined {
  if (amount === undefined) return undefined;
  try {
    return BigInt(amount);
  } catch {
    return undefined;
  }
}

function firstAsset(notes: GuardianRecoveredNote[]): GuardianRecoveredAsset | undefined {
  for (const note of notes) {
    const asset = note.assets[0];
    if (asset) return asset;
  }
  return undefined;
}

function sumFirstFaucet(notes: GuardianRecoveredNote[], faucetId: string | undefined): bigint | undefined {
  if (!faucetId) return undefined;
  let found = false;
  let total = 0n;
  for (const note of notes) {
    for (const asset of note.assets) {
      if (asset.faucetId !== faucetId) continue;
      found = true;
      total += asset.amount;
    }
  }
  return found ? total : undefined;
}

function recoveredDisplay(type: ITransactionType): { icon: ITransactionIcon; message: string } {
  switch (type) {
    case 'send':
      return { icon: 'SEND', message: 'Sent' };
    case 'consume':
      return { icon: 'RECEIVE', message: 'Claimed' };
    case 'bridged-send':
      return { icon: 'SEND', message: 'Bridged to EVM' };
    case 'earn-deposit':
      return { icon: 'DEFAULT', message: 'Deposited to lending' };
    case 'swap':
      return { icon: 'SWAP', message: 'Swapped' };
    case 'switch-guardian':
      return { icon: 'DEFAULT', message: 'Guardian switched' };
    case 'replace-hot-key':
      return { icon: 'DEFAULT', message: 'Device key rotated' };
    case 'update-procedure-threshold':
      return { icon: 'DEFAULT', message: 'Account secured' };
    case 'bridged-receive':
    case 'earn-withdraw':
    case 'execute':
    default:
      return { icon: 'DEFAULT', message: 'Executed' };
  }
}

function markPartial(recovery: ITransactionRecovery): void {
  recovery.detail = 'partial';
}

function applySendFields(
  row: ITransaction,
  metadata: ProposalMetadata | undefined,
  summary: GuardianSummaryDetails
): void {
  const asset = firstAsset(summary.outputNotes);
  row.type = 'send';
  row.secondaryAccountId = metadata?.recipientId;
  row.faucetId = metadata?.faucetId ?? asset?.faucetId;
  row.amount = parseAmount(metadata?.amount) ?? asset?.amount;
  row.noteType = metadata?.noteType === 'private' ? NoteTypeEnum.Private : NoteTypeEnum.Public;
}

function applyConsumeFields(row: ITransaction, summary: GuardianSummaryDetails): void {
  const firstNote = summary.inputNotes[0];
  const asset = firstAsset(summary.inputNotes);
  const noteIds = summary.inputNotes.map(note => note.noteId);
  row.type = 'consume';
  row.noteId = noteIds[0];
  row.noteIds = noteIds;
  row.secondaryAccountId = firstNote?.senderAccountId;
  row.faucetId = asset?.faucetId;
  row.amount = sumFirstFaucet(summary.inputNotes, asset?.faucetId);
  row.noteType = firstNote?.noteType;
}

function applyCustomAssetFields(row: ITransaction, summary: GuardianSummaryDetails): void {
  const asset = firstAsset(summary.outputNotes);
  row.faucetId = asset?.faucetId;
  row.amount = asset?.amount;
  row.noteType = summary.outputNotes[0]?.noteType;
}

export function mapGuardianDeltaToTransaction(
  accountId: string,
  delta: DeltaObject,
  summary: GuardianSummaryDetails
): ITransaction {
  const timestamp = parseGuardianTimestamp(delta.status.timestamp);
  const recovery: ITransactionRecovery = {
    source: 'guardian-delta',
    guardianNonce: delta.nonce,
    detail: timestamp === undefined ? 'partial' : 'complete'
  };
  const row: ITransaction = {
    id: `guardian-recovery:${accountId}:${delta.nonce}`,
    type: 'execute',
    accountId,
    status: ITransactionStatus.Completed,
    initiatedAt: timestamp ?? 0,
    completedAt: timestamp ?? 0,
    displayIcon: 'DEFAULT',
    displayMessage: 'Executed',
    inputNoteIds: summary.inputNotes.map(note => note.noteId),
    outputNoteIds: summary.outputNotes.map(note => note.noteId),
    recovery
  };

  const metadata = delta.deltaPayload.metadata;
  switch (metadata?.proposalType) {
    case 'p2id':
      applySendFields(row, metadata, summary);
      if (!row.secondaryAccountId || !row.faucetId || row.amount === undefined) markPartial(recovery);
      break;
    case 'consume_notes':
      applyConsumeFields(row, summary);
      if (!row.noteId || !row.faucetId) markPartial(recovery);
      break;
    case 'recallable_send':
      applySendFields(row, metadata, summary);
      markPartial(recovery);
      break;
    case 'bridged_send': {
      applyCustomAssetFields(row, summary);
      row.type = 'bridged-send';
      const extraInputs: IBridgedSendExtraInputs = {
        provider: 'epoch',
        destinationAddress: '',
        destinationNetwork: 0,
        sourceFaucetId: row.faucetId ?? '',
        claimStatus: 'not-applicable'
      };
      row.extraInputs = extraInputs;
      markPartial(recovery);
      break;
    }
    case 'agglayer_bridged_send': {
      applyCustomAssetFields(row, summary);
      row.type = 'bridged-send';
      const extraInputs: IBridgedSendExtraInputs = {
        provider: 'agglayer',
        destinationAddress: '',
        destinationNetwork: 0,
        sourceFaucetId: row.faucetId ?? '',
        claimStatus: 'not-applicable'
      };
      row.extraInputs = extraInputs;
      markPartial(recovery);
      break;
    }
    case 'earn_deposit': {
      applyCustomAssetFields(row, summary);
      row.type = 'earn-deposit';
      const extraInputs: IEarnDepositExtraInputs = {
        evmRecipient: '',
        marketUid: '',
        sourceFaucetId: row.faucetId ?? ''
      };
      row.extraInputs = extraInputs;
      markPartial(recovery);
      break;
    }
    case 'swap': {
      applyCustomAssetFields(row, summary);
      row.type = 'swap';
      const extraInputs: RecoveredSwapExtraInputs = {
        requestedFaucetId: '',
        requestedAmount: 0n,
        autoConsume: false
      };
      row.extraInputs = extraInputs;
      markPartial(recovery);
      break;
    }
    case 'switch_guardian':
      row.type = 'switch-guardian';
      row.extraInputs = { newGuardianEndpoint: metadata.newGuardianEndpoint ?? '' };
      markPartial(recovery);
      break;
    case 'update_procedure_threshold':
      row.type = 'update-procedure-threshold';
      row.extraInputs = {
        procedure: metadata.targetProcedure ?? '',
        threshold: metadata.targetThreshold ?? 0
      };
      if (!metadata.targetProcedure || metadata.targetThreshold === undefined) markPartial(recovery);
      break;
    case 'add_signer':
      row.type = 'replace-hot-key';
      row.extraInputs = {};
      markPartial(recovery);
      break;
    case 'remove_signer':
    case 'change_threshold':
    case 'custom_transaction':
    case 'custom':
    case undefined:
    default:
      row.type = 'execute';
      markPartial(recovery);
      break;
  }

  const display = recoveredDisplay(row.type);
  row.displayIcon = display.icon;
  row.displayMessage = display.message;
  return row;
}

function sdkNoteTypeToWallet(noteType: SdkNoteType): NoteType {
  switch (noteType) {
    case SdkNoteType.Private:
      return NoteTypeEnum.Private;
    case SdkNoteType.Public:
    default:
      return NoteTypeEnum.Public;
  }
}

/**
 * Currently only referenced by the dormant history walk in
 * `recoverTransactionHistory` (exported keeps it compiled and reusable).
 */
export function decodeSummary(delta: DeltaObject): GuardianSummaryDetails {
  const summary = TransactionSummary.deserialize(b64ToU8(delta.deltaPayload.txSummary.data));
  const inputNotes = summary
    .inputNotes()
    .notes()
    .map(inputNote => {
      const note = inputNote.note();
      return {
        noteId: note.id().toString(),
        senderAccountId: note.metadata().sender().toString(),
        noteType: sdkNoteTypeToWallet(note.metadata().noteType()),
        assets: note
          .assets()
          .fungibleAssets()
          .map(asset => ({
            faucetId: asset.faucetId().toString(),
            amount: asset.amount()
          }))
      };
    });
  const outputNotes = summary
    .outputNotes()
    .notes()
    .map(outputNote => ({
      noteId: outputNote.id().toString(),
      noteType: sdkNoteTypeToWallet(outputNote.metadata().noteType()),
      assets:
        outputNote
          .assets()
          ?.fungibleAssets()
          .map(asset => ({
            faucetId: asset.faucetId().toString(),
            amount: asset.amount()
          })) ?? []
    }));
  return { inputNotes, outputNotes };
}

async function createGuardianClientContext(account: WalletAccount, vault: Vault): Promise<GuardianClientContext> {
  if (!account.coldPublicKey) {
    throw new Error(`Recovered Guardian account ${account.publicKey} is missing its cold public key`);
  }
  const accountDetails = await withWasmClientLock(async () => {
    const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
    if (!sdkAccount) throw new Error(`Recovered Guardian account ${account.publicKey} is unavailable locally`);
    const { commitment } = await getSignerDetailsFromAccount(sdkAccount, true);
    const nonce = sdkAccount.nonce().asInt();
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Guardian account nonce ${nonce} exceeds JavaScript's safe integer range`);
    }
    return { commitment, nonce: Number(nonce) };
  });

  const guardianEndpoint = await resolveGuardianEndpoint(account);
  registerGuardianOrigin(guardianEndpoint);
  const guardian = new GuardianHttpClient(guardianEndpoint);
  guardian.setSigner(
    new WalletSigner(
      withHexPrefix(account.coldPublicKey),
      withHexPrefix(accountDetails.commitment),
      (publicKey, wordHex) => vault.signWord(publicKey, wordHex)
    )
  );
  return {
    guardian,
    accountNonce: accountDetails.nonce,
    guardianAccountId: canonicalWalletAccountId(account.publicKey)
  };
}

async function setTransactionRecoveryStatus(
  vault: Vault,
  accountId: string,
  status: GuardianTransactionRecoveryStatus
): Promise<void> {
  const updated = await vault.setGuardianTransactionRecoveryStatus(accountId, status);
  accountsUpdated(updated);
}

export async function recoverTransactionHistory(
  account: WalletAccount,
  vault: Vault
): Promise<GuardianTransactionRecoveryResult> {
  await setTransactionRecoveryStatus(vault, account.publicKey, 'recovering');
  const result: GuardianTransactionRecoveryResult = {
    recoveredDeltas: 0,
    missingDeltas: 0,
    partialRows: 0
  };

  // DISABLED until a Guardian release exposes canonical deltas to clients
  // (OpenZeppelin/guardian#357). Today's server only lists PENDING proposals
  // on GET /delta/proposal, `getDelta` needs the exact proposer-chosen
  // `Date.now()` nonces (unknowable after seed recovery), and `getDeltaSince`
  // merges the history into one metadata-less blob — so completed history is
  // unreachable. The prototyped fix is a `?status=canonical` filter on the
  // proposal listing (see private-state-manager); once it ships in
  // @openzeppelin/guardian-client, re-enable by uncommenting the walk below
  // (it needs `import * as Repo from 'lib/miden/repo'` and a
  // `DELTA_FLUSH_SIZE = 10` chunk constant back). `decodeSummary` and
  // `mapGuardianDeltaToTransaction` stay live and unit-tested so the walk is
  // the only dormant part.
  //
  // let walkFailed = false;
  // try {
  //   const { guardian, accountNonce, guardianAccountId } = await createGuardianClientContext(account, vault);
  //   const proposals = await guardian.getDeltaProposals(guardianAccountId, 'canonical');
  //   console.log(`[GuardianRecovery] Canonical delta history for ${account.publicKey}: ${proposals.length} entries`);
  //   let rows: ITransaction[] = [];
  //   for (const delta of proposals) {
  //     try {
  //       const summary = await withWasmClientLock(async () => decodeSummary(delta));
  //       const row = mapGuardianDeltaToTransaction(account.publicKey, delta, summary);
  //       rows.push(row);
  //       result.recoveredDeltas++;
  //       if (row.recovery?.detail === 'partial') result.partialRows++;
  //     } catch (error) {
  //       result.missingDeltas++;
  //       console.warn(`[GuardianRecovery] Failed to decode delta ${delta.nonce}:`, error);
  //     }
  //     if (rows.length >= DELTA_FLUSH_SIZE) {
  //       await Repo.transactions.bulkPut(rows);
  //       rows = [];
  //     }
  //   }
  //   if (rows.length > 0) await Repo.transactions.bulkPut(rows);
  //   // The on-chain nonce counts every executed transaction, so deltas the
  //   // Guardian never saw surface as a shortfall against it; account creation
  //   // goes through `configure`, not a delta, hence the -1.
  //   result.missingDeltas += Math.max(0, accountNonce - 1 - result.recoveredDeltas - result.missingDeltas);
  // } catch (error) {
  //   walkFailed = true;
  //   console.warn(`[GuardianRecovery] Transaction history recovery failed for ${account.publicKey}:`, error);
  // }
  // const status = walkFailed || result.missingDeltas > 0 || result.partialRows > 0 ? 'partial' : 'complete';

  // History is knowably absent, so land directly on 'partial': Activity stops
  // spinning and keeps the dismissible incomplete-history warning.
  await setTransactionRecoveryStatus(vault, account.publicKey, 'partial');
  console.log(
    `[GuardianRecovery] Transaction history recovery skipped for ${account.publicKey}: ` +
      'waiting on a Guardian release that exposes canonical delta history (OpenZeppelin/guardian#357)'
  );
  return result;
}

async function fetchProposalNotePayload(
  account: WalletAccount,
  context: GuardianClientContext
): Promise<GuardianPendingNotePayload> {
  try {
    const proposals = await context.guardian.getDeltaProposals(context.guardianAccountId);
    const proposalNoteBytes: Uint8Array[] = [];
    for (const proposal of proposals) {
      const metadata = proposal.deltaPayload.metadata;
      if (metadata?.proposalType !== 'consume_notes' || metadata.consumeNotesMetadataVersion !== 2) continue;
      for (const encodedNote of metadata.consumeNotesNotes ?? []) proposalNoteBytes.push(b64ToU8(encodedNote));
    }
    console.log(
      `[GuardianRecovery] Pending proposals for ${account.publicKey}: ${proposals.length} proposals, ` +
        `${proposalNoteBytes.length} embedded consume notes`
    );
    return { proposalNoteBytes, proposalFetchFailed: false };
  } catch (error) {
    console.warn(`[GuardianRecovery] Pending proposal lookup failed for ${account.publicKey}:`, error);
    return { proposalNoteBytes: [], proposalFetchFailed: true };
  }
}

/**
 * Account creation time (unix seconds) from the Guardian's `getState`
 * metadata. 0 on any failure — the scan-range resolver treats 0 as
 * "unknown" and falls back to scanning from genesis.
 */
async function fetchAccountCreatedAtSeconds(account: WalletAccount, context: GuardianClientContext): Promise<number> {
  try {
    const state = await context.guardian.getState(context.guardianAccountId);
    const parsed = Date.parse(state.createdAt);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  } catch (error) {
    console.warn(`[GuardianRecovery] Account createdAt lookup failed for ${account.publicKey}:`, error);
    return 0;
  }
}

/**
 * Blocks per public-backfill chunk. Bounds how long any single offscreen call
 * holds the WASM mutex (queued reads deadline-kill the realm behind a
 * long-held mutex) and sets the granularity of the progress card.
 */
const PUBLIC_BACKFILL_CHUNK_BLOCKS = 200_000;

export async function recoverPendingNotes(
  account: WalletAccount,
  vault: Vault
): Promise<GuardianPendingNoteRecoveryResult> {
  console.log(`[GuardianRecovery] Recovering pending notes for ${account.publicKey}...`);
  const result: GuardianPendingNoteRecoveryResult = { proposalNotes: 0, publicNotes: 0, sourceFailures: 0 };

  try {
    // Source 1: drain the private-note transport backlog.
    await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'transport' });
    try {
      await midenClientProxy.drainPrivateNoteTransport();
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Private-note transport drain failed for ${account.publicKey}:`, error);
    }

    // Source 2: notes embedded in pending consume proposals.
    await reportGuardianNoteRecoveryProgress({ accountId: account.publicKey, step: 'proposals' });
    let context: GuardianClientContext | undefined;
    try {
      context = await createGuardianClientContext(account, vault);
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Guardian client setup failed for ${account.publicKey}:`, error);
    }
    let createdAtSeconds = 0;
    if (context) {
      const payload = await fetchProposalNotePayload(account, context);
      if (payload.proposalFetchFailed) result.sourceFailures++;
      if (payload.proposalNoteBytes.length > 0) {
        try {
          const imported = await midenClientProxy.importRecoveryNoteBytes(payload.proposalNoteBytes);
          result.proposalNotes = imported.imported;
          result.sourceFailures += imported.failures;
        } catch (error) {
          result.sourceFailures++;
          console.warn(`[GuardianRecovery] Proposal note import failed for ${account.publicKey}:`, error);
        }
      }
      createdAtSeconds = await fetchAccountCreatedAtSeconds(account, context);
    }

    // Source 3: public notes by account tag, scanned from the account's
    // creation block (not genesis) in bounded chunks with live progress.
    try {
      const { startBlock, latestBlock } = await midenClientProxy.resolveRecoveryScanRange(createdAtSeconds);
      console.log(`[GuardianRecovery] Public backfill for ${account.publicKey}: blocks ${startBlock}-${latestBlock}`);
      await reportGuardianNoteRecoveryProgress({
        accountId: account.publicKey,
        step: 'public',
        startBlock,
        syncedToBlock: startBlock,
        latestBlock
      });
      for (let blockFrom = startBlock; blockFrom <= latestBlock; blockFrom += PUBLIC_BACKFILL_CHUNK_BLOCKS) {
        const blockTo = Math.min(latestBlock, blockFrom + PUBLIC_BACKFILL_CHUNK_BLOCKS - 1);
        try {
          result.publicNotes += await midenClientProxy.recoverPublicNotesRange(account.publicKey, blockFrom, blockTo);
        } catch (error) {
          result.sourceFailures++;
          console.warn(
            `[GuardianRecovery] Public backfill chunk ${blockFrom}-${blockTo} failed for ${account.publicKey}:`,
            error
          );
        }
        await reportGuardianNoteRecoveryProgress({
          accountId: account.publicKey,
          step: 'public',
          startBlock,
          syncedToBlock: blockTo,
          latestBlock
        });
      }
    } catch (error) {
      result.sourceFailures++;
      console.warn(`[GuardianRecovery] Public account-tag recovery failed for ${account.publicKey}:`, error);
    }

    await doSync(true);
    console.log(
      `[GuardianRecovery] Pending notes for ${account.publicKey}: ` +
        `proposal notes imported=${result.proposalNotes}, ` +
        `public notes imported=${result.publicNotes}, ` +
        `source failures=${result.sourceFailures}`
    );
    return result;
  } finally {
    await clearGuardianNoteRecoveryProgress();
  }
}

/** Accounts whose recovery sequence (history + pending notes) is currently running in this process. */
const inFlightRecoveries = new Set<string>();

/**
 * Start the detached Guardian recovery sequence for a seed-recovered account,
 * but only once it cannot collide with a live transaction: the mandatory
 * hot-key rotation must have landed and no transaction may be queued or
 * generating. Both recoveries hold the (offscreen) WASM client for long
 * stretches; a concurrent transaction's short-deadline reads queue behind
 * them and get deadline-killed — the "hot-key rotation always fails on the
 * first try" bug. The trigger lives in the frontend (GuardianRecoveryProvider),
 * which retries until this returns true.
 *
 * Returns true when the sequence was started (it then runs detached), false
 * when the account is ineligible or busy right now.
 */
export async function maybeStartGuardianRecovery(account: WalletAccount, vault: Vault): Promise<boolean> {
  if (account.guardianTransactionRecoveryStatus !== 'pending') return false;
  if (account.requiresHotKeyRotation) return false;
  if (inFlightRecoveries.has(account.publicKey)) return false;
  const uncompleted = await getUncompletedTransactions(account.publicKey);
  if (uncompleted.length > 0) return false;

  inFlightRecoveries.add(account.publicKey);
  runDetachedRecovery(account, vault).finally(() => inFlightRecoveries.delete(account.publicKey));
  return true;
}

/**
 * The detached sequence itself: history first (Guardian HTTP + short decode
 * locks), then the note recovery (long-held WASM client + final sync) —
 * sequential so the two never contend for the client against each other.
 * Never throws.
 */
async function runDetachedRecovery(account: WalletAccount, vault: Vault): Promise<void> {
  console.log(`[GuardianRecovery] Starting detached recovery sequence for ${account.publicKey}`);
  try {
    await recoverTransactionHistory(account, vault);
  } catch (error) {
    console.warn(`[GuardianRecovery] Detached transaction recovery failed for ${account.publicKey}:`, error);
    try {
      const updated = await vault.setGuardianTransactionRecoveryStatus(account.publicKey, 'partial');
      accountsUpdated(updated);
    } catch (statusError) {
      console.warn(`[GuardianRecovery] Failed to persist partial state for ${account.publicKey}:`, statusError);
    }
  }
  try {
    await recoverPendingNotes(account, vault);
  } catch (error) {
    console.warn(`[GuardianRecovery] Detached pending-note recovery failed for ${account.publicKey}:`, error);
  }
}
