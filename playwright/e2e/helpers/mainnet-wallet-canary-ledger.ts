import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { isMainnetSwapCheckpoint, type MainnetSwapCheckpoint } from './mainnet-swap-checkpoint';

const SLOT_MS = 300_000;
const DAY_MS = 86_400_000;
const RETAINED_CALENDAR = 30 * DAY_MS;
const MAX_RESERVATION = 10n ** 18n;
const ACCOUNT = /^m[a-z]{1,4}1[a-z0-9]{1,150}(?:_[a-z0-9]{1,50})?$/;
const FAUCET = /^0x[0-9a-f]{30}$/;
const RUN_ID = /^[1-9]\d{0,19}$/;

export type CanaryStatus = 'missed' | 'blocked' | 'admitted' | 'unknown' | 'submitted' | 'usable_receipt' | 'cancelled';
export type CanaryBlockReason = 'quote_unavailable' | 'confirmed_not_submitted' | 'preflight_failed';
export type CanaryPreflightBlockReason = 'budget_exhausted' | 'quote_unavailable' | 'preflight_failed';
export type CanaryReason =
  | CanaryBlockReason
  | 'no_trigger'
  | 'busy_wallet'
  | 'budget_exhausted'
  | 'submission_unconfirmed';
export type CanaryObservation =
  | 'approval'
  | 'authorization_released'
  | 'submission'
  | 'inclusion'
  | 'partial_fill'
  | 'full_fill'
  | 'payback'
  | 'claim'
  | 'usable_receipt'
  | 'cancelled'
  | 'reclaimed'
  | 'timed_out';
const STATUSES: readonly CanaryStatus[] = [
  'missed',
  'blocked',
  'admitted',
  'unknown',
  'submitted',
  'usable_receipt',
  'cancelled'
];
const REASONS: readonly CanaryReason[] = [
  'quote_unavailable',
  'confirmed_not_submitted',
  'preflight_failed',
  'no_trigger',
  'busy_wallet',
  'budget_exhausted',
  'submission_unconfirmed'
];
const OBSERVATIONS: readonly CanaryObservation[] = [
  'approval',
  'authorization_released',
  'submission',
  'inclusion',
  'partial_fill',
  'full_fill',
  'payback',
  'claim',
  'usable_receipt',
  'cancelled',
  'reclaimed',
  'timed_out'
];

export interface CanaryLedgerOptions {
  directory: string;
  account: string;
  dailyFeeBaseUnits: bigint;
  dailyLossUsdMicros: bigint;
  maxPrincipalUsdMicros?: bigint;
  activationSlot?: string;
  initialize?: true;
  now?: () => number;
}

export interface CanaryAdmission {
  slotStart: string;
  runId: string;
  runAttempt: string;
  offerFaucetId: string;
  requestFaucetId: string;
  principalBaseUnits: bigint;
  principalUsdMicros: bigint;
  feeReserveBaseUnits: bigint;
  lossReserveUsdMicros: bigint;
}

export interface CanarySlot {
  readonly slotStart: string;
  readonly status: CanaryStatus;
  readonly reason?: CanaryReason;
  readonly runId?: string;
  readonly runAttempt?: string;
  readonly lineageId?: string;
  readonly offerFaucetId?: string;
  readonly requestFaucetId?: string;
  readonly principalBaseUnits?: bigint;
  readonly principalUsdMicros?: bigint;
  readonly feeReserveBaseUnits: bigint;
  readonly lossReserveUsdMicros: bigint;
  readonly admittedAt?: string;
  readonly submittedAt?: string;
  readonly usableReceiptAt?: string;
  readonly checkpoint?: MainnetSwapCheckpoint;
  readonly observed: Readonly<Partial<Record<CanaryObservation, string>>>;
}

export type CanaryAdmissionResult =
  | { kind: 'admitted' | 'busy_wallet' | 'budget_exhausted' | 'duplicate'; slot: CanarySlot }
  | { kind: 'elapsed_slot'; slot?: CanarySlot };

interface CanarySettlement {
  feeBaseUnits: bigint;
  lossUsdMicros: bigint;
  at?: number;
}

type Row = Record<string, SQLOutputValue>;

