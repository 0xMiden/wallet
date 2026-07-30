import { AGGLAYER_BRIDGE_NOTE_SENDER_ACCOUNT_ID } from 'lib/agglayer/constant';
import * as Repo from 'lib/miden/repo';

import { compareAccountIds } from './utils';
import { IBridgeInInfo, IBridgedReceiveExtraInputs, IEarnWithdrawExtraInputs, ITransactionStatus } from '../db/types';
import { fetchFromStorage, putToStorage } from '../front/storage';

/**
 * Bridged-in (EVM → Miden) intent registry.
 *
 * Epoch deposits auto-consume the Miden-side P2ID note, so the wallet's only
 * trace of the deposit is a plain `consume` row created by auto-consume. The
 * intent polling reports the note id (`midenNoteId`), but the deposit screen's
 * polling loop dies with the screen — the user can close it right after
 * signing and the note id is never learned on that path. So the intent
 * metadata (user address + nonce + display info) is persisted at EXECUTE time,
 * and resolution is order-independent:
 *
 *  - `registerPendingBridgeIn` (execute side): parks the intent in platform
 *    storage as soon as `solveIntent` succeeds.
 *  - `resolveBridgeInNoteId` (screen-poll side, opportunistic): when the
 *    deposit screen's polling does learn the note id, it is recorded on the
 *    pending intent and any already-completed consume row is tagged.
 *  - `takeBridgeInInfoForNotes` (consume side): when a consume completes, any
 *    still-unresolved pending intent gets ONE `getIntentStatus` poll to learn
 *    its note id; a match hands the bridge-in info to the completing row.
 */

const REGISTRY_KEY = 'epoch_bridge_in_intents';

/** Drop unmatched intents after 7 days — the deposit failed, was recalled, or claimed elsewhere. */
const REGISTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingBridgeInIntent {
  /** SIO user address (EVM sponsor) — the `getIntentStatus` lookup key. */
  userAddress: string;
  intentNonce: string;
  info: IBridgeInInfo;
  /** Miden-side note id, once any poll has learned it. */
  midenNoteId?: string;
  registeredAt: number;
}

async function readRegistry(): Promise<PendingBridgeInIntent[]> {
  const stored = await fetchFromStorage<PendingBridgeInIntent[]>(REGISTRY_KEY);
  if (!stored) return [];
  const cutoff = Date.now() - REGISTRY_MAX_AGE_MS;
  return stored.filter(r => r.registeredAt >= cutoff);
}

async function writeRegistry(records: PendingBridgeInIntent[]): Promise<void> {
  await putToStorage(REGISTRY_KEY, records);
}

function isEvmAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Normalize a note id for cross-source comparison. The Epoch allocator and the
 * Miden SDK both emit hex note ids, but may differ in `0x` prefix and casing —
 * matching on the raw strings silently misses. Strip prefix + lowercase.
 */
function noteIdKey(id: string): string {
  return id.trim().toLowerCase().replace(/^0x/, '');
}

