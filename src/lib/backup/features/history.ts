/**
 * The `history` feature (architecture doc 6).
 *
 * PROJECTION (6.1, 6.3). A synced row is a projection of `ITransaction`, not
 * the row: raw bytes, retry counters, relay state, stage stamps, diagnostics
 * and the Guardian candidate stay on the device that made the row. `x` holds
 * the type-specific fields of the table in 6.3. Times are unix ms. A row
 * carries at most 16 note ids.
 *
 * CHUNKS (6.4). Each device writes only its own stream, `history:<deviceId>:<n>`.
 * A row is appended to the open chunk when it reaches Completed; a chunk that
 * the row would take past the 25 KiB blob cap closes and chunk n + 1 opens.
 * A later receipt change rewrites the row in its own chunk. Receipt changes
 * can grow a closed chunk past the cap (a claim hash on every bridge row):
 * such a chunk spills its last rows into the open chunk, and both are
 * uploaded. A peer that holds a spilled row from the old chunk replaces it
 * when the new chunk arrives, since the row keeps its id. The chunk
 * assignment is kept locally and chunk updates run one at a time.
 *
 * RESTORE (6.2). A row of another device lands in the local table with
 * `restoredFromBackup`, which keeps it away from the processing loop, Retry,
 * `waitForTransaction` and every reconciler. Only Completed and Failed rows
 * are restored; a live status from the server is refused.
 */