function wholeSeconds(millis: number): string {
  return new Date(Math.floor(millis / 1_000) * 1_000).toISOString().replace('.000Z', 'Z');
}

function floorSlot(now: number): number {
  return now - (now % SLOT_MS);
}

function slotTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0 || floorSlot(time) !== time || wholeSeconds(time) !== value)
    throw new Error('Require the exact five-minute UTC slot start');
  return time;
}

function bounded(value: bigint, minimum: bigint): boolean {
  return typeof value === 'bigint' && value >= minimum && value <= MAX_RESERVATION;
}

function text(value: SQLOutputValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid wallet canary text in ledger');
  return value;
}

function integer(value: SQLOutputValue | undefined): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'bigint') throw new Error('Invalid wallet canary integer in ledger');
  return value;
}

function timestamp(value: SQLOutputValue | undefined): string | undefined {
  const stored = integer(value);
  return stored === undefined ? undefined : wholeSeconds(Number(stored));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function assertPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Require operator-owned private wallet canary storage');
}

function openLedgerFile(options: CanaryLedgerOptions): string {
  if (!isAbsolute(options.directory)) throw new Error('Require a dedicated absolute wallet canary directory');
  if (options.initialize) mkdirSync(options.directory, { mode: 0o700, recursive: true });
  assertPrivate(options.directory, true);
  const file = join(options.directory, 'one-way-slots.sqlite');
  try {
    assertPrivate(file, false);
  } catch (error) {
    if (!isMissing(error) || !options.initialize) throw error;
    closeSync(openSync(file, 'wx', 0o600));
    assertPrivate(file, false);
  }
  return file;
}

/** The runner's OS lock spans browser work. Every individual ledger decision also commits atomically. */
export class MainnetWalletCanaryLedger {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly account: string;
  private readonly dailyFeeBaseUnits: bigint;
  private readonly dailyLossUsdMicros: bigint;
  private readonly maxPrincipalUsdMicros: bigint | null;
  private readonly activation: number;
  private readonly ownedSlots = new Set<number>();

