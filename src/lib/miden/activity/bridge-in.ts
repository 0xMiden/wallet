import { AGGLAYER_BRIDGE_NOTE_SENDER_ACCOUNT_ID } from 'lib/agglayer/constant';
import { effectiveWithdrawAttemptId, intentKey, matchesEarnWithdrawIntent } from 'lib/epoch/intent-key';
import * as Repo from 'lib/miden/repo';

import { compareAccountIds } from './utils';
import {
  IBridgeInInfo,
  IBridgedReceiveExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus
} from '../db/types';
import { fetchFromStorage, putToStorage } from '../front/storage';

/** Pending Epoch deliveries survive closed screens and incomplete consume tagging. */
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

// The entire array shares one lock. Callbacks may write local rows, never await network or re-enter this registry.
let mutationTail: Promise<unknown> = Promise.resolve();
function withBridgeInRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request<Promise<T>>('epoch-bridge-in-registry', operation);
  }
  const run = mutationTail.then(operation, operation);
  mutationTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const registryIdentity = (intent: PendingBridgeInIntent): string => intentKey(intent.userAddress, intent.intentNonce);

function bridgeInfo(intent: PendingBridgeInIntent): IBridgeInInfo {
  const txId = intent.info.earnWithdrawTxId;
  return {
    ...intent.info,
    intentOwner: intent.userAddress,
    intentNonce: intent.intentNonce,
    earnWithdrawAttemptId: txId ? effectiveWithdrawAttemptId(txId, intent.info.earnWithdrawAttemptId) : undefined,
    midenNoteId: intent.midenNoteId
  };
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

/** Persist a bridge receipt and its linked lifecycle updates before releasing its recovery record. */
export async function applyBridgeInToConsumeRow(consumeId: string, info: IBridgeInInfo): Promise<void> {
  let applied = false;
  let delivered: Pick<ITransaction, 'amount' | 'faucetId' | 'transactionId'> = {};
  await Repo.transactions.where({ id: consumeId }).modify(tx => {
    if (tx.type !== 'consume' || tx.status !== ITransactionStatus.Completed || tx.restoredFromBackup) return;
    tx.extraInputs = { ...(tx.extraInputs ?? {}), bridgeIn: info };
    tx.displayMessage = 'Bridged from EVM';
    delivered = { amount: tx.amount, faucetId: tx.faucetId, transactionId: tx.transactionId };
    applied = true;
  });
  if (!applied) throw new Error('Bridge receipt requires a completed local consume');
  if (!info.earnWithdrawTxId && !info.bridgeReceiveTxId) return;
  const { updateEarnWithdrawPhase, updateBridgedReceivePhase } = await import('../transaction/complete');
  if (info.earnWithdrawTxId) {
    if (!info.intentOwner) throw new Error('Bridge withdrawal has no intent owner');
    await updateEarnWithdrawPhase(
      info.earnWithdrawTxId,
      'received',
      { midenNoteId: info.midenNoteId, outputSymbol: info.sourceSymbol },
      delivered.amount,
      {
        owner: info.intentOwner,
        nonce: info.intentNonce,
        attemptId: effectiveWithdrawAttemptId(info.earnWithdrawTxId, info.earnWithdrawAttemptId)
      }
    );
  }
  if (info.bridgeReceiveTxId) {
    if (delivered.amount === undefined || !delivered.faucetId)
      throw new Error('Bridge consume is missing delivered asset data');
    // No `outputSymbol` here: the output of a bridge-in is the Miden asset that
    // landed, not the EVM input token. The row keeps the symbol it was created
    // with, and the delivered faucet id resolves the rest.
    await updateBridgedReceivePhase(
      info.bridgeReceiveTxId,
      'received',
      { midenNoteId: info.midenNoteId },
      { amount: delivered.amount, faucetId: delivered.faucetId, transactionId: delivered.transactionId }
    );
  }
}

async function tagConsumeRow(noteId: string, info: IBridgeInInfo): Promise<boolean> {
  const key = noteIdKey(noteId);
  const row = await Repo.transactions
    .where('noteIds')
    .anyOfIgnoreCase(key, `0x${key}`)
    .filter(tx => tx.type === 'consume' && tx.status === ITransactionStatus.Completed && !tx.restoredFromBackup)
    .first();
  if (!row) return false;
  await applyBridgeInToConsumeRow(row.id, info);
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
      // A restored tracker must not adopt a genuine incoming note: the match
      // rewrites that row to `received` and makes the real consume hide beneath
      // it in history, so an honest receive would be filed under, and titled by,
      // whatever the backup's author wrote.
      if (tx.restoredFromBackup) return false;
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

/** Persist each submitted owner/nonce once, before its delivery is known. */
export async function registerPendingBridgeIn(
  userAddress: string,
  intentNonce: string,
  info: IBridgeInInfo
): Promise<void> {
  await withBridgeInRegistryLock(async () => {
    const registry = await readRegistry();
    const key = intentKey(userAddress, intentNonce);
    if (registry.some(record => registryIdentity(record) === key)) return;
    await writeRegistry([...registry, { userAddress, intentNonce, info, registeredAt: Date.now() }]);
  });
}

export async function resolveBridgeInNoteId(
  userAddress: string,
  intentNonce: string,
  midenNoteId: string
): Promise<void> {
  await withBridgeInRegistryLock(async () => {
    const registry = await readRegistry();
    const key = intentKey(userAddress, intentNonce);
    const intent = registry.find(record => registryIdentity(record) === key);
    if (!intent) return;
    if (!intent.midenNoteId) {
      intent.midenNoteId = midenNoteId;
      await writeRegistry(registry);
    }
    if (await tagConsumeRow(intent.midenNoteId, bridgeInfo(intent))) {
      await writeRegistry(registry.filter(record => registryIdentity(record) !== key));
    }
  });
}

/** Discover outside the registry lock; remove only after the required local persistence callback succeeds. */
export async function applyBridgeInInfoForNotes(
  noteIds: string[],
  apply: (info: IBridgeInInfo) => Promise<void>
): Promise<boolean> {
  if (noteIds.length === 0) return false;
  const snapshot = await readRegistry();
  if (snapshot.length === 0) return false;
  const consumedKeys = new Set(noteIds.map(noteIdKey));
  const discovered = new Map<string, string>();
  if (!snapshot.some(intent => intent.midenNoteId && consumedKeys.has(noteIdKey(intent.midenNoteId)))) {
    for (const intent of snapshot) {
      if (intent.midenNoteId) continue;
      const noteId = await pollIntentNoteId(intent);
      if (noteId) {
        discovered.set(registryIdentity(intent), noteId);
        if (consumedKeys.has(noteIdKey(noteId))) break;
      }
    }
  }
  return withBridgeInRegistryLock(async () => {
    const registry = await readRegistry();
    let changed = false;
    for (const intent of registry) {
      const noteId = discovered.get(registryIdentity(intent));
      if (!intent.midenNoteId && noteId) {
        intent.midenNoteId = noteId;
        changed = true;
      }
    }
    if (changed) await writeRegistry(registry);
    const matched = registry.find(intent => intent.midenNoteId && consumedKeys.has(noteIdKey(intent.midenNoteId)));
    if (!matched) return false;
    await apply(bridgeInfo(matched));
    await writeRegistry(registry.filter(intent => registryIdentity(intent) !== registryIdentity(matched)));
    return true;
  });
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
  txId: string,
  attemptId: string
): Promise<{ intentNonce: string; userAddress: string } | undefined> {
  const registry = await readRegistry();
  // A resubmit reuses the same earnWithdrawTxId and APPENDS a fresh entry (a failed
  // intent's entry is only dropped by the 7-day TTL, never by txId), so the registry
  // can hold several entries for one row. Pick the NEWEST by registeredAt — the live
  // intent — not the first, which may be a dead nonce whose failed status would
  // re-strand the row and defeat this recovery's purpose.
  const intent = registry
    .filter(
      r =>
        r.info.earnWithdrawTxId === txId && effectiveWithdrawAttemptId(txId, r.info.earnWithdrawAttemptId) === attemptId
    )
    .reduce<
      PendingBridgeInIntent | undefined
    >((newest, r) => (!newest || r.registeredAt > newest.registeredAt ? r : newest), undefined);
  return intent ? { intentNonce: intent.intentNonce, userAddress: intent.userAddress } : undefined;
}

/** Return consumes represented by a current linked primary, retaining prior-attempt receipts in history. */
export async function suppressedLinkedConsumeIds(transactions: ITransaction[]): Promise<Set<string>> {
  const linked = transactions.flatMap(tx => {
    if (tx.type !== 'consume') return [];
    const id: string | undefined =
      tx.extraInputs?.swapOrderTxId ??
      tx.extraInputs?.bridgeIn?.earnWithdrawTxId ??
      tx.extraInputs?.bridgeIn?.bridgeReceiveTxId;
    return id ? [{ tx, id }] : [];
  });
  if (linked.length === 0) return new Set();
  const rows = await Repo.transactions
    .where('id')
    .anyOf([...new Set(linked.map(({ id }) => id))])
    .toArray();
  const primaries = new Map(rows.map(row => [row.id, row]));
  const suppressed = new Set<string>();
  for (const { tx, id } of linked) {
    const row = primaries.get(id);
    if (!row) continue;
    if (row.type === 'earn-withdraw') {
      const inputs: IEarnWithdrawExtraInputs | undefined = row.extraInputs;
      const info: IBridgeInInfo | undefined = tx.extraInputs?.bridgeIn;
      const owner = info?.intentOwner ?? inputs?.evmOwner;
      if (
        inputs?.phase === 'failed' ||
        !owner ||
        !matchesEarnWithdrawIntent(row, {
          owner,
          nonce: info?.intentNonce,
          attemptId: effectiveWithdrawAttemptId(id, info?.earnWithdrawAttemptId)
        })
      )
        continue;
    }
    suppressed.add(tx.id);
  }
  return suppressed;
}