import {
  ITransaction,
  ITransactionIcon,
  ITransactionStatus,
  ITransactionType,
  isLiveTransaction
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { isRecord } from 'lib/update/guards';

import { HISTORY_BLOB_CAP, encryptedBlobLength, plaintextDigest } from '../crypto';
import { type IncomingEntry, hashedKeyOf, readFeature, uploadEntries } from '../entries';
import type { BackupSession } from '../session';
import { type HistoryState, getBackupDeviceId, persistBackupState } from '../state';

/** The most note ids one row carries. */
export const MAX_ROW_NOTE_IDS = 16;
/**
 * Room kept free in each chunk for later receipt changes (a claim hash, a
 * received amount). An append that would leave less closes the chunk.
 */
export const CHUNK_HEADROOM_BYTES = 1536;

/** Type-specific fields of a row: flat, short keys, plain values. */
export type HistoryRowExtra = Record<string, string | number>;

/** One synced row, version 1. */
export interface HistoryRow {
  v: 1;
  id: string;
  t: ITransactionType;
  s: ITransactionStatus;
  ic: ITransactionIcon;
  a: string;
  sa?: string;
  f?: string;
  am?: string;
  fa?: string;
  tx?: string;
  n?: string[];
  ia: number;
  ca?: number;
  m?: string;
  x?: HistoryRowExtra;
}

export function historyEntryKey(deviceId: string, n: number): string {
  return `history:${deviceId}:${n}`;
}

/** A row this device appends: its own, and Completed. */
export function isAppendableRow(tx: ITransaction): boolean {
  return tx.status === ITransactionStatus.Completed && !tx.restoredFromBackup && !tx.recovered;
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A bigint or a decimal string, as a decimal string. */
function pickDecimal(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  return undefined;
}

/** Keep only the fields that have a value. */
function compact(fields: Record<string, string | number | undefined>): HistoryRowExtra | undefined {
  const extra: HistoryRowExtra = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** The `x` of a row, per the table in architecture doc 6.3. */
export function projectExtra(tx: ITransaction): HistoryRowExtra | undefined {
  const raw: unknown = tx.extraInputs;
  if (!isRecord(raw)) return undefined;
  switch (tx.type) {
    case 'bridged-send':
      return compact({
        pv: pickString(raw, 'provider'),
        da: pickString(raw, 'destinationAddress'),
        dn: pickNumber(raw, 'destinationNetwork'),
        sf: pickString(raw, 'sourceFaucetId'),
        cs: pickString(raw, 'claimStatus'),
        ct: pickString(raw, 'claimTxHash'),
        xh: pickString(raw, 'agglayerExitTxHash'),
        eh: pickString(raw, 'evmTxHash'),
        fh: pickString(raw, 'fillTxHash'),
        fc: pickNumber(raw, 'fillChainId')
      });
    case 'bridged-receive':
      return compact({
        pv: pickString(raw, 'provider'),
        sc: pickNumber(raw, 'sourceChainId'),
        sd: pickString(raw, 'sourceAddress'),
        sm: pickString(raw, 'sourceAmount'),
        ss: pickString(raw, 'sourceSymbol'),
        eh: pickString(raw, 'evmTxHash'),
        in: pickString(raw, 'intentNonce'),
        mn: pickString(raw, 'midenNoteId'),
        oa: pickString(raw, 'outputAmount'),
        os: pickString(raw, 'outputSymbol'),
        ph: pickString(raw, 'phase')
      });
    case 'earn-deposit':
      return compact({
        mu: pickString(raw, 'marketUid'),
        er: pickString(raw, 'evmRecipient'),
        in: pickString(raw, 'intentNonce'),
        eh: pickString(raw, 'evmTxHash'),
        es: pickString(raw, 'epochStatus'),
        pr: pickString(raw, 'protocol'),
        ci: pickNumber(raw, 'chainId')
      });
    case 'earn-withdraw':
      return compact({
        mu: pickString(raw, 'marketUid'),
        er: pickString(raw, 'evmOwner'),
        in: pickString(raw, 'withdrawIntentNonce'),
        eh: pickString(raw, 'evmTxHash'),
        es: pickString(raw, 'phase'),
        pr: pickString(raw, 'protocol'),
        ci: pickNumber(raw, 'chainId')
      });
    case 'swap':
      return compact({
        rf: pickString(raw, 'requestedFaucetId'),
        ra: pickDecimal(raw, 'requestedAmount'),
        on: tx.outputNoteIds?.[0],
        sk: settlementKindOf(raw)
      });
    case 'consume': {
      const purchase = raw.gcPurchase;
      if (!isRecord(purchase)) return undefined;
      return compact({
        gs: pickString(purchase, 'saleNoteId'),
        gl: pickString(purchase, 'sellerAccountId'),
        gp: pickString(purchase, 'payFaucetId'),
        gq: pickDecimal(purchase, 'fillAmount'),
        gf: pickString(purchase, 'gcFaucetId'),
        ge: pickDecimal(purchase, 'expectedAmount')
      });
    }
    case 'send':
    case 'execute':
    case 'switch-guardian':
    case 'update-procedure-threshold':
      return undefined;
    case 'replace-hot-key':
      return compact({ rc: pickString(raw, 'revokedSignerCommitment'), mode: pickString(raw, 'mode') });
  }
}

function settlementKindOf(raw: Record<string, unknown>): string | undefined {
  if (pickNumber(raw, 'settledAt') !== undefined) return 'settle';
  if (pickNumber(raw, 'reclaimedAt') !== undefined) return 'reclaim';
  return undefined;
}

function noteIdsOf(tx: ITransaction): string[] | undefined {
  const ids = new Set<string>();
  for (const id of [...(tx.noteIds ?? []), ...(tx.noteId ? [tx.noteId] : []), ...(tx.outputNoteIds ?? [])]) {
    if (id) ids.add(id);
  }
  const list = [...ids].slice(0, MAX_ROW_NOTE_IDS);
  return list.length > 0 ? list : undefined;
}

/** Project one local row. Seconds become unix ms. */
export function projectTransaction(tx: ITransaction): HistoryRow {
  return {
    v: 1,
    id: tx.id,
    t: tx.type,
    s: tx.status,
    ic: tx.displayIcon,
    a: tx.accountId,
    sa: tx.secondaryAccountId,
    f: tx.faucetId,
    am: tx.amount === undefined ? undefined : tx.amount.toString(),
    fa: tx.feeAmount === undefined ? undefined : tx.feeAmount.toString(),
    tx: tx.transactionId,
    n: noteIdsOf(tx),
    ia: tx.initiatedAt * 1000,
    ca: tx.completedAt === undefined ? undefined : tx.completedAt * 1000,
    m: tx.displayMessage,
    x: projectExtra(tx)
  };
}

function readTransactionType(value: unknown): ITransactionType | null {
  switch (value) {
    case 'send':
    case 'consume':
    case 'execute':
    case 'bridged-send':
    case 'bridged-receive':
    case 'earn-deposit':
    case 'earn-withdraw':
    case 'switch-guardian':
    case 'replace-hot-key':
    case 'swap':
    case 'update-procedure-threshold':
      return value;
    default:
      return null;
  }
}

function readIcon(value: unknown): ITransactionIcon | null {
  switch (value) {
    case 'SEND':
    case 'RECEIVE':
    case 'SWAP':
    case 'FAILED':
    case 'MINT':
    case 'DEFAULT':
      return value;
    default:
      return null;
  }
}

/** Only terminal statuses are restored. A live status from a peer is never written. */
function readTerminalStatus(value: unknown): ITransactionStatus | null {
  switch (value) {
    case ITransactionStatus.Completed:
      return ITransactionStatus.Completed;
    case ITransactionStatus.Failed:
      return ITransactionStatus.Failed;
    default:
      return null;
  }
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function optionalDecimal(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && /^-?\d+$/.test(value) ? value : null;
}

function readExtra(value: unknown): HistoryRowExtra | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const extra: HistoryRowExtra = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field))) extra[key] = field;
  }
  return extra;
}

