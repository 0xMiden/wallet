// The Sender: it chooses the relayer nonce, signs the relay transaction, stores it and only then broadcasts it. A
// timer (the Durable Object alarm) then follows each stored transaction to its receipt: it sends the same bytes again,
// replaces the fee of a slow transaction and cancels a transaction after its batch deadline. One Sender serves one
// chain. The Durable Object in sender-object.ts wraps this class; the tests give its dependencies.
import { isHex, keccak256, type TransactionSerializableEIP1559, type TransactionSerializableEIP7702 } from 'viem';

import { maxFeeOf, type BroadcastOutcome, type FeeQuote, type ReceiptStatus, type RelayAuthorization } from './chain';
import { notConfigured } from './errors';
import { isRecord } from './http';
import type { Hex } from './parse';
import type { Env } from './types';

/** The time from one tick to the next while a relay is pending. */
export const TICK_INTERVAL_MS = 30_000;
/** A pending transaction gets a new fee when it has no receipt this long after its last signature. */
export const REPLACE_AFTER_MS = 3 * 60_000;
/** A new fee is at least the old fee plus this percentage. Nodes refuse a replacement below about +10 %. */
export const FEE_BUMP_PERCENT = 15n;
/** A tick or a submit deletes a final row whose last change is older than this. */
export const FINAL_ROW_TTL_MS = 24 * 60 * 60_000;
/** A pending row gets a cancel transaction when its batch deadline is more than this far in the past. */
export const CANCEL_AFTER_DEADLINE_MS = 60_000;
/** The gas limit of a cancel transaction: a plain transfer with no data. */
export const CANCEL_GAS = 21_000n;

export type SqlValue = string | number | null;

/** The SQL access of the Sender. The Durable Object gives its SQLite storage; the tests give node:sqlite. */
export interface SqlDatabase {
  /** Run one statement with its bindings and return its rows. */
  run(query: string, ...bindings: SqlValue[]): Record<string, unknown>[];
  /** Run the closure in one transaction. It commits when the closure returns and rolls back when it throws. */
  transaction<T>(closure: () => T): T;
}

export type RelayTransaction = TransactionSerializableEIP1559 | TransactionSerializableEIP7702;

export interface SenderDeps {
  sql: SqlDatabase;
  /** The address of the current relayer key, lower case. Throws when the key is not valid. */
  relayer(): Hex;
  /** Sign with the current relayer key. Return the signed transaction bytes. */
  sign(transaction: RelayTransaction): Promise<Hex>;
  /** Send signed bytes to the chain. Throws on a failure; a later tick sends the stored bytes again. */
  broadcast(chainId: number, raw: Hex): Promise<BroadcastOutcome>;
  /** The receipt status of each hash, in hash order, in one JSON-RPC batch. Null while the chain has no receipt. */
  receipts(chainId: number, hashes: readonly Hex[]): Promise<(ReceiptStatus | null)[]>;
  /** The fees that the node suggests now. */
  fees(chainId: number): Promise<FeeQuote>;
  /** The time of the armed alarm, or null when none is armed. */
  alarmAt(): Promise<number | null>;
  /** Arm the alarm at this time, in place of an armed one. */
  schedule(atMs: number): Promise<void>;
  now(): number;
}

/**
 * `expired`: the batch was not executed and never will be. A cancel transaction took its relayer nonce after the
 * batch deadline, and `txHash` is that cancel transaction.
 */
export type RelayJobState = 'pending' | 'succeeded' | 'reverted' | 'expired';

/** The answer of the relay routes. */
export interface RelayJob {
  id: Hex;
  state: RelayJobState;
  txHash: Hex;
}

/** A checked relay, which the route hands to the Sender of its chain. */
export interface SubmitJob {
  /** The EIP-712 digest of the batch. */
  id: Hex;
  chainId: number;
  evmAddress: Hex;
  /** The calldata of `execute` on the address. It encodes every call of the batch. */
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Sent in a type 4 transaction when it is not null, else the transaction is type 2. */
  authorization: RelayAuthorization | null;
  /** The batch deadline, in unix seconds. */
  deadline: number;
  /** The pending transaction count of the relayer, as the route read it. */
  chainNonce: number;
}

