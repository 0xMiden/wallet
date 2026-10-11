import type { Hex } from 'viem';

import type { JsonValue } from './history';

const ARC_PRIVATE_KEY = /^(0x)?[0-9a-f]{64}$/i;
const POSITIVE_UNITS = /^[1-9]\d*$/;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The message of any thrown value. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Throws unless `yarn e2e:real` started this run for a usdcx suite on testnet. The suites throw instead of skipping, so
 * a run that lacks its inputs never reports green. Messages name variables, never their values.
 */
export function assertUsdcxLiveRun(env: NodeJS.ProcessEnv, opts: { needsArcKey: boolean }): void {
  if (env.E2E_REAL_USDCX !== 'true') {
    throw new Error(
      'the USDCx live suites run only through `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` ' +
        '(E2E_REAL_USDCX is not "true")'
    );
  }
  if (env.E2E_NETWORK !== 'testnet') {
    throw new Error(`the USDCx live suites run only on testnet, but E2E_NETWORK is ${env.E2E_NETWORK ?? 'unset'}`);
  }
  if (opts.needsArcKey && !env.E2E_ARC_PRIVATE_KEY) {
    throw new Error('usdcx-in needs a funded Arc key: pass --arc-key to yarn e2e:real or export E2E_ARC_PRIVATE_KEY');
  }
}

/** The funded Arc key as `0x` and 64 lowercase hex digits. */
export function arcPrivateKeyFromEnv(env: NodeJS.ProcessEnv): Hex {
  const raw = (env.E2E_ARC_PRIVATE_KEY ?? '').trim();
  if (!ARC_PRIVATE_KEY.test(raw)) throw new Error('E2E_ARC_PRIVATE_KEY is not a 32-byte hex private key');
  return `0x${raw.replace(/^0x/i, '').toLowerCase()}`;
}

/** Extra text for a failed step: a Guardian re-read, the page's route. */
export type StepContext = () => Promise<string>;

/**
 * Runs one step under its budget. A failure and an overrun both reject with a message that starts with the step's
 * name; `context` is appended best-effort.
 */