function readNoteIds(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === 'string').slice(0, MAX_ROW_NOTE_IDS);
  return ids;
}

/** Parse one row of a decrypted chunk. Null for any other shape. */
export function parseHistoryRow(value: unknown): HistoryRow | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const t = readTransactionType(value.t);
  const s = readTerminalStatus(value.s);
  const ic = readIcon(value.ic);
  const { id, a, ia, ca } = value;
  if (t === null || s === null || ic === null || typeof id !== 'string' || id === '' || typeof a !== 'string') {
    return null;
  }
  if (typeof ia !== 'number' || !Number.isSafeInteger(ia) || ia < 0) return null;
  if (ca !== undefined && (typeof ca !== 'number' || !Number.isSafeInteger(ca) || ca < 0)) return null;
  const sa = optionalString(value.sa);
  const f = optionalString(value.f);
  const tx = optionalString(value.tx);
  const m = optionalString(value.m);
  const am = optionalDecimal(value.am);
  const fa = optionalDecimal(value.fa);
  const n = readNoteIds(value.n);
  const x = readExtra(value.x);
  if (
    sa === null ||
    f === null ||
    tx === null ||
    m === null ||
    am === null ||
    fa === null ||
    n === null ||
    x === null
  ) {
    return null;
  }
  return { v: 1, id, t, s, ic, a, sa, f, am, fa, tx, n, ia, ca, m, x };
}

/** Parse a decrypted chunk: a JSON array of rows. Rows of another shape are dropped. */
export function parseHistoryChunk(plaintext: string): HistoryRow[] {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map(parseHistoryRow).filter(row => row !== null);
}

