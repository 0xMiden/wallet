// The Sender: it chooses the relayer nonce, signs the relay transaction, stores it and only then broadcasts it. One
// Sender serves one chain. The Durable Object in sender-object.ts wraps this class; the tests give its dependencies.
import { keccak256, type TransactionSerializableEIP1559, type TransactionSerializableEIP7702 } from 'viem';

import type { RelayAuthorization } from './chain';
import { notConfigured } from './errors';
import type { Hex } from './parse';
import type { Env } from './types';

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
  /** Sign with the relayer key. Return the signed transaction bytes. */
  sign(transaction: RelayTransaction): Promise<Hex>;
  /** Send signed bytes to the chain. A failure only delays the relay: a later step sends the stored bytes again. */
  broadcast(chainId: number, raw: Hex): Promise<void>;
  now(): number;
}

export type RelayJobState = 'pending' | 'succeeded' | 'reverted';

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
  /** The calldata of `execute` on the address. */
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
  `CREATE TABLE IF NOT EXISTS inflight (
    id TEXT PRIMARY KEY,
    evm_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    raw_tx TEXT,
    request TEXT NOT NULL,
    nonce INTEGER NOT NULL,
    max_fee TEXT NOT NULL,
    max_priority_fee TEXT NOT NULL,
    deadline INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'reverted')),
    attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS inflight_open_address ON inflight (evm_address) WHERE state = 'pending'",
  "CREATE UNIQUE INDEX IF NOT EXISTS inflight_pending_nonce ON inflight (nonce) WHERE state = 'pending'"
];

function stateOf(value: unknown): RelayJobState {
  switch (value) {
    case 'pending':
    case 'succeeded':
    case 'reverted':
      return value;
    default:
      throw new Error('The stored relay has an unknown state.');
  }
}

function hexOf(value: unknown): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) throw new Error('The stored relay has a bad value.');
  return `0x${value.slice(2)}`;
}

function transactionOf(job: SubmitJob, nonce: number): RelayTransaction {
  const fields = {
    chainId: job.chainId,
    nonce,
    to: job.evmAddress,
    data: job.data,
    value: 0n,
    gas: job.gas,
    maxFeePerGas: job.maxFeePerGas,
    maxPriorityFeePerGas: job.maxPriorityFeePerGas
  };
  if (job.authorization === null) return { ...fields, type: 'eip1559' };
  return { ...fields, type: 'eip7702', authorizationList: [job.authorization] };
}

/** What one submit decided inside the exclusive section. `raw` is set only when it stored a new transaction. */
interface Stored {
  outcome: SubmitOutcome;
  raw: Hex | null;
}

export class RelaySender {
  /** The tail of the submit queue. Each submit runs its exclusive section after the one before it settles. */
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
    const { outcome, raw } = await this.exclusive(() => this.store(job));
    if (raw !== null) {
      try {
        await this.deps.broadcast(job.chainId, raw);
      } catch {
        // The row stays pending with its signed bytes. A later step sends them again.
      }
    }
    return outcome;
  }

  /**
   * Run the task after every task before it settles. Only `submit` calls it, so two submits never overlap between
   * the choice of the nonce and the commit of the row, even when the signer yields to the event loop.
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
    const known = this.get(job.id);
    if (known !== null) return { outcome: { status: 'job', job: known }, raw: null };
    const [open] = this.deps.sql.run(
      "SELECT id FROM inflight WHERE evm_address = ? AND state = 'pending'",
      job.evmAddress
    );
    if (open !== undefined) return { outcome: { status: 'busy', id: hexOf(open.id) }, raw: null };
    this.bindChain(job.chainId);

    const nonce = Math.max(job.chainNonce, this.nextNonce());
    const raw = await this.deps.sign(transactionOf(job, nonce));
    const txHash = keccak256(raw);
    const now = this.deps.now();
    const request = JSON.stringify({
      to: job.evmAddress,
      data: job.data,
      gas: job.gas.toString(),
      authorization: job.authorization
    });
    // The row and the next nonce commit together, so no nonce is reserved without its signed transaction.
    this.deps.sql.transaction(() => {
      this.deps.sql.run(
        `INSERT INTO inflight (id, evm_address, tx_hash, raw_tx, request, nonce, max_fee, max_priority_fee, deadline,
          state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
        job.id,
        job.evmAddress,
        txHash,
        raw,
        request,
        nonce,
        job.maxFeePerGas.toString(),
        job.maxPriorityFeePerGas.toString(),
        job.deadline,
        now,
        now
      );
      this.setMeta('next_nonce', String(nonce + 1));
    });
    return { outcome: { status: 'job', job: { id: job.id, state: 'pending', txHash } }, raw };
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