export async function withStepBudget<T>(
  name: string,
  budgetMs: number,
  run: () => Promise<T>,
  context?: StepContext
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`exceeded its ${budgetMs} ms budget`)), budgetMs);
  });
  const work = run();
  // The losing side of the race keeps running, and a Playwright worker fails the test on its unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, overrun]);
  } catch (error) {
    const detail = context
      ? await context().then(
          text => (text ? `\n${text}` : ''),
          (failure: unknown) => `\n(context unavailable: ${errorText(failure)})`
        )
      : '';
    throw new Error(`${name}: ${errorText(error)}${detail}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** What `TestStepRunner` offers: a named checkpoint around one step. */
export interface StepRecorder {
  step(name: string, fn: () => Promise<void>): Promise<void>;
}

export type NamedStep = <T>(name: string, budgetMs: number, run: () => Promise<T>, context?: StepContext) => Promise<T>;

/** Each step is a checkpoint in the run's report, runs under its own budget, and hands its result back. */
export function namedSteps(recorder: StepRecorder): NamedStep {
  return <T>(name: string, budgetMs: number, run: () => Promise<T>, context?: StepContext) =>
    new Promise<T>((resolve, reject) => {
      recorder
        .step(name, async () => {
          resolve(await withStepBudget(name, budgetMs, run, context));
        })
        .catch(reject);
    });
}

export interface PhaseSample {
  phase: string;
  atMs: number;
}

/** The phases one row was seen in, in order, for the monotonicity checks and the evidence. */
export class PhaseTimeline {
  private readonly seen: PhaseSample[] = [];

  constructor(
    readonly label: string,
    private readonly order: readonly string[]
  ) {}

  record(phase: string | undefined, atMs: number): void {
    if (phase === undefined || this.last() === phase) return;
    this.seen.push({ phase, atMs });
  }

  samples(): PhaseSample[] {
    return [...this.seen];
  }

  last(): string | undefined {
    return this.seen[this.seen.length - 1]?.phase;
  }

  firstAt(phase: string): number | undefined {
    return this.seen.find(sample => sample.phase === phase)?.atMs;
  }

  saw(phase: string): boolean {
    return this.firstAt(phase) !== undefined;
  }

  describe(): string {
    if (this.seen.length === 0) return 'no samples';
    return this.seen.map(sample => `${sample.phase}@${new Date(sample.atMs).toISOString()}`).join(' -> ');
  }

  /** Throws when a phase falls outside `order` or follows a later one. */
  assertMonotone(): void {
    let rank = -1;
    for (const sample of this.seen) {
      const next = this.order.indexOf(sample.phase);
      if (next === -1 || next < rank) {
        throw new Error(
          `${this.label}: phase "${sample.phase}" breaks the order ${this.order.join(' -> ')} (${this.describe()})`
        );
      }
      rank = next;
    }
  }
}

export interface BackgroundSampler {
  /** Ends the loop after the tick in flight, and rejects with the failure that ended it early, if one did. */
  stop(): Promise<void>;
}

/**
 * Runs `tick` every `intervalMs` until it returns true or `stop` is called. One failed tick (a service worker
 * restarting) is ridden out; three in a row end the loop with the last failure.
 */
export function sampleInBackground(
  tick: () => Promise<boolean>,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep
): BackgroundSampler {
  const state: { stopped: boolean; failure?: unknown } = { stopped: false };
  const loop = (async () => {
    let failures = 0;
    while (!state.stopped) {
      try {
        if (await tick()) return;
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= 3) {
          state.failure = error;
          return;
        }
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      state.stopped = true;
      await loop;
      if (state.failure !== undefined) throw state.failure;
    }
  };
}

function show(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
  if (text === undefined) return 'nothing';
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

export interface PollOptions<T> {
  timeoutMs: number;
  intervalMs: number;
  /** Extra text for the timeout message: the page's route, an oracle verdict. */
  describe?: (last: T | undefined) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Re-reads until `done`, or throws naming `label`, the last read and `describe`'s text. A failed read fails at once. */
export async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: PollOptions<T>
): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;
  let last: { value: T } | undefined;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    last = { value };
    if (now() >= deadline) break;
    await sleep(Math.min(opts.intervalMs, deadline - now()));
  }
  const detail = opts.describe
    ? await opts.describe(last.value).then(
        text => `; ${text}`,
        (failure: unknown) => `; (no detail: ${errorText(failure)})`
      )
    : '';
  throw new Error(`${label}: not reached within ${opts.timeoutMs} ms; last read ${show(last.value)}${detail}`);
}

/**
 * Waits for a balance to leave `from` and then read the same twice in a row: the vault after a landed path, which
 * records no fee to say what the vault should become.
 */
export async function readSettledChange(
  read: () => Promise<bigint>,
  from: bigint,
  opts: Omit<PollOptions<bigint[]>, 'describe'>
): Promise<bigint> {
  const reads: bigint[] = [];
  const [, settled] = await pollUntil(
    `balance to move from ${from} and hold`,
    async () => {
      reads.push(await read());
      return reads.slice(-2);
    },
    ([previous, latest]) => latest !== undefined && latest !== from && latest === previous,
    opts
  );
  if (settled === undefined) throw new Error(`balance to move from ${from}: no second read`);
  return settled;
}

/** One fee term of a ledger: read off the row that paid it, or bounded from the vault on a landed path (Q5(d)). */
export interface FeeTerm {
  name: string;
  amount: bigint;
  kind: 'exact' | 'bounded';
  /** `baseFee x FEE_RESERVE_MULTIPLE`, which a bounded fee was checked against. */
  ceiling?: bigint;
}

export function boundedTerm(name: string, bound: { fee: bigint; ceiling: bigint }): FeeTerm {
  return { name, amount: bound.fee, kind: 'bounded', ceiling: bound.ceiling };
}

export type ConsumeFeePath = { kind: 'result'; fee: bigint } | { kind: 'landed' };

/**
 * How a Completed consume finished. One that kept its result recorded its fee at completion; one that completed
 * through a landed path recorded no fee and never released a result. The row snapshot carries no `resultBytes`, so
 * the recorded fee is the signal.
 */
export function consumeFeePath(row: { id: string; feeAmount?: string; resultReleasedAt?: number }): ConsumeFeePath {
  if (row.feeAmount !== undefined) {
    if (!POSITIVE_UNITS.test(row.feeAmount)) {
      throw new Error(`consume ${row.id} recorded fee ${row.feeAmount}, not a positive base-unit amount`);
    }
    return { kind: 'result', fee: BigInt(row.feeAmount) };
  }
  if (row.resultReleasedAt !== undefined) {
    throw new Error(`consume ${row.id} released its result at ${isoSeconds(row.resultReleasedAt)} but recorded no fee`);
  }
  return { kind: 'landed' };
}

export type BurnCompletionPath = { kind: 'result'; resultBytes: string } | { kind: 'landed' };

/** A Completed burn decodes its outputs from `resultBytes`, which the reaper releases 10 min after `completedAt`. */
export function burnCompletionPath(row: { resultBytes?: string; resultReleasedAt?: number }): BurnCompletionPath {
  if (row.resultBytes) return { kind: 'result', resultBytes: row.resultBytes };
  if (row.resultReleasedAt !== undefined) {
    throw new Error(
      `resultBytes released at ${isoSeconds(row.resultReleasedAt)}, 10 min after completedAt; outputs not decoded`
    );
  }
  return { kind: 'landed' };
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

/** The one item, or a throw naming how many there were. */
export function exactlyOne<T>(items: readonly T[], what: string, describe: (item: T) => string): T {
  const [only] = items;
  if (items.length !== 1 || only === undefined) {
    const listed = items.length > 0 ? `: ${items.map(describe).join('; ')}` : '';
    throw new Error(`expected exactly one ${what}, found ${items.length}${listed}`);
  }
  return only;
}

export function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** What a run attaches as its evidence JSON. Never a private key. */
export interface RunEvidence {
  suite: string;
  guardian?: { url: string; version: string; gitCommit: string; commitment: string };
  ids: Record<string, string>;
  hashes: Record<string, string>;
  fees: FeeTerm[];
  latenciesMs: Record<string, number>;
  phases: Record<string, PhaseSample[]>;
  settleMs: Record<string, number>;
  notes: string[];
}

export function newRunEvidence(suite: string): RunEvidence {
  return { suite, ids: {}, hashes: {}, fees: [], latenciesMs: {}, phases: {}, settleMs: {}, notes: [] };
}

/** The evidence as JSON with bigints as decimal strings; throws instead when any secret appears in it. */
export function evidenceJson(evidence: RunEvidence, secrets: readonly string[]): string {
  const text = JSON.stringify(
    evidence,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2
  );
  const haystack = text.toLowerCase();
  const leaked = secrets.some(secret => {
    const digits = secret.toLowerCase().replace(/^0x/, '');
    return digits.length > 0 && haystack.includes(digits);
  });
  if (leaked) throw new Error('the evidence would contain a private key, so it was not written');
  return text;
}

/** `waitForGuardianSettled` finding no push means tracking started after the transaction, not a slow Guardian. */
export function explainSettleFailure(error: unknown): Error {
  const message = errorText(error);
  if (message.includes('no delta push was observed')) {
    return new Error(`tracking started late: ${message}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(message);
}

/** Where the page is, for phase timeouts: the wallet's watcher polls only while a wallet route is visible. */
export async function describePage(url: string, visibility: () => Promise<string>): Promise<string> {
  const route = new URL(url).hash || '(no route)';
  const state = await visibility().catch((error: unknown) => `unreadable (${errorText(error)})`);
  return `page route ${route}, visibility ${state}`;
}

export function ledgerLine(terms: ReadonlyArray<readonly [string, bigint]>): string {
  return terms.map(([name, amount]) => `${name}=${amount}`).join(' ');
}

/** Matches exactly one of `texts`, as a pill reads it. */
export function anyOf(texts: readonly string[]): RegExp {
  const alternatives = texts.map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^\\s*(?:${alternatives})\\s*$`);
}