function extraString(extra: HistoryRowExtra | undefined, key: string): string | undefined {
  const value = extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

function extraNumber(extra: HistoryRowExtra | undefined, key: string): number | undefined {
  const value = extra?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Rebuild the `extraInputs` a receipt reads from `x`. Fields without a value stay absent. */
export function restoreExtraInputs(row: HistoryRow): Record<string, unknown> | undefined {
  const x = row.x;
  switch (row.t) {
    case 'bridged-send':
      return {
        provider: extraString(x, 'pv'),
        destinationAddress: extraString(x, 'da'),
        destinationNetwork: extraNumber(x, 'dn'),
        sourceFaucetId: extraString(x, 'sf'),
        claimStatus: extraString(x, 'cs'),
        claimTxHash: extraString(x, 'ct'),
        agglayerExitTxHash: extraString(x, 'xh'),
        evmTxHash: extraString(x, 'eh'),
        fillTxHash: extraString(x, 'fh'),
        fillChainId: extraNumber(x, 'fc')
      };
    case 'bridged-receive':
      return {
        provider: extraString(x, 'pv'),
        sourceChainId: extraNumber(x, 'sc'),
        sourceAddress: extraString(x, 'sd'),
        sourceAmount: extraString(x, 'sm'),
        sourceSymbol: extraString(x, 'ss'),
        evmTxHash: extraString(x, 'eh'),
        intentNonce: extraString(x, 'in'),
        midenNoteId: extraString(x, 'mn'),
        outputAmount: extraString(x, 'oa'),
        outputSymbol: extraString(x, 'os'),
        phase: extraString(x, 'ph')
      };
    case 'earn-deposit':
      return {
        marketUid: extraString(x, 'mu'),
        evmRecipient: extraString(x, 'er'),
        intentNonce: extraString(x, 'in'),
        evmTxHash: extraString(x, 'eh'),
        epochStatus: extraString(x, 'es'),
        protocol: extraString(x, 'pr'),
        chainId: extraNumber(x, 'ci')
      };
    case 'earn-withdraw':
      return {
        marketUid: extraString(x, 'mu'),
        evmOwner: extraString(x, 'er'),
        withdrawIntentNonce: extraString(x, 'in'),
        evmTxHash: extraString(x, 'eh'),
        phase: extraString(x, 'es'),
        protocol: extraString(x, 'pr'),
        chainId: extraNumber(x, 'ci')
      };
    case 'swap': {
      const requested = extraString(x, 'ra');
      return {
        requestedFaucetId: extraString(x, 'rf'),
        requestedAmount: requested === undefined ? undefined : BigInt(requested),
        settledAt: extraString(x, 'sk') === 'settle' ? row.ca : undefined,
        reclaimedAt: extraString(x, 'sk') === 'reclaim' ? row.ca : undefined
      };
    }
    case 'consume':
      return extraString(x, 'gs') === undefined
        ? undefined
        : {
            gcPurchase: {
              saleNoteId: extraString(x, 'gs'),
              sellerAccountId: extraString(x, 'gl'),
              payFaucetId: extraString(x, 'gp'),
              fillAmount: extraString(x, 'gq'),
              gcFaucetId: extraString(x, 'gf'),
              expectedAmount: extraString(x, 'ge')
            }
          };
    case 'send':
    case 'execute':
    case 'switch-guardian':
    case 'update-procedure-threshold':
      return undefined;
    case 'replace-hot-key':
      return { revokedSignerCommitment: extraString(x, 'rc'), mode: extraString(x, 'mode') };
  }
}

/** Rebuild a read-only local row from a peer's projection. Unix ms become seconds. */
export function restoreTransaction(row: HistoryRow): ITransaction {
  const initiatedAt = Math.floor(row.ia / 1000);
  const notes = row.n ?? [];
  const isConsume = row.t === 'consume';
  return {
    id: row.id,
    type: row.t,
    accountId: row.a,
    status: row.s,
    initiatedAt,
    completedAt: row.ca === undefined ? initiatedAt : Math.floor(row.ca / 1000),
    displayIcon: row.ic,
    displayMessage: row.m,
    secondaryAccountId: row.sa,
    faucetId: row.f,
    amount: row.am === undefined ? undefined : BigInt(row.am),
    feeAmount: row.fa === undefined ? undefined : BigInt(row.fa),
    transactionId: row.tx,
    noteId: notes[0],
    noteIds: isConsume && notes.length > 0 ? notes : undefined,
    outputNoteIds: !isConsume && notes.length > 0 ? notes : undefined,
    extraInputs: restoreExtraInputs(row),
    restoredFromBackup: true
  };
}

/**
 * Write peer rows into the local table. A row this device holds as its own is
 * never touched. A row restored before is replaced by the newer projection. A
 * row whose on-chain id another local row holds is skipped.
 */
export async function applyHistoryRows(rows: readonly HistoryRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    for (const row of rows) {
      const restored = restoreTransaction(row);
      const existing = await Repo.transactions.get(row.id);
      if (existing !== undefined) {
        if (existing.restoredFromBackup && !existing.recovered && !isLiveTransaction(existing)) {
          await Repo.transactions.put(restored);
          written += 1;
        }
        continue;
      }
      if (row.tx !== undefined && (await Repo.transactions.where('transactionId').equals(row.tx).count()) > 0) continue;
      await Repo.transactions.add(restored);
      written += 1;
    }
  });
  return written;
}

