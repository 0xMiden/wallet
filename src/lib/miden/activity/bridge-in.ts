import { AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL } from 'lib/agglayer/constant';
import { effectiveWithdrawAttemptId, intentKey, matchesEarnWithdrawIntent } from 'lib/epoch/intent-key';
import { readEpochIntentStatus } from 'lib/epoch/intent-status';
import * as Repo from 'lib/miden/repo';
import { accountRefToSdk, sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot, initBridgeConfig } from 'lib/remote-config/runtime';
import { selectNativeEthFaucets, selectNativeEthToken } from 'lib/remote-config/values';
import { DEFAULT_CHAIN_ID } from 'lib/walletconnect/config';

import { withinDeliveryWindow } from './bridge-receive-window';
import { compareAccountIds } from './utils';
import {
  IBridgeInInfo,
  IBridgedReceiveExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus
} from '../db/types';
import { fetchFromStorage, inStorageTurn, putToStorage } from '../front/storage';

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
function withBridgeInRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  return inStorageTurn('epoch-bridge-in-registry', operation);
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
export function noteIdKey(id: string): string {
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
    const sdk = await getEpochReadOnlySdk(intent.userAddress, intent.info.epochAllocatorUrl);
    // Bounded: consume completion awaits this under the transaction loop's lock.
    const results = await readEpochIntentStatus(sdk, intent.userAddress, intent.intentNonce);
    return extractMidenNoteId(results ?? []);
  } catch (err) {
    console.warn('[bridge-in] one-shot intent poll failed', intent.userAddress, intent.intentNonce, err);
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
  await settleLinkedRows(info, delivered);
}

/**
 * Settle a registry delivery that a batch claimed at its own note's asset and the batch's transaction id. `note` is
 * undefined for a batch that kept no per-note facts.
 */
export async function applyBridgeInToBatchNote(
  consumeId: string,
  info: IBridgeInInfo,
  note: AdoptableNote | undefined
): Promise<void> {
  const consume = await Repo.transactions.where({ id: consumeId }).first();
  if (consume?.type !== 'consume' || consume.status !== ITransactionStatus.Completed || consume.restoredFromBackup)
    throw new Error('Bridge receipt requires a completed local consume');
  // Never the batch row's receipt: tagged, it would hide itself and every other note it claimed from Activity.
  await settleLinkedRows(info, {
    amount: note?.amount,
    faucetId: note?.faucetId,
    transactionId: consume.transactionId
  });
}

