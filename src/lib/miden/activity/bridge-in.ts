import * as Repo from 'lib/miden/repo';

import { IBridgeInInfo, ITransactionStatus } from '../db/types';
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
  return true;
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
    if (!matched && noteId && noteIds.includes(noteId)) {
      matched = intent;
      registryChanged = true;
      continue; // matched intents leave the registry
    }
    next.push(intent);
  }

  if (registryChanged) await writeRegistry(next);
  return matched?.info;
}

/**
 * Return the subset of `ids` that exist as transaction rows. Used by the
 * history list to decide whether a `consume` row that is the tail of another
 * row's lifecycle should be suppressed (its primary row still exists) or shown
 * as a plain receive (dangling reference — funds are never invisible).
 */
export async function existingTransactionIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Set();
  const rows = await Repo.transactions.where('id').anyOf(unique).primaryKeys();
  return new Set(rows);
}