/** The decoded blob size of a chunk made of these row JSON strings. */
function chunkBlobBytes(rows: readonly string[]): number {
  const encoder = new TextEncoder();
  const body = rows.reduce((sum, row) => sum + encoder.encode(row).byteLength, 0);
  return encryptedBlobLength(2 + body + Math.max(0, rows.length - 1));
}

/**
 * Move rows out of every chunk whose rewritten body passed the cap, last row
 * first, into the open chunk (a new one when the overfull chunk is the open
 * one). Returns the chunk numbers that changed. A chunk of one row always fits,
 * since a row over the cap on its own is never projected.
 */
export function spillOverfullChunks(history: HistoryState, rowsOf: (ids: readonly string[]) => string[]): number[] {
  const changed = new Set<number>();
  for (let index = 0; index < history.chunks.length; index += 1) {
    const chunk = history.chunks[index];
    if (chunk === undefined) continue;
    while (chunk.ids.length > 1 && chunkBlobBytes(rowsOf(chunk.ids)) > HISTORY_BLOB_CAP) {
      const id = chunk.ids.pop();
      if (id === undefined) break;
      let open = history.chunks[history.chunks.length - 1];
      if (open === undefined || open === chunk) {
        open = { n: chunk.n + 1, ids: [] };
        history.chunks.push(open);
      }
      open.ids.push(id);
      const assignment = history.assigned[id];
      if (assignment !== undefined) assignment.n = open.n;
      changed.add(chunk.n);
      changed.add(open.n);
    }
  }
  return [...changed];
}

let historyChain: Promise<unknown> = Promise.resolve();

/** Run chunk updates one at a time. */
function inHistoryLane<T>(task: () => Promise<T>): Promise<T> {
  const run = historyChain.then(task, task);
  historyChain = run.catch(() => undefined);
  return run;
}

/**
 * Append new Completed rows to this device's chunks, rewrite the chunks whose
 * rows changed, and upload the changed chunks. Returns how many chunks the
 * server acknowledged.
 */