  constructor(options: CanaryLedgerOptions) {
    const { account, dailyFeeBaseUnits, dailyLossUsdMicros, maxPrincipalUsdMicros } = options;
    if (
      !ACCOUNT.test(account) ||
      !bounded(dailyFeeBaseUnits, 1n) ||
      !bounded(dailyLossUsdMicros, 1n) ||
      (maxPrincipalUsdMicros !== undefined && !bounded(maxPrincipalUsdMicros, 1_000_001n))
    )
      throw new Error('Require a dedicated account and explicit wallet canary budget');
    this.account = account;
    this.dailyFeeBaseUnits = dailyFeeBaseUnits;
    this.dailyLossUsdMicros = dailyLossUsdMicros;
    this.maxPrincipalUsdMicros = maxPrincipalUsdMicros ?? null;
    this.clock = options.now ?? Date.now;
    const current = floorSlot(this.now());
    const activation = options.activationSlot === undefined ? undefined : slotTime(options.activationSlot);
    this.db = new DatabaseSync(openLedgerFile(options));
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = EXTRA');
      if (options.initialize) this.initialize(activation ?? current);
      const config = this.one('SELECT * FROM canary_config WHERE id = 1');
      if (
        !config ||
        config.account !== account ||
        config.daily_fee !== dailyFeeBaseUnits ||
        config.daily_loss !== dailyLossUsdMicros ||
        config.max_principal !== this.maxPrincipalUsdMicros ||
        typeof config.activation !== 'bigint' ||
        (activation !== undefined && config.activation !== BigInt(activation))
      )
        throw new Error('Ledger belongs to a different wallet canary account, calendar or budget');
      this.activation = Number(config.activation);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initialize(activation: number): void {
    this.atomic(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS canary_config (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          account TEXT NOT NULL,
          daily_fee INTEGER NOT NULL,
          daily_loss INTEGER NOT NULL,
          max_principal INTEGER,
          activation INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS canary_slots (
          start INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          reason TEXT,
          run_id TEXT,
          run_attempt TEXT,
          lineage TEXT UNIQUE,
          offered TEXT,
          requested TEXT,
          principal INTEGER,
          principal_usd INTEGER,
          fee_reserve INTEGER NOT NULL DEFAULT 0,
          loss_reserve INTEGER NOT NULL DEFAULT 0,
          charged_fee INTEGER NOT NULL DEFAULT 0,
          charged_loss INTEGER NOT NULL DEFAULT 0,
          admitted_at INTEGER,
          send_intent_at INTEGER,
          submitted_at INTEGER,
          usable_at INTEGER,
          resolved_at INTEGER,
          checkpoint TEXT,
          send_nonce TEXT UNIQUE,
          send_note_id TEXT UNIQUE,
          claim_nonce TEXT UNIQUE,
          claim_note_id TEXT UNIQUE,
          UNIQUE(run_id, run_attempt)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS canary_single_active
          ON canary_slots((1)) WHERE admitted_at IS NOT NULL AND resolved_at IS NULL;
        CREATE TABLE IF NOT EXISTS canary_observations (
          start INTEGER NOT NULL REFERENCES canary_slots(start),
          stage TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          PRIMARY KEY(start, stage)
        );
      `);
      this.db
        .prepare('INSERT OR IGNORE INTO canary_config VALUES (1, ?, ?, ?, ?, ?)')
        .run(this.account, this.dailyFeeBaseUnits, this.dailyLossUsdMicros, this.maxPrincipalUsdMicros, activation);
    });
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000)
      throw new Error('Invalid wallet canary clock');
    return value;
  }

  private atomic<T>(execute: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private one(sql: string, ...parameters: (number | string)[]): Row | undefined {
    const query = this.db.prepare(sql);
    query.setReadBigInts(true);
    return query.get(...parameters);
  }

  private decode(row: Row): CanarySlot {
    const start = integer(row.start);
    const status = STATUSES.find(candidate => candidate === row.status);
    const reason = REASONS.find(candidate => candidate === row.reason);
    const feeReserveBaseUnits = integer(row.fee_reserve);
    const lossReserveUsdMicros = integer(row.loss_reserve);
    if (
      start === undefined ||
      !status ||
      (row.reason !== null && !reason) ||
      feeReserveBaseUnits === undefined ||
      lossReserveUsdMicros === undefined
    )
      throw new Error('Invalid wallet canary slot in ledger');

    const checkpointText = text(row.checkpoint);
    const checkpoint: unknown = checkpointText === undefined ? undefined : JSON.parse(checkpointText);
    const observed: Partial<Record<CanaryObservation, string>> = {};
    const observations = this.db.prepare('SELECT stage, observed_at FROM canary_observations WHERE start = ?');
    observations.setReadBigInts(true);
    for (const stored of observations.all(start)) {
      const stage = OBSERVATIONS.find(candidate => candidate === stored.stage);
      const at = timestamp(stored.observed_at);
      if (!stage || !at) throw new Error('Invalid wallet canary observation in ledger');
      observed[stage] = at;
    }

    if (checkpoint !== undefined && !isMainnetSwapCheckpoint(checkpoint))
      throw new Error('Invalid private checkpoint in wallet canary ledger');
    const slot: CanarySlot = {
      slotStart: wholeSeconds(Number(start)),
      status,
      reason,
      runId: text(row.run_id),
      runAttempt: text(row.run_attempt),
      lineageId: text(row.lineage),
      offerFaucetId: text(row.offered),
      requestFaucetId: text(row.requested),
      principalBaseUnits: integer(row.principal),
      principalUsdMicros: integer(row.principal_usd),
      feeReserveBaseUnits,
      lossReserveUsdMicros,
      admittedAt: timestamp(row.admitted_at),
      submittedAt: timestamp(row.submitted_at),
      usableReceiptAt: timestamp(row.usable_at),
      checkpoint,
      observed
    };
    if (checkpoint) this.checkBinding(slot, checkpoint);
    return slot;
  }

  get(slotStart: string): CanarySlot | undefined {
    const row = this.one('SELECT * FROM canary_slots WHERE start = ?', slotTime(slotStart));
    return row && this.decode(row);
  }

  active(): CanarySlot | undefined {
    const row = this.one('SELECT * FROM canary_slots WHERE admitted_at IS NOT NULL AND resolved_at IS NULL');
    return row && this.decode(row);
  }

  slots(): CanarySlot[] {
    const query = this.db.prepare('SELECT * FROM canary_slots ORDER BY start');
    query.setReadBigInts(true);
    return query.all().map(row => this.decode(row));
  }

  private closeMissedSlots(current: number): void {
    const latest = this.one('SELECT max(start) AS latest FROM canary_slots')?.latest;
    const start = Math.max(
      this.activation,
      current - RETAINED_CALENDAR,
      typeof latest === 'bigint' ? Number(latest) + SLOT_MS : 0
    );
    const insert = this.db.prepare(
      "INSERT INTO canary_slots(start, status, reason) VALUES (?, 'missed', 'no_trigger')"
    );
    for (let slot = start; slot < current; slot += SLOT_MS) insert.run(slot);
  }

  advance(): void {
    this.atomic(() => this.closeMissedSlots(floorSlot(this.now())));
  }

  admit(request: CanaryAdmission): CanaryAdmissionResult {
    const start = slotTime(request.slotStart);
    const {
      runId,
      runAttempt,
      offerFaucetId,
      requestFaucetId,
      principalBaseUnits,
      principalUsdMicros,
      feeReserveBaseUnits,
      lossReserveUsdMicros
    } = request;
    if (
      !RUN_ID.test(runId) ||
      runAttempt !== '1' ||
      offerFaucetId === requestFaucetId ||
      ![offerFaucetId, requestFaucetId].every(asset => FAUCET.test(asset) || ACCOUNT.test(asset)) ||
      !bounded(principalBaseUnits, 1n) ||
      !bounded(principalUsdMicros, 1_000_001n) ||
      !bounded(feeReserveBaseUnits, 1n) ||
      !bounded(lossReserveUsdMicros, principalUsdMicros)
    )
      throw new Error('Invalid wallet canary direction, run, amount or reservation');

    const result = this.atomic<CanaryAdmissionResult>(() => {
      const now = this.now();
      const current = floorSlot(now);
      this.closeMissedSlots(current);
      if (start !== current || start < this.activation)
        return { kind: 'elapsed_slot', slot: this.get(request.slotStart) };

      const previous = this.one(
        'SELECT * FROM canary_slots WHERE start = ? OR (run_id = ? AND run_attempt = ?)',
        start,
        runId,
        runAttempt
      );
      if (previous) return { kind: 'duplicate', slot: this.decode(previous) };
      const later = this.one('SELECT 1 FROM canary_slots WHERE start > ? LIMIT 1', start);
      if (later) return { kind: 'elapsed_slot' };

      if (this.one('SELECT 1 FROM canary_slots WHERE admitted_at IS NOT NULL AND resolved_at IS NULL')) {
        return { kind: 'busy_wallet', slot: this.block(start, runId, runAttempt, 'busy_wallet') };
      }

      const day = now - (now % DAY_MS);
      // Charge realized costs to every UTC day the reserved operation occupied.
      const budget = this.one(
        `
        SELECT coalesce(sum(charged_fee), 0) AS fee, coalesce(sum(charged_loss), 0) AS loss
        FROM canary_slots WHERE admitted_at < ? AND coalesce(resolved_at, ?) >= ?
      `,
        day + DAY_MS,
        now,
        day
      );
      if (typeof budget?.fee !== 'bigint' || typeof budget.loss !== 'bigint')
        throw new Error('Wallet canary daily budget could not be checked');
      if (
        (this.maxPrincipalUsdMicros !== null && principalUsdMicros > this.maxPrincipalUsdMicros) ||
        budget.fee + feeReserveBaseUnits > this.dailyFeeBaseUnits ||
        budget.loss + lossReserveUsdMicros > this.dailyLossUsdMicros
      ) {
        return { kind: 'budget_exhausted', slot: this.block(start, runId, runAttempt, 'budget_exhausted') };
      }

      this.db
        .prepare(
          `
        INSERT INTO canary_slots (
          start, status, run_id, run_attempt, lineage, offered, requested, principal, principal_usd,
          fee_reserve, loss_reserve, charged_fee, charged_loss, admitted_at
        ) VALUES (?, 'admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          start,
          runId,
          runAttempt,
          randomBytes(16).toString('hex'),
          offerFaucetId,
          requestFaucetId,
          principalBaseUnits,
          principalUsdMicros,
          feeReserveBaseUnits,
          lossReserveUsdMicros,
          feeReserveBaseUnits,
          lossReserveUsdMicros,
          now
        );
      return { kind: 'admitted', slot: this.requireSlot(start) };
    });
    if (result.kind === 'admitted') this.ownedSlots.add(start);
    return result;
  }

  recordRunnerBusy(slotStart: string, runId: string, runAttempt: string): CanarySlot | undefined {
    return this.recordCurrentBlock(slotStart, runId, runAttempt);
  }

  recordPreflightBlock(request: {
    slotStart: string;
    runId: string;
    runAttempt: string;
    reason: CanaryPreflightBlockReason;
  }): CanarySlot | undefined {
    const { slotStart, runId, runAttempt, reason } = request;
    if (reason !== 'budget_exhausted' && reason !== 'quote_unavailable' && reason !== 'preflight_failed')
      throw new Error('Invalid wallet canary preflight reason');
    return this.recordCurrentBlock(slotStart, runId, runAttempt, reason);
  }

  private recordCurrentBlock(
    slotStart: string,
    runId: string,
    runAttempt: string,
    preflightReason?: CanaryPreflightBlockReason
  ): CanarySlot | undefined {
    const start = slotTime(slotStart);
    if (!RUN_ID.test(runId) || runAttempt !== '1') throw new Error('Invalid wallet canary run identity');
    return this.atomic(() => {
      const current = floorSlot(this.now());
      if (
        start !== current ||
        start < this.activation ||
        this.one(
          'SELECT 1 FROM canary_slots WHERE start >= ? OR (run_id = ? AND run_attempt = ?)',
          start,
          runId,
          runAttempt
        )
      )
        return undefined;
      // A lock alone might belong to the same slot before it reaches the ledger.
      const earlier = this.one('SELECT 1 FROM canary_slots WHERE admitted_at IS NOT NULL AND resolved_at IS NULL');
      const reason = earlier ? 'busy_wallet' : preflightReason;
      if (!reason) return undefined;
      this.closeMissedSlots(current);
      return this.block(start, runId, runAttempt, reason);
    });
  }

  private block(
    start: number,
    runId: string,
    attempt: string,
    reason: 'busy_wallet' | CanaryPreflightBlockReason
  ): CanarySlot {
    this.db
      .prepare(
        "INSERT INTO canary_slots(start, status, reason, run_id, run_attempt, lineage) VALUES (?, 'blocked', ?, ?, ?, ?)"
      )
      .run(start, reason, runId, attempt, randomBytes(16).toString('hex'));
    return this.requireSlot(start);
  }

  private requireSlot(start: number): CanarySlot {
    const row = this.one('SELECT * FROM canary_slots WHERE start = ?', start);
    if (!row) throw new Error('Wallet canary slot does not exist');
    return this.decode(row);
  }

  private checkBinding(slot: CanarySlot, state: MainnetSwapCheckpoint): void {
    const principalUsdMicros =
      (BigInt(state.principal) * BigInt(state.offer.usdMicros)) / 10n ** BigInt(state.offer.decimals);
    if (
      state.account !== this.account ||
      state.sourceRunId !== slot.runId ||
      state.authorizationRunId !== slot.runId ||
      (state.offer.hex !== slot.offerFaucetId && state.offer.faucetId !== slot.offerFaucetId) ||
      (state.request.hex !== slot.requestFaucetId && state.request.faucetId !== slot.requestFaucetId) ||
      BigInt(state.principal) !== slot.principalBaseUnits ||
      principalUsdMicros !== slot.principalUsdMicros ||
      BigInt(state.feeBudget) > slot.feeReserveBaseUnits ||
      !state.lossBudgetUsdMicros ||
      BigInt(state.lossBudgetUsdMicros) > slot.lossReserveUsdMicros ||
      state.reverseRequestAuthority !== undefined ||
      state.reverseOrderId !== undefined ||
      state.reverseClaimAuthority !== undefined ||
      state.recoveryReturnAuthorizedAt !== undefined ||
      state.returnAmount !== undefined ||
      state.returnBaseline !== undefined ||
      state.phase === 'reverse-authorized' ||
      state.phase === 'complete'
    )
      throw new Error('Checkpoint does not match the original one-way slot authority');
  }

  private checkCheckpoint(slot: CanarySlot, state: MainnetSwapCheckpoint, arming: boolean): void {
    if (!isMainnetSwapCheckpoint(state)) throw new Error('Invalid private wallet canary checkpoint');
    this.checkBinding(slot, state);
    const old = slot.checkpoint;
    if (!arming && !isDeepStrictEqual(old?.forwardRequestAuthority, state.forwardRequestAuthority))
      throw new Error('Do not change the original forward send authority');
    if (old?.forwardClaimAuthority && !isDeepStrictEqual(old.forwardClaimAuthority, state.forwardClaimAuthority))
      throw new Error('Do not replace the original forward claim authority');
    if (
      old &&
      (!isDeepStrictEqual(
        [old.offer, old.request, old.native, old.knownOrderIds],
        [state.offer, state.request, state.native, state.knownOrderIds]
      ) ||
        old.createdAt !== state.createdAt ||
        old.pricedAt !== state.pricedAt ||
        old.forwardMinimum !== state.forwardMinimum ||
        old.reverseMinimum !== state.reverseMinimum ||
        old.feeBudget !== state.feeBudget ||
        old.lossBudgetUsdMicros !== state.lossBudgetUsdMicros ||
        old.baseFee !== state.baseFee ||
        Date.parse(state.updatedAt) < Date.parse(old.updatedAt))
    )
      throw new Error('Do not change the original wallet canary quote or budget');
  }

  saveCheckpoint(slotStart: string, state: MainnetSwapCheckpoint): void {
    const start = slotTime(slotStart);
    this.atomic(() => {
      const slot = this.requireSlot(start);
      if (
        (!slot.checkpoint && !this.ownedSlots.has(start)) ||
        !['admitted', 'unknown', 'submitted'].includes(slot.status)
      )
        throw new Error('Cannot change the checkpoint for this wallet canary slot');
      this.checkCheckpoint(slot, state, false);
      const claim = state.forwardClaimAuthority;
      this.db
        .prepare('UPDATE canary_slots SET checkpoint = ?, claim_nonce = ?, claim_note_id = ? WHERE start = ?')
        .run(JSON.stringify(state), claim?.nonce ?? null, claim?.noteId ?? null, start);
    });
  }

  armSend(slotStart: string, state: MainnetSwapCheckpoint): void {
    const start = slotTime(slotStart);
    this.atomic(() => {
      const now = this.now();
      const slot = this.requireSlot(start);
      if (
        !this.ownedSlots.has(start) ||
        floorSlot(now) !== start ||
        slot.status !== 'admitted' ||
        !slot.checkpoint ||
        state.phase !== 'forward-authorized' ||
        !state.forwardRequestAuthority ||
        state.forwardClaimAuthority !== undefined ||
        state.forwardRequestAuthority.expiresAt <= now ||
        state.forwardRequestAuthority.expiresAt > start + SLOT_MS
      )
        throw new Error('No unused authority in this wallet canary slot');
      this.checkCheckpoint(slot, state, true);
      const authority = state.forwardRequestAuthority;
      this.db
        .prepare(
          `
        UPDATE canary_slots SET checkpoint = ?, send_nonce = ?, send_note_id = ?,
        send_intent_at = ?, status = 'unknown', reason = 'submission_unconfirmed' WHERE start = ?
      `
        )
        .run(JSON.stringify(state), authority.nonce, authority.noteId, now, start);
    });
    this.ownedSlots.delete(start);
  }

  abortBeforeSend(slotStart: string, reason: CanaryBlockReason): void {
    const start = slotTime(slotStart);
    if (reason !== 'quote_unavailable' && reason !== 'confirmed_not_submitted' && reason !== 'preflight_failed')
      throw new Error('Invalid wallet canary pre-send reason');
    this.atomic(() => {
      const result = this.db
        .prepare(
          `
        UPDATE canary_slots SET status = 'blocked', reason = ?, charged_fee = 0, charged_loss = 0, resolved_at = ?
        WHERE start = ? AND status = 'admitted' AND send_intent_at IS NULL AND admitted_at <= ?
      `
        )
        .run(reason, this.now(), start, this.now());
      if (result.changes !== 1) throw new Error('Durable wallet canary send intent requires reconciliation');
    });
    this.ownedSlots.delete(start);
  }

  private assertObservedAt(start: number, at: number, requiresSend: boolean): Row {
    const row = this.one('SELECT * FROM canary_slots WHERE start = ?', start);
    const earliest = requiresSend ? row?.send_intent_at : row?.admitted_at;
    if (
      !row ||
      typeof earliest !== 'bigint' ||
      !Number.isSafeInteger(at) ||
      at < Number(earliest) ||
      at > this.now() ||
      row.resolved_at !== null
    )
      throw new Error('Observation does not match an open wallet canary authority');
    return row;
  }

  private observe(start: number, stage: CanaryObservation, at: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO canary_observations(start, stage, observed_at) VALUES (?, ?, ?)')
      .run(start, stage, at);
  }

  recordObservation(slotStart: string, stage: CanaryObservation, at = this.now()): void {
    if (stage === 'submission') return this.recordSubmission(slotStart, at);
    if (!OBSERVATIONS.includes(stage) || ['usable_receipt', 'cancelled', 'reclaimed'].includes(stage))
      throw new Error('Use verified reconciliation to record a terminal wallet canary outcome');
    const start = slotTime(slotStart);
    this.atomic(() => {
      this.assertObservedAt(start, at, stage !== 'approval');
      this.observe(start, stage, at);
    });
  }

  recordSubmission(slotStart: string, at = this.now()): void {
    const start = slotTime(slotStart);
    this.atomic(() => {
      const slot = this.assertObservedAt(start, at, true);
      if (slot.submitted_at !== null) return;
      this.db
        .prepare("UPDATE canary_slots SET submitted_at = ?, status = 'submitted', reason = NULL WHERE start = ?")
        .run(at, start);
      this.observe(start, 'submission', at);
    });
  }

  finishReceipt(slotStart: string, result: CanarySettlement): void {
    this.finish(slotStart, 'usable_receipt', result);
  }

  finishCancellation(
    slotStart: string,
    result: CanarySettlement,
    evidence: 'cancelled' | 'reclaimed' = 'cancelled'
  ): void {
    this.finish(slotStart, 'cancelled', result, evidence);
  }

  private finish(
    slotStart: string,
    status: 'usable_receipt' | 'cancelled',
    result: CanarySettlement,
    observation: 'usable_receipt' | 'cancelled' | 'reclaimed' = status
  ): void {
    const start = slotTime(slotStart);
    const at = result.at ?? this.now();
    this.atomic(() => {
      const row = this.assertObservedAt(start, at, true);
      if (
        typeof row.submitted_at !== 'bigint' ||
        at < Number(row.submitted_at) ||
        !bounded(result.feeBaseUnits, 0n) ||
        !bounded(result.lossUsdMicros, 0n) ||
        typeof row.fee_reserve !== 'bigint' ||
        typeof row.loss_reserve !== 'bigint' ||
        result.feeBaseUnits > row.fee_reserve ||
        result.lossUsdMicros > row.loss_reserve
      )
        throw new Error('Verified wallet canary settlement exceeds its original reservation or lacks submission');
      if (status === 'usable_receipt') {
        const slot = this.decode(row);
        if (
          !slot.checkpoint?.forwardClaimAuthority ||
          !slot.observed.payback ||
          !slot.observed.claim ||
          at < Date.parse(slot.observed.payback) ||
          at < Date.parse(slot.observed.claim)
        )
          throw new Error('Usable wallet canary receipt needs the exact observed payback and claim');
      }
      this.db
        .prepare(
          `
        UPDATE canary_slots SET status = ?, resolved_at = ?, charged_fee = ?, charged_loss = ?, usable_at = ?
        WHERE start = ?
      `
        )
        .run(status, at, result.feeBaseUnits, result.lossUsdMicros, status === 'usable_receipt' ? at : null, start);
      this.observe(start, observation, at);
    });
  }

  close(): void {
    this.db.close();
  }
}