/** Read the untyped `midenNoteId` field the allocator includes on EVM→Miden status entries. */
function extractMidenNoteId(results: unknown[]): string | undefined {
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const value: unknown = Reflect.get(result, 'midenNoteId');
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * ONE-shot `getIntentStatus` poll to learn the intent's Miden note id. The
 * Epoch SDK is imported lazily — it (and viem) must not load on the consume
 * path unless a pending bridge-in actually exists.
 */
async function pollIntentNoteId(intent: PendingBridgeInIntent): Promise<string | undefined> {
  if (!isEvmAddress(intent.userAddress)) return undefined;
  try {
    const { getEpochReadOnlySdk } = await import('lib/epoch/sdk');
    const sdk = await getEpochReadOnlySdk(intent.userAddress);
    const results = await sdk.getIntentStatus(intent.userAddress, intent.intentNonce);
    return extractMidenNoteId(results ?? []);
  } catch (err) {
    console.warn('[bridge-in] one-shot intent poll failed', err);
    return undefined;
  }
}

/** Patch the COMPLETED consume row that claimed `noteId`. Returns false if no such row exists yet. */
async function tagConsumeRow(noteId: string, info: IBridgeInInfo): Promise<boolean> {
  const row = await Repo.transactions
    .where('noteIds')
    .equals(noteId)
    .filter(tx => tx.type === 'consume' && tx.status === ITransactionStatus.Completed)
    .first();
  if (!row) return false;
  await Repo.transactions.where({ id: row.id }).modify(tx => {
    tx.extraInputs = { ...(tx.extraInputs ?? {}), bridgeIn: info };
    tx.displayMessage = 'Bridged from EVM';
  });
  if (info.bridgeReceiveTxId && row.amount !== undefined && row.faucetId) {
    try {
      const { updateBridgedReceivePhase } = await import('../transaction/complete');
      await updateBridgedReceivePhase(
        info.bridgeReceiveTxId,
        'received',
        { midenNoteId: noteId, outputSymbol: info.sourceSymbol },
        { amount: row.amount, faucetId: row.faucetId, transactionId: row.transactionId }
      );
    } catch (err) {
      console.warn('[bridge-in] bridge receive patch (resolve path) failed', err);
    }
  }
  // Race cover: if the consume already completed before this intent was resolved,
  // `completeConsumeTransaction` never saw the bridge-in, so flip the linked
  // Smart Withdraw row to `received` here instead. Lazy import avoids a cycle.
  if (info.earnWithdrawTxId) {
    try {
      const { updateEarnWithdrawPhase } = await import('../transaction/complete');
      await updateEarnWithdrawPhase(
        info.earnWithdrawTxId,
        'received',
        { midenNoteId: noteId, outputSymbol: info.sourceSymbol },
        row.amount
      );
    } catch (err) {
      console.warn('[bridge-in] earn-withdraw received patch (resolve path) failed', err);
    }
  }
  return true;
}

/**
 * E2E-only override for the AggLayer delivery sender. Production leaves this
 * null (the hook that sets it is installed only under MIDEN_E2E_TEST), so the
 * hardcoded testnet sender is used. The bridge-in localnet harness sets it to a
 * runtime-created "solver" account whose id isn't known until test time.
 */
let e2eAgglayerSenderOverride: string | null = null;
export function setAgglayerSenderForE2E(senderAccountId: string): void {
  e2eAgglayerSenderOverride = senderAccountId;
}

/**
 * Match an AggLayer-delivered note to the oldest compatible tracking row.
 * The fixed sender is authoritative; amount + recipient prevent two deposits
 * to the same wallet from being paired in the wrong order.
 */
export async function takeAgglayerBridgeInInfo(args: {
  accountId: string;
  senderAccountId: string;
  amount: bigint;
}): Promise<IBridgeInInfo | undefined> {
  const configuredSender = (e2eAgglayerSenderOverride ?? AGGLAYER_BRIDGE_NOTE_SENDER_ACCOUNT_ID).trim();
  if (!configuredSender || !compareAccountIds(configuredSender, args.senderAccountId)) return undefined;

  const matches = await Repo.transactions
    .filter(tx => {
      if (tx.type !== 'bridged-receive' || !compareAccountIds(tx.accountId, args.accountId)) return false;
      const inputs = tx.extraInputs as IBridgedReceiveExtraInputs | undefined;
      return (
        inputs?.provider === 'agglayer' &&
        inputs.phase !== 'received' &&
        inputs.phase !== 'failed' &&
        tx.amount === args.amount
      );
    })
    .toArray();
  matches.sort((a, b) => a.initiatedAt - b.initiatedAt);
  const match = matches[0];
  if (!match) return undefined;
  const inputs = match.extraInputs as IBridgedReceiveExtraInputs;
  return {
    provider: 'agglayer',
    sourceAmount: inputs.sourceAmount,
    sourceSymbol: inputs.sourceSymbol,
    evmTxHash: inputs.evmTxHash,
    bridgeReceiveTxId: match.id
  };
}

/**
 * Park an EVM→Miden intent as soon as it is submitted, so the bridged note can
 * be recognized even if the deposit screen (and its polling) is closed before
 * the note id is ever reported. Idempotent per intent nonce.
 */
export async function registerPendingBridgeIn(
  userAddress: string,
  intentNonce: string,
  info: IBridgeInInfo
): Promise<void> {
  const registry = await readRegistry();
  if (registry.some(r => r.intentNonce === intentNonce)) return;
  await writeRegistry([...registry, { userAddress, intentNonce, info, registeredAt: Date.now() }]);
}

/**
 * Opportunistic resolution from the deposit screen's polling loop: record the
 * note id on the pending intent and, if auto-consume already claimed the note,
 * tag that consume row right away (and drop the intent).
 */
export async function resolveBridgeInNoteId(intentNonce: string, midenNoteId: string): Promise<void> {
  const registry = await readRegistry();
  const intent = registry.find(r => r.intentNonce === intentNonce);
  if (!intent) return;

  if (await tagConsumeRow(midenNoteId, intent.info)) {
    await writeRegistry(registry.filter(r => r.intentNonce !== intentNonce));
    return;
  }

  if (intent.midenNoteId !== midenNoteId) {
    await writeRegistry(registry.map(r => (r.intentNonce === intentNonce ? { ...r, midenNoteId } : r)));
  }
}

/**
 * Pop the bridge-in info matching any of the consumed note ids. Pending
 * intents that haven't learned their note id yet get one poll each — this is
 * what covers "user closed the deposit screen before polling reported the
 * note id". Called by `completeConsumeTransaction`; zero-cost (one storage
 * read) when no bridge-in is pending.
 */
export async function takeBridgeInInfoForNotes(noteIds: string[]): Promise<IBridgeInInfo | undefined> {
  if (noteIds.length === 0) return undefined;
  const registry = await readRegistry();
  if (registry.length === 0) return undefined;
  const consumedKeys = new Set(noteIds.map(noteIdKey));

  let matched: PendingBridgeInIntent | undefined;
  let registryChanged = false;
  const next: PendingBridgeInIntent[] = [];

  for (const intent of registry) {
    let noteId = intent.midenNoteId;
    if (!matched && !noteId) {
      noteId = await pollIntentNoteId(intent);
      if (noteId) {
        intent.midenNoteId = noteId;
        registryChanged = true;
      }
    }
    if (!matched && noteId && consumedKeys.has(noteIdKey(noteId))) {
      matched = intent;
      registryChanged = true;
      continue; // matched intents leave the registry
    }
    next.push(intent);
  }

  if (registryChanged) await writeRegistry(next);
  // Copy the resolved note id onto the returned info so the consume side can
  // patch the linked `bridged-receive` row's `midenNoteId` without another lookup.
  if (!matched) return undefined;
  return matched.midenNoteId ? { ...matched.info, midenNoteId: matched.midenNoteId } : matched.info;
}

/**
 * Find a still-pending bridge-in intent by the `earn-withdraw` row it belongs to.
 * The registry entry (written at submit time, keyed to the row via
 * `info.earnWithdrawTxId`) is authoritative proof the redeem intent WAS submitted.
 * `resumeEarnWithdrawal` uses this to recover the intent nonce when the row itself
 * lost its `withdrawIntentNonce` (a teardown between the two post-submit writes),
 * so a live withdrawal is never falsely marked `failed`. Returns undefined if no
 * pending intent references this row (never submitted, or already resolved/expired).
 */
export async function findPendingBridgeInByEarnWithdrawTxId(
  txId: string
): Promise<{ intentNonce: string; userAddress: string } | undefined> {
  const registry = await readRegistry();
  // A resubmit reuses the same earnWithdrawTxId and APPENDS a fresh entry (a failed
  // intent's entry is only dropped by the 7-day TTL, never by txId), so the registry
  // can hold several entries for one row. Pick the NEWEST by registeredAt — the live
  // intent — not the first, which may be a dead nonce whose failed status would
  // re-strand the row and defeat this recovery's purpose.
  const intent = registry
    .filter(r => r.info.earnWithdrawTxId === txId)
    .reduce<
      PendingBridgeInIntent | undefined
    >((newest, r) => (!newest || r.registeredAt > newest.registeredAt ? r : newest), undefined);
  return intent ? { intentNonce: intent.intentNonce, userAddress: intent.userAddress } : undefined;
}

/**
 * Of the given linked-primary ids, the ones whose row is currently the SINGLE TRACE
 * of the money movement, and so should suppress its delivery `consume` in the history
 * list. Ids with no row (dangling reference) fall through to a plain receive — funds
 * are never invisible.
 *
 * The one exception to "exists ⇒ suppresses": a terminal-`failed` earn-withdraw row.
 * The bridged note can still be delivered and auto-consumed AFTER the row was failed
 * (a bridge that stalls past the reconcile TTL, or a resubmit), and the monotonic phase
 * machine then refuses to flip the failed row to `received`. Such a row is no longer a
 * valid trace of the (arrived) funds, so it must NOT suppress its consume — otherwise
 * the delivered funds would be invisible in history behind a Failed row. It is excluded
 * here so the consume falls through to a visible receive. Every other primary suppresses
 * on existence, as before.
 */
export async function suppressingLinkedTxIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Set();
  const rows = await Repo.transactions.where('id').anyOf(unique).toArray();
  const suppressing = new Set<string>();
  for (const row of rows) {
    const isFailedEarnWithdraw =
      row.type === 'earn-withdraw' && (row.extraInputs as IEarnWithdrawExtraInputs | undefined)?.phase === 'failed';
    if (!isFailedEarnWithdraw) suppressing.add(row.id);
  }
  return suppressing;
}