export function flushHistory(session: BackupSession): Promise<number> {
  return inHistoryLane(async () => {
    const deviceId = await getBackupDeviceId();
    const history = session.state.history;
    const projections = new Map<string, string>();
    const project = (tx: ITransaction) => {
      const json = JSON.stringify(projectTransaction(tx));
      if (chunkBlobBytes([json]) > HISTORY_BLOB_CAP) {
        console.warn(`[backup] history row ${tx.id} is over the chunk cap; not synced`);
        return;
      }
      projections.set(tx.id, json);
    };

    // Rows already in a chunk: their current projection, whatever their status now.
    const assignedIds = Object.keys(history.assigned);
    const assignedRows = await Repo.transactions.bulkGet(assignedIds);
    for (const tx of assignedRows) {
      if (tx !== undefined && !tx.restoredFromBackup) project(tx);
    }
    const dirty = new Set(history.dirty);
    for (const [id, assignment] of Object.entries(history.assigned)) {
      const json = projections.get(id);
      if (json === undefined) continue;
      const digest = plaintextDigest(json);
      if (digest !== assignment.digest) {
        assignment.digest = digest;
        dirty.add(assignment.n);
      }
    }

    // New Completed rows, oldest first, appended to the open chunk.
    const candidates = await Repo.transactions
      .filter(tx => isAppendableRow(tx) && history.assigned[tx.id] === undefined)
      .toArray();
    candidates.sort(
      (a, b) =>
        (a.completedAt ?? a.initiatedAt) - (b.completedAt ?? b.initiatedAt) ||
        a.initiatedAt - b.initiatedAt ||
        a.id.localeCompare(b.id)
    );
    const rowsOf = (ids: readonly string[]) =>
      ids.map(id => projections.get(id)).filter((json): json is string => json !== undefined);
    for (const tx of candidates) {
      project(tx);
      const json = projections.get(tx.id);
      if (json === undefined) continue;
      let open = history.chunks[history.chunks.length - 1];
      if (open === undefined) {
        open = { n: 0, ids: [] };
        history.chunks.push(open);
      }
      const after = chunkBlobBytes([...rowsOf(open.ids), json]);
      if (open.ids.length > 0 && after > HISTORY_BLOB_CAP - CHUNK_HEADROOM_BYTES) {
        open = { n: open.n + 1, ids: [] };
        history.chunks.push(open);
      }
      open.ids.push(tx.id);
      history.assigned[tx.id] = { n: open.n, digest: plaintextDigest(json) };
      dirty.add(open.n);
    }
    // A rewritten chunk can be over the cap now: its last rows move to the open chunk.
    for (const n of spillOverfullChunks(history, rowsOf)) dirty.add(n);
    history.dirty = [...dirty].sort((a, b) => a - b);
    await persistBackupState(session.state);
    if (history.dirty.length === 0) return 0;

    // A row this device no longer holds keeps no projection, so a rewrite of its chunk drops it.
    const outgoing = history.dirty.flatMap(n => {
      const chunk = history.chunks.find(candidate => candidate.n === n);
      if (chunk === undefined) return [];
      return [{ entryKey: historyEntryKey(deviceId, n), plaintext: `[${rowsOf(chunk.ids).join(',')}]` }];
    });
    const written = await uploadEntries(session, 'history', outgoing);
    const marks = session.state.features.history.entries;
    history.dirty = history.dirty.filter(n => {
      const item = outgoing.find(candidate => candidate.entryKey === historyEntryKey(deviceId, n));
      if (item === undefined) return false;
      return marks[hashedKeyOf(session, item.entryKey)]?.digest !== plaintextDigest(item.plaintext);
    });
    await persistBackupState(session.state);
    return written.length;
  });
}

/** The hashed keys of this device's own chunks: never applied from the server. */
async function ownChunkKeys(session: BackupSession): Promise<Set<string>> {
  const deviceId = await getBackupDeviceId();
  return new Set(session.state.history.chunks.map(chunk => hashedKeyOf(session, historyEntryKey(deviceId, chunk.n))));
}

/**
 * How many history chunks of OTHER devices this device has applied: the
 * server entries it recorded, less its own chunks. More than zero means the
 * backup holds a peer's history, so the backup is the record of history.
 */
export async function peerHistoryChunkCount(session: BackupSession): Promise<number> {
  const own = await ownChunkKeys(session);
  return Object.keys(session.state.features.history.entries).filter(key => !own.has(key)).length;
}

/**
 * Read the chunks of other devices and write their rows locally. `since`
 * bounds the read to chunks written at or after the last applied cursor.
 * Returns true when a read brought new chunks.
 */
export async function readHistory(session: BackupSession, since: boolean): Promise<boolean> {
  const ownHashedKeys = await ownChunkKeys(session);
  const outcome = await readFeature(session, 'history', {
    since,
    ownHashedKeys,
    apply: async (entries: IncomingEntry[]) => {
      const rows = entries.flatMap(entry => parseHistoryChunk(entry.plaintext));
      await applyHistoryRows(rows);
    }
  });
  return outcome === 'applied';
}