async function settleLinkedRows(
  info: IBridgeInInfo,
  delivered: Pick<ITransaction, 'amount' | 'faucetId' | 'transactionId'>
): Promise<void> {
  if (!info.earnWithdrawTxId && !info.bridgeReceiveTxId) return;
  const { updateEarnWithdrawPhase, updateBridgedReceivePhase } = await import('../transaction/complete');
  if (info.earnWithdrawTxId) {
    if (!info.intentOwner) throw new Error('Bridge withdrawal has no intent owner');
    // Epoch named this note as the delivery, so with no delivered amount the withdrawal lands at the one it asked for.
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
  const notes = adoptableNotesOf(row);
  if (claimedSeveral(row.noteIds, notes)) {
    await applyBridgeInToBatchNote(
      row.id,
      info,
      notes?.find(note => noteIdKey(note.id) === key)
    );
  } else {
    await applyBridgeInToConsumeRow(row.id, info);
  }
  return true;
}

/**
 * E2E-only override for the AggLayer delivery sender. Production leaves this
 * null (the hook that sets it is installed only under MIDEN_E2E_TEST), so the
 * bridge registry's native-ETH faucet is the sender. The bridge-in localnet
 * harness sets it to a runtime-created "solver" account whose id isn't known
 * until test time.
 */
let e2eAgglayerSenderOverride: string | null = null;
export function setAgglayerSenderForE2E(senderAccountId: string): void {
  e2eAgglayerSenderOverride = senderAccountId;
}

/**
 * How long a deposit waits for its delivery: the reconciler times out an unsettled tracker past it, and no
 * delivery adopts an older one.
 */
export const BRIDGE_RECEIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The error the reconciler fails a tracker with once it outlived `BRIDGE_RECEIVE_MAX_AGE_MS`. */
export const BRIDGE_DELIVERY_TIMED_OUT = 'Bridge delivery timed out.';

/** What the bridge delivers for a deposit tracked in wei: floored at the native-ETH faucet's registry scale (#1326). */
export function agglayerDeliveredAmount(trackedWei: bigint, scale: number): bigint {
  return trackedWei / 10n ** BigInt(scale);
}

// The consume reads its sender in bech32 and the registry names the faucet in hex: both go through the SDK, as
// sameWalletAccountId compares, so the match never rests on the registry's text matching the SDK's.
function sentByFaucet(sender: string, faucet: string): boolean {
  try {
    return accountRefToSdk(sender).toString().toLowerCase() === accountRefToSdk(faucet).toString().toLowerCase();
  } catch (error) {
    console.warn('[bridge-in] could not compare the delivery sender', sender, error);
    return false;
  }
}

/**
 * Whether `sender` sent an AggLayer delivery, by the config this realm holds: the registered faucet whose origin is
 * native ETH on network 0 mints bridged ETH and sends its delivery notes, on any listed AggLayer chain. Matching stays
 * off while the config names no such faucet, so an ordinary incoming note is never mistaken for a bridge delivery.
 */
export function isAgglayerBridgeDelivery(sender: string): boolean {
  if (e2eAgglayerSenderOverride) return compareAccountIds(e2eAgglayerSenderOverride.trim(), sender);
  return selectNativeEthFaucets(getBridgeConfigSnapshot()).some(faucet => sentByFaucet(sender, faucet));
}

// The native-ETH faucet an open AggLayer tracker saved with its route. A restored tracker names nothing: its backup's
// author wrote the route.
function savedDeliveryFaucet(tx: ITransaction): string | undefined {
  const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
  if (tx.restoredFromBackup || inputs?.provider !== 'agglayer') return undefined;
  if (inputs.phase === 'received' || inputs.phase === 'failed') return undefined;
  return inputs.agglayerRoute?.nativeEthFaucetId;
}

/**
 * Whether a sender sent an AggLayer delivery, as `isAgglayerBridgeDelivery` decides it plus the native-ETH faucet each
 * open tracker saved with its route: a deposit made on a chain the document has since dropped still delivers from it.
 * Never rejects: a failed read of the trackers leaves the live faucets alone.
 */
export async function agglayerDeliverySenders(): Promise<(sender: string) => boolean> {
  const override = e2eAgglayerSenderOverride;
  if (override) return sender => compareAccountIds(override.trim(), sender);
  // A claim can start before this realm hydrated the config; from storage, never the network.
  await initBridgeConfig().catch((error: unknown) => console.warn('[bridge-in] bridge config unavailable', error));
  let saved: string[] = [];
  try {
    const trackers = await Repo.transactions
      .where('type')
      .equals('bridged-receive')
      .filter(tx => savedDeliveryFaucet(tx) !== undefined)
      .toArray();
    saved = trackers.flatMap(tx => savedDeliveryFaucet(tx) ?? []);
  } catch (error) {
    console.warn('[bridge-in] could not read the saved delivery faucets', error);
  }
  const faucets = [...new Set([...selectNativeEthFaucets(getBridgeConfigSnapshot()), ...saved])];
  return sender => faucets.some(faucet => sentByFaucet(sender, faucet));
}

/**
 * The faucet that delivers a tracker's bridged ETH, and its scale: the ones its route saved, else the registry of the
 * chain it was made on (DEFAULT_CHAIN_ID for a row saved before its route was). Undefined while neither names one.
 */
function deliveryOf(
  snapshot: BridgeConfigSnapshot,
  inputs: IBridgedReceiveExtraInputs
): { faucet: string; scale: number } | undefined {
  const route = inputs.agglayerRoute;
  if (route?.nativeEthFaucetId !== undefined && route.nativeEthScale !== undefined) {
    return { faucet: route.nativeEthFaucetId, scale: route.nativeEthScale };
  }
  const token = selectNativeEthToken(snapshot, route?.chainId ?? DEFAULT_CHAIN_ID);
  return token ? { faucet: token.midenFaucetId, scale: token.scale } : undefined;
}

/**
 * Match an AggLayer-delivered note to the oldest compatible tracking row.
 * The delivery sender is authoritative: it must be the faucet that delivers the
 * row's chain (`deliveryOf`). Amount + recipient prevent two deposits to the
 * same wallet from being paired in the wrong order. A tracker holds the deposit
 * in wei and the bridge delivers it at that faucet's registry scale, so the two
 * are compared through `agglayerDeliveredAmount`. The sender delivers bridged
 * ETH, so only native ETH trackers are compatible: an ERC-20 deposit with the
 * same amount must not adopt its note.
 */
export async function takeAgglayerBridgeInInfo(args: {
  accountId: string;
  senderAccountId: string;
  amount: bigint;
}): Promise<IBridgeInInfo | undefined> {
  // A consume can land before this realm hydrated the config; from storage, never the network.
  await initBridgeConfig();
  const snapshot = getBridgeConfigSnapshot();
  const override = e2eAgglayerSenderOverride;
  const sentBy = (faucet: string) =>
    override ? compareAccountIds(override.trim(), args.senderAccountId) : sentByFaucet(args.senderAccountId, faucet);

  // A `ready` tracker is never polled again, so the reconciler's timeout never fails it; a tracker whose delivery came
  // long ago would otherwise take the next deposit of the same amount.
  const cutoffSec = Math.floor((Date.now() - BRIDGE_RECEIVE_MAX_AGE_MS) / 1000);

  const matches = await Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(tx => {
      if (tx.type !== 'bridged-receive' || !compareAccountIds(tx.accountId, args.accountId)) return false;
      // A restored tracker must not adopt a genuine incoming note: the match
      // rewrites that row to `received` and makes the real consume hide beneath
      // it in history, so an honest receive would be filed under, and titled by,
      // whatever the backup's author wrote.
      if (tx.restoredFromBackup) return false;
      const inputs = tx.extraInputs as IBridgedReceiveExtraInputs | undefined;
      if (
        inputs?.provider !== 'agglayer' ||
        inputs.sourceSymbol !== AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL ||
        inputs.phase === 'received' ||
        inputs.phase === 'failed' ||
        tx.initiatedAt < cutoffSec ||
        tx.amount === undefined
      ) {
        return false;
      }
      const delivery = deliveryOf(snapshot, inputs);
      return (
        delivery !== undefined &&
        agglayerDeliveredAmount(tx.amount, delivery.scale) === args.amount &&
        sentBy(delivery.faucet)
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

/** A tracker the reconciler timed out after Circle attested its deposit, so its mint can still come. */
function isAttestedTimeout(inputs: IBridgedReceiveExtraInputs): boolean {
  return inputs.phase === 'failed' && inputs.readyAt !== undefined && inputs.error === BRIDGE_DELIVERY_TIMED_OUT;
}

/**
 * Match a note the USDCx faucet minted to the oldest compatible xReserve tracking row.
 * The faucet is the chain's native asset and also sends ordinary faucet requests, so the
 * sender alone proves nothing. The row must be a broadcast deposit (it has its EVM hash)
 * of the same account and the same amount, which xReserve mints 1:1. The rows are read
 * first, so a consume with no open USDCx deposit never waits for the native asset id.
 * An open row is one the reconciler still tracks, which a deposit attested or executed
 * after its first week still is. A row that timed out after Circle attested it still takes
 * a late mint, at any age, but only after every open row: its deposit was proven, so its
 * mint can still come.
 */
export async function takeUsdcxBridgeInInfo(args: {
  accountId: string;
  senderAccountId: string;
  faucetId: string;
  amount: bigint;
}): Promise<IBridgeInInfo | undefined> {
  const cutoffSec = Math.floor((Date.now() - BRIDGE_RECEIVE_MAX_AGE_MS) / 1000);
  const matches = await Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(tx => {
      if (tx.type !== 'bridged-receive' || !compareAccountIds(tx.accountId, args.accountId)) return false;
      // A restored tracker must not adopt a genuine incoming note, as for an AggLayer delivery.
      if (tx.restoredFromBackup) return false;
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      if (inputs?.provider !== 'usdcx' || inputs.evmTxHash === undefined || tx.amount !== args.amount) return false;
      if (isAttestedTimeout(inputs)) return true;
      return inputs.phase !== 'received' && inputs.phase !== 'failed' && withinDeliveryWindow(tx, inputs, cutoffSec);
    })
    .toArray();
  // The mint follows Circle's attestation of the deposit, so a row whose deposit is attested (`ready`) is the
  // one this note belongs to; a row still `delivering` is a fallback for a mint the watcher has not caught up
  // with. Among equals the oldest wins. Age alone paired a note with an older deposit that was never executed
  // and left the attested one at "Pending".
  const rank = (tx: ITransaction): number => {
    if (tx.extraInputs?.phase === 'ready') return 0;
    return tx.extraInputs?.phase === 'failed' ? 2 : 1;
  };
  matches.sort((a, b) => rank(a) - rank(b) || a.initiatedAt - b.initiatedAt);
  const match = matches[0];
  if (!match) return undefined;

  const usdcxFaucetId = await getNativeAssetId();
  if (!sameWalletAccountId(args.senderAccountId, usdcxFaucetId) || !sameWalletAccountId(args.faucetId, usdcxFaucetId)) {
    return undefined;
  }
  const inputs: IBridgedReceiveExtraInputs = match.extraInputs;
  return {
    provider: 'usdcx',
    sourceAmount: inputs.sourceAmount,
    sourceSymbol: inputs.sourceSymbol,
    evmTxHash: inputs.evmTxHash,
    bridgeReceiveTxId: match.id
  };
}

/** A claimed note's facts, as adoption pairs it with a tracking row. */
export interface AdoptableNote {
  id: string;
  senderAddress: string;
  faucetId: string;
  /** Absent for a note with no readable amount: the intent registry, which pairs by id alone, is its only match. */
  amount?: bigint;
}

/**
 * The notes a completed consume adopts by: the per-note facts it kept at queue time, else the one note a single-note
 * row from before them names. Undefined for an older batch, which kept nothing per note.
 */
export function adoptableNotesOf(
  tx: Pick<ITransaction, 'consumedNotes' | 'noteId' | 'noteIds' | 'secondaryAccountId' | 'faucetId' | 'amount'>
): AdoptableNote[] | undefined {
  if (tx.consumedNotes !== undefined) return [...tx.consumedNotes];
  if ((tx.noteIds?.length ?? 1) > 1) return undefined;
  const { noteId, secondaryAccountId, faucetId, amount } = tx;
  if (!noteId) return [];
  return [{ id: noteId, senderAddress: secondaryAccountId ?? '', faucetId: faucetId ?? '', amount }];
}

/** Whether a consume claimed more than one note; a batch from before the per-note facts has no `notes`. */
function claimedSeveral(noteIds: readonly string[] | undefined, notes: readonly AdoptableNote[] | undefined): boolean {
  return notes === undefined || notes.length > 1 || (noteIds?.length ?? notes.length) > 1;
}

async function takeDeliveryInfo(accountId: string, note: AdoptableNote): Promise<IBridgeInInfo | undefined> {
  const { senderAddress, faucetId, amount } = note;
  // A note missing a pairing fact can only be a registry delivery, which the registry pass pairs by id.
  if (!senderAddress || !faucetId || amount === undefined) return undefined;
  return (
    (await takeAgglayerBridgeInInfo({ accountId, senderAccountId: senderAddress, amount })) ??
    (await takeUsdcxBridgeInInfo({ accountId, senderAccountId: senderAddress, faucetId, amount }))
  );
}

/** The notes some tracking row already names as its delivery. */
async function adoptedNoteKeys(notes: readonly AdoptableNote[]): Promise<Set<string>> {
  const keys = new Set(notes.map(note => noteIdKey(note.id)));
  const named = (tx: ITransaction): string | undefined => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    return inputs?.midenNoteId === undefined ? undefined : noteIdKey(inputs.midenNoteId);
  };
  const rows = await Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(tx => {
      const key = named(tx);
      return key !== undefined && keys.has(key);
    })
    .toArray();
  return new Set(rows.flatMap(tx => named(tx) ?? []));
}

/**
 * Settle the bridge deliveries a completed consume claimed: the intent registry first, then a single note by its own
 * sender and amount, which makes the consume the deposit's receipt, then each note of a batch by its own sender,
 * faucet and amount, one at a time so two same-amount mints take two rows (only the tracking rows move). Six landing
 * paths call this, so a note a tracking row already names is skipped: a second call must not take another deposit of
 * the same amount. Never throws: tagging must never fail the consume.
 */
export async function adoptBridgeDeliveries(consumeId: string, notes: readonly AdoptableNote[]): Promise<void> {
  try {
    const consume = await Repo.transactions.where({ id: consumeId }).first();
    if (!consume || consume.extraInputs?.bridgeIn) return;
    const adopted = await adoptedNoteKeys(notes);
    const open = notes.filter(note => !adopted.has(noteIdKey(note.id)));
    if (open.length === 0) return;
    const batch = claimedSeveral(consume.noteIds, notes);
    // The registry takes at most one note; the batch below pairs every other one, by the registry's canonical id.
    let registryNoteKey: string | undefined;
    const registry = applyBridgeInInfoForNotes(
      open.map(note => note.id),
      info => {
        if (info.midenNoteId) registryNoteKey = noteIdKey(info.midenNoteId);
        if (!batch) return applyBridgeInToConsumeRow(consumeId, info);
        return applyBridgeInToBatchNote(
          consumeId,
          info,
          open.find(note => noteIdKey(note.id) === registryNoteKey)
        );
      }
    );
    const [single] = open;
    if (!batch) {
      if ((await registry) || !single) return;
      // A note the USDCx faucet minted for an xReserve deposit is otherwise an ordinary faucet receive.
      const info = await takeDeliveryInfo(consume.accountId, single);
      if (info) await applyBridgeInToConsumeRow(consumeId, { ...info, midenNoteId: single.id });
      return;
    }
    // An unsettled registry delivery stays registered for a replay, but nothing re-runs this pass for the other notes.
    await registry.catch((err: unknown) =>
      console.warn('[bridge-in] registry delivery of a batch not settled (kept for retry)', consumeId, err)
    );
    // A batch's per-faucet total is no single delivery's amount, and native USDCx mints are auto-claimed together.
    for (const note of open) {
      if (registryNoteKey !== undefined && noteIdKey(note.id) === registryNoteKey) continue;
      const info = await takeDeliveryInfo(consume.accountId, note);
      if (!info?.bridgeReceiveTxId || note.amount === undefined) continue;
      const { updateBridgedReceivePhase } = await import('../transaction/complete');
      await updateBridgedReceivePhase(
        info.bridgeReceiveTxId,
        'received',
        { midenNoteId: note.id },
        { amount: note.amount, faucetId: note.faucetId, transactionId: consume.transactionId }
      );
    }
  } catch (err) {
    console.warn('[bridge-in] consume tagging failed (non-fatal)', consumeId, err);
  }
}

/**
 * Adoption for a consume completed with no transaction result, by a landing the node proved: the per-note facts the
 * row kept are all there is to pair by. Never throws.
 */
export async function adoptLandedConsume(consumeId: string): Promise<void> {
  try {
    const consume = await Repo.transactions.where({ id: consumeId }).first();
    if (consume?.type !== 'consume' || consume.status !== ITransactionStatus.Completed || consume.restoredFromBackup)
      return;
    const notes = adoptableNotesOf(consume);
    if (notes === undefined) {
      console.warn('[bridge-in] a landed batch consume kept no per-note facts, so none is adopted', consumeId);
      return;
    }
    await adoptBridgeDeliveries(consumeId, notes);
  } catch (err) {
    console.warn('[bridge-in] landed consume adoption failed (non-fatal)', consumeId, err);
  }
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
    const existing = registry.find(record => registryIdentity(record) === key);
    if (existing) {
      // An intent registered before its allocator was known gains the one its tracking row saved; a saved one stands.
      if (!existing.info.epochAllocatorUrl && info.epochAllocatorUrl) {
        existing.info = { ...existing.info, epochAllocatorUrl: info.epochAllocatorUrl };
        await writeRegistry(registry);
      }
      return;
    }
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
    // All at once, and only until a read finds a consumed note: consume completion waits here under the transaction
    // loop's lock, so neither the number of unresolved intents nor an unrelated read that hangs extends the wait.
    const unresolved = snapshot.filter(intent => !intent.midenNoteId);
    await new Promise<void>(resolve => {
      let pending = unresolved.length;
      if (pending === 0) resolve();
      unresolved.forEach(intent => {
        void pollIntentNoteId(intent).then(noteId => {
          pending -= 1;
          if (noteId) discovered.set(registryIdentity(intent), noteId);
          if (pending === 0 || (noteId && consumedKeys.has(noteIdKey(noteId)))) resolve();
        });
      });
    });
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