/** `busy`: another relay of the address is pending; `id` is that relay. */
export type SubmitOutcome = { status: 'job'; job: RelayJob } | { status: 'busy'; id: Hex };

/** The relay access of a route. One client per chain. */
export interface SenderClient {
  get(id: Hex): Promise<RelayJob | null>;
  submit(job: SubmitJob): Promise<SubmitOutcome>;
}

export type SenderDirectory = (chainId: number) => SenderClient;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  // `relayer` is the address of the key that signed the row. `sent_hashes` is a JSON array of every hash broadcast for
  // the row. `cancel_hashes` is the JSON array of the hashes in `sent_hashes` that are cancel transactions; a row with
  // one is cancelling. A final row has no signed bytes and no request, because both hold the user's signature.
  `CREATE TABLE IF NOT EXISTS inflight (
    id TEXT PRIMARY KEY,
    evm_address TEXT NOT NULL,
    relayer TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    sent_hashes TEXT NOT NULL,
    cancel_hashes TEXT NOT NULL DEFAULT '[]',
    raw_tx TEXT,
    request TEXT,
    nonce INTEGER NOT NULL,
    max_fee TEXT NOT NULL,
    max_priority_fee TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'reverted', 'expired')),
    attempts INTEGER NOT NULL,
    nonce_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    signed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (state <> 'pending' OR (raw_tx IS NOT NULL AND request IS NOT NULL))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS inflight_open_address ON inflight (evm_address) WHERE state = 'pending'",
  // A nonce belongs to one relayer account, so a pending row of an old key can hold the nonce of a new key's row.
  "CREATE UNIQUE INDEX IF NOT EXISTS inflight_pending_nonce ON inflight (relayer, nonce) WHERE state = 'pending'"
];

/**
 * What the Sender needs to sign a relay again: the transaction without its nonce and its fees. `data` is the
 * `execute` calldata, which holds every call of the batch in the signed order, the envelope and the user's signature.
 * A fee replacement signs the same `data`, so the replacement executes the same calls.
 */
interface SignRequest {
  to: Hex;
  data: Hex;
  gas: bigint;
  authorization: RelayAuthorization | null;
}

interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** A pending row, as the timer reads it. */
interface PendingRow {
  id: Hex;
  /** The address of the key that signed the row. */
  relayer: Hex;
  nonce: number;
  raw: Hex;
  request: string;
  maxFee: bigint;
  maxPriorityFee: bigint;
  /** Unix seconds. */
  deadline: number;
  attempts: number;
  nonceUsed: boolean;
  signedAt: number;
  /** Every hash broadcast for the row, the current one last. */
  hashes: Hex[];
  /** The hashes of `hashes` that are cancel transactions. The row is cancelling when this is not empty. */
  cancelHashes: Hex[];
}

/**
 * What a tick does with a pending row that has no receipt. `cancel`: sign a cancel transaction at the row's nonce.
 * `replace`: sign the user's batch again with higher fees. `resend`: send the stored bytes again.
 */
type RowAction = 'cancel' | 'replace' | 'resend';

/** The signed bytes that a tick sends after its exclusive section. */
interface Outgoing {
  id: Hex;
  raw: Hex;
}

function corrupt(): Error {
  return new Error('The stored relay has a bad value.');
}

function stateOf(value: unknown): RelayJobState {
  switch (value) {
    case 'pending':
    case 'succeeded':
    case 'reverted':
    case 'expired':
      return value;
    default:
      throw new Error('The stored relay has an unknown state.');
  }
}

function finalStateOf(status: ReceiptStatus): RelayJobState {
  switch (status) {
    case 'success':
      return 'succeeded';
    case 'reverted':
      return 'reverted';
  }
}

function hexOf(value: unknown): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) throw corrupt();
  return `0x${value.slice(2)}`;
}

function integerOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw corrupt();
  return value;
}

function amountOf(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw corrupt();
  return BigInt(value);
}

function hashesOf(value: unknown): Hex[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : null;
  if (!Array.isArray(parsed)) throw corrupt();
  return parsed.map(hexOf);
}

function pendingRowOf(row: Record<string, unknown>): PendingRow {
  if (typeof row.request !== 'string') throw corrupt();
  return {
    id: hexOf(row.id),
    relayer: hexOf(row.relayer),
    nonce: integerOf(row.nonce),
    raw: hexOf(row.raw_tx),
    request: row.request,
    maxFee: amountOf(row.max_fee),
    maxPriorityFee: amountOf(row.max_priority_fee),
    deadline: integerOf(row.deadline),
    attempts: integerOf(row.attempts),
    nonceUsed: integerOf(row.nonce_used) !== 0,
    signedAt: integerOf(row.signed_at),
    hashes: hashesOf(row.sent_hashes),
    cancelHashes: hashesOf(row.cancel_hashes)
  };
}

function requestText({ to, data, gas, authorization }: SignRequest): string {
  return JSON.stringify({ to, data, gas: gas.toString(), authorization });
}

function authorizationOf(value: unknown): RelayAuthorization | null {
  if (value === null) return null;
  if (!isRecord(value)) throw corrupt();
  const { address, chainId, nonce, r, s, yParity } = value;
  if (!isHex(address) || !isHex(r) || !isHex(s)) throw corrupt();
  return { address, chainId: integerOf(chainId), nonce: integerOf(nonce), r, s, yParity: integerOf(yParity) };
}

function requestOf(text: string): SignRequest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw corrupt();
  const { to, data, gas, authorization } = value;
  if (!isHex(to) || !isHex(data)) throw corrupt();
  return { to, data, gas: amountOf(gas), authorization: authorizationOf(authorization) };
}

function transactionOf(chainId: number, request: SignRequest, nonce: number, fees: Fees): RelayTransaction {
  const { to, data, gas, authorization } = request;
  const fields = { chainId, nonce, to, data, value: 0n, gas, ...fees };
  if (authorization === null) return { ...fields, type: 'eip1559' };
  return { ...fields, type: 'eip7702', authorizationList: [authorization] };
}

function larger(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * The old fee plus FEE_BUMP_PERCENT, rounded up, and at least the old fee plus 1. A node takes a replacement at the
 * same nonce only when both fees are higher than the old fees and at least about 10 % higher; the extra 1 makes a fee
 * of 0 higher too.
 */
function bumped(fee: bigint): bigint {
  return larger((fee * (100n + FEE_BUMP_PERCENT) + 99n) / 100n, fee + 1n);
}

/** The fees of a transaction that replaces the row at its nonce: the node's fees or the bumped old fees. */
function replacementFees(row: PendingRow, quote: FeeQuote): Fees {
  return {
    maxFeePerGas: larger(maxFeeOf(quote), bumped(row.maxFee)),
    maxPriorityFeePerGas: larger(quote.priorityFee, bumped(row.maxPriorityFee))
  };
}

/** The cancel transaction of a row: 0 from the relayer to itself, with no data, at the row's nonce. */
function cancelTransactionOf(chainId: number, relayer: Hex, nonce: number, fees: Fees): RelayTransaction {
  return { type: 'eip1559', chainId, nonce, to: relayer, value: 0n, gas: CANCEL_GAS, ...fees };
}

/** The mined hash of the row and its status, or null when no hash of the row has a receipt. */
function minedOf(row: PendingRow, mined: ReadonlyMap<Hex, ReceiptStatus>): { hash: Hex; status: ReceiptStatus } | null {
  for (const hash of row.hashes) {
    const status = mined.get(hash);
    if (status !== undefined) return { hash, status };
  }
  return null;
}

/** What one submit decided inside the exclusive section. `raw` is set only when it stored a new transaction. */
interface Stored {
  outcome: SubmitOutcome;
  raw: Hex | null;
}

export class RelaySender {
  /** The tail of the exclusive queue. Each task runs after the one before it settles. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SenderDeps) {
    for (const statement of SCHEMA) deps.sql.run(statement);
  }

  /** The stored relay, or null. */
  get(id: Hex): RelayJob | null {
    const [row] = this.deps.sql.run('SELECT id, state, tx_hash FROM inflight WHERE id = ?', id);
    if (row === undefined) return null;
    return { id: hexOf(row.id), state: stateOf(row.state), txHash: hexOf(row.tx_hash) };
  }

  /**
   * Store and send a relay. The same id again returns the stored relay. The broadcast runs after the exclusive
   * section, and its failure does not fail the submit: the row keeps the signed bytes for a later attempt.
   */
  async submit(job: SubmitJob): Promise<SubmitOutcome> {
    const { outcome, raw } = await this.exclusive(async () => {
      const stored = await this.store(job);
      await this.armIfIdle();
      return stored;
    });
    if (raw !== null) await this.send(job.chainId, job.id, raw);
    return outcome;
  }

  /**
   * Follow every pending relay once: the alarm handler. A chain failure does not throw: it changes no row, writes one
   * log line, and the next alarm still comes while a pending row remains.
   */
  async tick(): Promise<void> {
    const chainId = this.boundChain();
    try {
      if (chainId !== null) await this.follow(chainId);
    } catch {
      // A fixed text and the chain id only: an error can hold an RPC URL or signed bytes.
      console.error(`evm-relay: a Sender tick failed on chain ${chainId ?? 'unknown'}.`);
    }
    await this.exclusive(async () => {
      if (this.hasPending()) await this.deps.schedule(this.deps.now() + TICK_INTERVAL_MS);
    });
  }

  /**
   * Run the task after every task before it settles. A submit runs its nonce choice and its row commit in it, and a
   * tick its row changes, so no two of them overlap, even when the signer yields to the event loop.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Choose the nonce, sign and commit the row. It runs only inside `exclusive`. */
  private async store(job: SubmitJob): Promise<Stored> {
    this.cleanup();
    const known = this.get(job.id);
    if (known !== null) return { outcome: { status: 'job', job: known }, raw: null };
    const [open] = this.deps.sql.run(
      "SELECT id FROM inflight WHERE evm_address = ? AND state = 'pending'",
      job.evmAddress
    );
    if (open !== undefined) return { outcome: { status: 'busy', id: hexOf(open.id) }, raw: null };
    this.bindChain(job.chainId);
    const relayer = this.bindRelayer();

    const nonce = Math.max(job.chainNonce, this.nextNonce());
    const request: SignRequest = { to: job.evmAddress, data: job.data, gas: job.gas, authorization: job.authorization };
    const fees: Fees = { maxFeePerGas: job.maxFeePerGas, maxPriorityFeePerGas: job.maxPriorityFeePerGas };
    const raw = await this.deps.sign(transactionOf(job.chainId, request, nonce, fees));
    const txHash = keccak256(raw);
    const now = this.deps.now();
    // The row and the next nonce commit together, so no nonce is reserved without its signed transaction.
    this.deps.sql.transaction(() => {
      this.deps.sql.run(
        `INSERT INTO inflight (id, evm_address, relayer, tx_hash, sent_hashes, raw_tx, request, nonce, max_fee,
          max_priority_fee, deadline, state, attempts, created_at, signed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
        job.id,
        job.evmAddress,
        relayer,
        txHash,
        JSON.stringify([txHash]),
        raw,
        requestText(request),
        nonce,
        job.maxFeePerGas.toString(),
        job.maxPriorityFeePerGas.toString(),
        job.deadline,
        now,
        now,
        now
      );
      this.setMeta('next_nonce', String(nonce + 1));
    });
    return { outcome: { status: 'job', job: { id: job.id, state: 'pending', txHash } }, raw };
  }

  /**
   * Arm the alarm when a pending row exists and no alarm is armed. An alarm at or before now counts as not armed: it
   * can be the running one, which ends without a new alarm when its tick saw no pending row. Runs inside `exclusive`.
   */
  private async armIfIdle(): Promise<void> {
    if (!this.hasPending()) return;
    const armed = await this.deps.alarmAt();
    const now = this.deps.now();
    if (armed !== null && armed > now) return;
    await this.deps.schedule(now + TICK_INTERVAL_MS);
  }

  /**
   * Read the receipts of every pending row in one batch, and the fees when a replacement is due. Then store the
   * results in the exclusive section and send the signed bytes of each row without a receipt, lowest nonce first.
   */
  private async follow(chainId: number): Promise<void> {
    this.cleanup();
    const rows = this.pendingRows();
    if (rows.length === 0) return;
    const hashes = rows.flatMap(row => row.hashes);
    const statuses = await this.deps.receipts(chainId, hashes);
    if (statuses.length !== hashes.length) throw new Error('The receipt read has the wrong length.');
    const mined = new Map<Hex, ReceiptStatus>();
    hashes.forEach((hash, index) => {
      const status = statuses[index];
      if (status !== null && status !== undefined) mined.set(hash, status);
    });
    const relayer = this.currentRelayer();
    const due = rows.some(row => minedOf(row, mined) === null && this.actionOf(row, relayer) !== 'resend');
    const quote = due ? await this.quote(chainId) : null;
    const outgoing = await this.exclusive(() => this.apply(chainId, mined, quote, relayer));
    for (const { id, raw } of outgoing) await this.send(chainId, id, raw);
  }

  /** The node's fees, or null when the read fails: the rows are then sent again with their old fees. */
  private async quote(chainId: number): Promise<FeeQuote | null> {
    try {
      return await this.deps.fees(chainId);
    } catch {
      return null;
    }
  }

  /**
   * Store the receipts, the fee replacements and the cancels. Return the bytes to send. It runs only inside
   * `exclusive`.
   */
  private async apply(
    chainId: number,
    mined: ReadonlyMap<Hex, ReceiptStatus>,
    quote: FeeQuote | null,
    relayer: Hex | null
  ): Promise<Outgoing[]> {
    const outgoing: Outgoing[] = [];
    // Read the rows again: a submit can have stored one since the receipt read. It has no receipt in `mined`.
    for (const row of this.pendingRows()) {
      const receipt = minedOf(row, mined);
      if (receipt !== null) {
        // A mined cancel took the nonce: the batch was not executed. Its status does not matter.
        const state = row.cancelHashes.includes(receipt.hash) ? 'expired' : finalStateOf(receipt.status);
        this.finish(row.id, receipt.hash, state);
        continue;
      }
      outgoing.push({ id: row.id, raw: await this.nextBytes(chainId, row, quote, relayer) });
    }
    return outgoing;
  }

  /** The bytes to send for a row without a receipt: a new signature when one is due and the fees are known. */
  private async nextBytes(chainId: number, row: PendingRow, quote: FeeQuote | null, relayer: Hex | null): Promise<Hex> {
    if (quote === null) return row.raw;
    switch (this.actionOf(row, relayer)) {
      case 'cancel':
        return this.cancel(chainId, row, quote);
      case 'replace':
        return this.replace(chainId, row, quote);
      case 'resend':
        return row.raw;
    }
  }

  /**
   * What a tick does with a row that has no receipt. The Sender signs only for a row of the current relayer key, and
   * never when a mined transaction holds the nonce. A row that is not cancelling gets a cancel when its batch deadline
   * is more than CANCEL_AFTER_DEADLINE_MS in the past, and a fee replacement before its deadline when it has no
   * receipt for REPLACE_AFTER_MS after its last signature. Between the two, `execute` would revert, so the row keeps
   * its bytes. A cancelling row never signs the user's batch again: it gets a new cancel with higher fees after
   * REPLACE_AFTER_MS.
   */
  private actionOf(row: PendingRow, relayer: Hex | null): RowAction {
    if (row.relayer !== relayer || row.nonceUsed) return 'resend';
    const now = this.deps.now();
    const stale = now - row.signedAt >= REPLACE_AFTER_MS;
    const deadlineMs = row.deadline * 1000;
    switch (true) {
      case row.cancelHashes.length > 0:
        return stale ? 'cancel' : 'resend';
      case now > deadlineMs + CANCEL_AFTER_DEADLINE_MS:
        return 'cancel';
      case stale && now < deadlineMs:
        return 'replace';
      default:
        return 'resend';
    }
  }

  /**
   * Record the receipt and the final state. Drop the signed bytes and the request, which hold the user's signature.
   */
  private finish(id: Hex, hash: Hex, state: RelayJobState): void {
    this.deps.sql.run(
      `UPDATE inflight SET state = ?, tx_hash = ?, raw_tx = NULL, request = NULL, updated_at = ?
        WHERE id = ? AND state = 'pending'`,
      state,
      hash,
      this.deps.now(),
      id
    );
  }

  /**
   * Sign a cancel transaction at the row's nonce with higher fees, and store its bytes, its fees and its hash in
   * `sent_hashes` and `cancel_hashes` in one statement, before the broadcast. Return the bytes to send: the cancel, or
   * the old bytes when the signature or the write fails. `next_nonce` does not change: the cancel takes the nonce that
   * the row holds already. `actionOf` cancels only a row of the current key, so `row.relayer` is the signer.
   */
  private async cancel(chainId: number, row: PendingRow, quote: FeeQuote): Promise<Hex> {
    try {
      const fees = replacementFees(row, quote);
      const raw = await this.deps.sign(cancelTransactionOf(chainId, row.relayer, row.nonce, fees));
      const txHash = keccak256(raw);
      const cancels = [...row.cancelHashes, txHash];
      const now = this.deps.now();
      this.deps.sql.run(
        `UPDATE inflight SET tx_hash = ?, sent_hashes = ?, cancel_hashes = ?, raw_tx = ?, max_fee = ?,
          max_priority_fee = ?, attempts = ?, signed_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
        txHash,
        JSON.stringify([...row.hashes, txHash]),
        JSON.stringify(cancels),
        raw,
        fees.maxFeePerGas.toString(),
        fees.maxPriorityFeePerGas.toString(),
        row.attempts + 1,
        now,
        now,
        row.id
      );
      // The nonce, the chain id and the number of cancel signatures only.
      console.warn(
        `evm-relay: cancelled nonce ${row.nonce} on chain ${chainId} after its deadline, attempt ${cancels.length}.`
      );
      return raw;
    } catch {
      return row.raw;
    }
  }

  /**
   * Sign the same request at the same nonce with higher fees, and store it in one statement. Return the bytes to send:
   * the new bytes, or the old bytes when the signature or the write fails. `next_nonce` does not change.
   */
  private async replace(chainId: number, row: PendingRow, quote: FeeQuote): Promise<Hex> {
    try {
      const fees = replacementFees(row, quote);
      const raw = await this.deps.sign(transactionOf(chainId, requestOf(row.request), row.nonce, fees));
      const txHash = keccak256(raw);
      const attempts = row.attempts + 1;
      const now = this.deps.now();
      this.deps.sql.run(
        `UPDATE inflight SET tx_hash = ?, sent_hashes = ?, raw_tx = ?, max_fee = ?, max_priority_fee = ?, attempts = ?,
          signed_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`,
        txHash,
        JSON.stringify([...row.hashes, txHash]),
        raw,
        fees.maxFeePerGas.toString(),
        fees.maxPriorityFeePerGas.toString(),
        attempts,
        now,
        now,
        row.id
      );
      // The chain id, the nonce and the attempt count only.
      console.warn(`evm-relay: replaced the fee of nonce ${row.nonce} on chain ${chainId}, attempt ${attempts}.`);
      return raw;
    } catch {
      return row.raw;
    }
  }

  /** Broadcast signed bytes. A failure changes nothing: the next tick sends the stored bytes again. */
  private async send(chainId: number, id: Hex, raw: Hex): Promise<void> {
    let outcome: BroadcastOutcome;
    try {
      outcome = await this.deps.broadcast(chainId, raw);
    } catch {
      return;
    }
    switch (outcome) {
      case 'accepted':
        return;
      case 'nonce_used':
        // A mined transaction holds the nonce, so a new fee cannot help. A later tick reads its receipt.
        this.deps.sql.run("UPDATE inflight SET nonce_used = 1 WHERE id = ? AND state = 'pending'", id);
    }
  }

  /** Every pending row, lowest nonce first. */
  private pendingRows(): PendingRow[] {
    return this.deps.sql.run("SELECT * FROM inflight WHERE state = 'pending' ORDER BY nonce").map(pendingRowOf);
  }

  private hasPending(): boolean {
    return this.deps.sql.run("SELECT 1 AS one FROM inflight WHERE state = 'pending' LIMIT 1").length > 0;
  }

  /** Delete the final rows older than FINAL_ROW_TTL_MS. A pending row stays whatever its age. */
  private cleanup(): void {
    this.deps.sql.run(
      "DELETE FROM inflight WHERE state <> 'pending' AND updated_at < ?",
      this.deps.now() - FINAL_ROW_TTL_MS
    );
  }

  private meta(key: string): string | null {
    const [row] = this.deps.sql.run('SELECT value FROM meta WHERE key = ?', key);
    if (row === undefined) return null;
    if (typeof row.value !== 'string') throw new Error('The stored meta value is not text.');
    return row.value;
  }

  private setMeta(key: string, value: string): void {
    this.deps.sql.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }

  /** The first nonce after the last stored transaction, or 0. */
  private nextNonce(): number {
    const value = this.meta('next_nonce');
    return value === null ? 0 : Number(value);
  }

  /** The chain of the Sender, or null before its first relay. */
  private boundChain(): number | null {
    const value = this.meta('chain_id');
    return value === null ? null : Number(value);
  }

  /**
   * Store the address of the current relayer key and return it. When the key changed, drop `next_nonce`: it counts
   * the nonces of the old account, so the next nonce is the chain's pending count of the new account.
   */
  private bindRelayer(): Hex {
    const relayer = this.deps.relayer();
    if (this.meta('relayer') === relayer) return relayer;
    this.deps.sql.transaction(() => {
      this.deps.sql.run("DELETE FROM meta WHERE key = 'next_nonce'");
      this.setMeta('relayer', relayer);
    });
    return relayer;
  }

  /** The address of the current relayer key, or null when the key is not valid. */
  private currentRelayer(): Hex | null {
    try {
      return this.deps.relayer();
    } catch {
      return null;
    }
  }

  /** One Sender serves one chain. Refuse a job of another chain, so the nonce counter stays per chain. */
  private bindChain(chainId: number): void {
    const stored = this.meta('chain_id');
    if (stored === null) this.setMeta('chain_id', String(chainId));
    else if (stored !== String(chainId)) throw new Error('The Sender serves another chain.');
  }
}

/** The Senders of the Durable Object binding: one object per chain, named by the chain id. */
export function durableSenders(env: Env): SenderDirectory {
  return chainId => {
    const namespace = env.RELAY_SENDER;
    if (namespace === undefined) throw notConfigured();
    const stub = namespace.get(namespace.idFromName(String(chainId)));
    return { get: id => stub.get(id), submit: job => stub.submit(job) };
  };
}
