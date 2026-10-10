import fs from 'node:fs';
import path from 'node:path';

import type { KnownBugRegistry } from './dapp-known-bugs';

/**
 * Runs each matrix capability as a named cell. A cell that fails neither hides nor poisons the cells after it:
 * the runner establishes the state a cell needs, bounds it with a deadline, restores in `finally`, and writes
 * the cell's record the moment it finishes. The job verdict comes from those records (scripts/render-dapp-matrix.mjs).
 */

export type AxisLabel = 'offchain' | 'guardian';
export type JourneyId = 'S' | 'R' | 'W' | 'X' | 'XL' | 'M';
/**
 * A cell's outcome (spec section 5). `fail-known` means every failure matched a signature registered for this cell
 * and axis; `known-now-passing` means such a cell ran clean, which fails the judge until the entry is removed. A
 * `blocked-*` cell never ran its body: a cell it needs did not pass, the wallet state could not be restored, or an
 * infrastructure fault aborted the run.
 */
export type CellVerdict =
  | 'pass'
  | 'fail-new'
  | 'fail-known'
  | 'known-now-passing'
  | 'harness-fault'
  | 'blocked-needs'
  | 'blocked-state'
  | 'blocked-infra'
  | 'not-run';

/** The error a dApp call rejected with, as the page reports it: the provider's error class and text, and its cause. */
export interface DappError {
  name: string;
  message: string;
  causeName?: string;
  causeMessage?: string;
}

/** What a cell saw, recorded before it asserts, so a known-bug signature can match the failure. */
export interface FailureEvidence {
  stage?: string;
  rowStatus?: number;
  rowError?: string;
  dappError?: DappError;
  popupOpened?: boolean;
  previewSimulationFailed?: boolean;
  providerAddress?: string | null;
  adapterAddress?: string | null;
  previousAddress?: string | null;
  staleConsumeExecuted?: boolean;
  /** A request made as a session's account while another account was current opened a popup (Q10, K9). */
  nonCurrentPrompted?: boolean;
  /** Such a read was served a vault other than the session account's own: a leak, never K9. */
  nonCurrentReadLeaked?: boolean;
  crossOriginWaitServed?: boolean;
  /** N4 listed every imported note by its own note id, then missed one asked by the id its import returned (K10). */
  returnedIdUnlisted?: boolean;
}

/** A check that failed without stopping the cell, so one run can record a soft and a hard known bug (K4 and K3). */
export interface SoftFailure {
  check: string;
  detail: string;
}

/** One cell's entry in `<outDir>/<part>-<axis>-<journey>.json`; `needs` names the prerequisite that blocked it. */
export interface CellRecord {
  id: string;
  verdict: CellVerdict;
  knownBugs: string[];
  staleKnownBugs: string[];
  needs?: string;
  error?: string;
  stage?: string;
  durationMs: number;
  finishedAt: string;
}

export interface JourneyRecord {
  part: string;
  axis: AxisLabel;
  journey: JourneyId;
  testTitle: string;
  cells: CellRecord[];
}

/** The harness itself broke (a page script threw, a cell was never declared): never a wallet verdict or a known bug. */
export class HarnessFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessFault';
  }
}
/** A wait outlived the cell's budget. Judged like any failure, so it is new unless a signature explains it. */
export class CellDeadlineExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CellDeadlineExceeded';
  }
}
/**
 * A faucet or hosted service failed, not the wallet. The runner writes INFRA_ABORT for it, which blocks every later
 * cell of every journey that shares the records directory.
 */
export class InfrastructureFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfrastructureFault';
  }
}

/**
 * A fixed end time for one cell or one quiesce. Every wait in a cell goes through `race`, so a stalled cell fails
 * under its own id before the Playwright test timeout, which would leave every later cell `not-run`.
 */
export interface Deadline {
  readonly label: string;
  remainingMs(): number;
  race<T>(work: Promise<T>, what: string): Promise<T>;
}

export function deadlineIn(ms: number, label: string, now: () => number = Date.now): Deadline {
  const endsAt = now() + ms;
  return {
    label,
    remainingMs: () => Math.max(0, endsAt - now()),
    race: <T>(work: Promise<T>, what: string) =>
      new Promise<T>((resolve, reject) => {
        // The abandoned promise keeps running in the page; the cell's restore cleans up after it.
        const timer = setTimeout(
          () => reject(new CellDeadlineExceeded(`${label}: ${what} outlived the cell budget`)),
          Math.max(0, endsAt - now())
        );
        work.then(
          value => {
            clearTimeout(timer);
            resolve(value);
          },
          error => {
            clearTimeout(timer);
            reject(error);
          }
        );
      })
  };
}

/** Initial values from the spec (section 5); task 4 re-sizes them from the spike's measured unit costs. */
export const CELL_BUDGET_MS = { read: 60_000, write: 180_000, long: 480_000 };
/** Quiesce has its own budget (a recipient claim or a Guardian settle can take minutes) so it never starves the cell. */
export const QUIESCE_BUDGET_MS = 180_000;

export interface CellContext {
  readonly deadline: Deadline;
  readonly evidence: FailureEvidence;
  /** Records a failed check and lets the cell go on; `patch` adds the evidence a soft signature reads. */
  softFail(check: string, detail: string, patch?: Partial<FailureEvidence>): void;
}

export interface CellSpec<S> {
  readonly id: string;
  readonly budget: keyof typeof CELL_BUDGET_MS;
  /** Cells of the same journey that must have passed first; otherwise this one records `blocked-needs`. */
  readonly needs?: readonly string[];
  /** The wallet state the quiesce hook establishes before the cell runs. */
  readonly state?: S;
  run(ctx: CellContext): Promise<void>;
}

/**
 * `quiesce` establishes and checks the state a cell expects (spec section 5) and throws when it cannot; `restore`
 * runs after every cell, whatever happened. Either failing blocks every later cell: `blocked-infra` for an
 * InfrastructureFault in the quiesce, `blocked-state` otherwise.
 */
export interface RunnerHooks<S> {
  quiesce(cell: CellSpec<S>, deadline: Deadline): Promise<void>;
  restore(cell: CellSpec<S>): Promise<void>;
}

/** The failure as record text, capped so one huge message cannot bloat the record file. */
export function describeFailure(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

/**
 * Whether a failure is the environment's rather than the wallet's: an InfrastructureFault, or a failure that names the
 * public faucet, itself or anywhere down its cause chain. Every public-faucet helper rejects with a message that begins
 * "Public faucet" (`PublicFaucetError`, public-faucet.ts), and the CLI names the faucet a funding note came from.
 */
export function isInfrastructureFailure(error: unknown): boolean {
  // Bounded, so a cause cycle cannot spin.
  let link: unknown = error;
  for (let depth = 0; depth < 8 && link !== undefined && link !== null; depth += 1) {
    if (link instanceof InfrastructureFault || /public faucet/i.test(describeFailure(link))) return true;
    link = link instanceof Error ? link.cause : undefined;
  }
  return false;
}

export interface JudgeInput {
  cellId: string;
  axis: AxisLabel;
  hardError?: unknown;
  softFailures: readonly SoftFailure[];
  evidence: FailureEvidence;
  registry: KnownBugRegistry;
}
export interface Judgement {
  verdict: CellVerdict;
  knownBugs: string[];
  staleKnownBugs: string[];
  error?: string;
}

/**
 * Decides a cell's verdict. Harness and infrastructure faults come first and never count as a wallet result. Every
 * other failure, hard or soft, must match the signature of a bug registered for this cell and axis, or the cell is
 * `fail-new`.
 */
export function judgeCell(input: JudgeInput): Judgement {
  const registered = input.registry.bugsFor(input.cellId, input.axis);
  const hardText = input.hardError === undefined ? undefined : describeFailure(input.hardError);
  if (input.hardError instanceof HarnessFault) {
    return { verdict: 'harness-fault', knownBugs: [], staleKnownBugs: [], error: hardText };
  }
  if (input.hardError instanceof InfrastructureFault) {
    return { verdict: 'blocked-infra', knownBugs: [], staleKnownBugs: [], error: hardText };
  }
  const observed = new Set<string>();
  let unexplained = false;
  const classify = (source: 'hard' | 'soft', text: string): void => {
    const matches = registered.filter(bug =>
      bug.signature({ cellId: input.cellId, source, text, evidence: input.evidence })
    );
    for (const bug of matches) observed.add(bug.id);
    if (matches.length === 0) unexplained = true;
  };
  if (hardText !== undefined) classify('hard', hardText);
  for (const soft of input.softFailures) classify('soft', `${soft.check}: ${soft.detail}`);

  const knownBugs = [...observed].sort();
  // A cell that stopped on a hard failure never reached the checks after it, so it cannot call them stale.
  const staleKnownBugs = hardText === undefined ? registered.map(bug => bug.id).filter(id => !observed.has(id)) : [];
  const failureText = [hardText, ...input.softFailures.map(soft => `${soft.check}: ${soft.detail}`)]
    .filter((text): text is string => text !== undefined)
    .join(' | ');
  const failed = failureText.length > 0;
  if (unexplained) return { verdict: 'fail-new', knownBugs, staleKnownBugs, error: failureText };
  if (failed) return { verdict: 'fail-known', knownBugs, staleKnownBugs, error: failureText };
  if (registered.length > 0) return { verdict: 'known-now-passing', knownBugs: [], staleKnownBugs };
  return { verdict: 'pass', knownBugs: [], staleKnownBugs: [] };
}

// One marker for the whole records directory, so a failed faucet grant stops the spend of every later test too.
const INFRA_ABORT = 'INFRA_ABORT';
export function infraAborted(outDir: string): string | null {
  const file = path.join(outDir, INFRA_ABORT);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
export function markInfraAbort(outDir: string, reason: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, INFRA_ABORT), reason);
}

export interface RunnerOptions<S> {
  part: string;
  axis: AxisLabel;
  journey: JourneyId;
  testTitle: string;
  outDir: string;
  /** Every cell the journey runs, recorded `not-run` up front so a test timeout or a killed worker leaves a record. */
  declared: readonly string[];
  registry: KnownBugRegistry;
  hooks: RunnerHooks<S>;
  budgets?: Partial<typeof CELL_BUDGET_MS>;
  quiesceBudgetMs?: number;
  now?: () => number;
}

export class DappCellRunner<S> {
  private readonly records = new Map<string, CellRecord>();
  private blockedState: string | undefined;
  private readonly now: () => number;

  constructor(private readonly options: RunnerOptions<S>) {
    this.now = options.now ?? Date.now;
    fs.mkdirSync(options.outDir, { recursive: true });
    for (const id of options.declared) this.records.set(id, this.record(id, 'not-run', 0));
    this.flush();
  }

  get file(): string {
    const { outDir, part, axis, journey } = this.options;
    return path.join(outDir, `${part}-${axis}-${journey}.json`);
  }

  /**
   * Runs one cell and records it at once. The body runs only when no INFRA_ABORT exists, no earlier quiesce or
   * restore failed, every cell it needs passed, and its own quiesce succeeded.
   */
  async run(cell: CellSpec<S>): Promise<CellRecord> {
    if (!this.records.has(cell.id)) {
      throw new HarnessFault(`cell ${cell.id} was not declared for journey ${this.options.journey}`);
    }
    const started = this.now();
    const infra = infraAborted(this.options.outDir);
    if (infra !== null) return this.save(this.record(cell.id, 'blocked-infra', 0, { error: infra }));
    if (this.blockedState !== undefined) {
      return this.save(this.record(cell.id, 'blocked-state', 0, { error: this.blockedState }));
    }
    const unmet = (cell.needs ?? []).find(need => !this.satisfied(need));
    if (unmet !== undefined) return this.save(this.record(cell.id, 'blocked-needs', 0, { needs: unmet }));

    const quiesceDeadline = deadlineIn(
      this.options.quiesceBudgetMs ?? QUIESCE_BUDGET_MS,
      `${cell.id} quiesce`,
      this.now
    );
    try {
      await quiesceDeadline.race(this.options.hooks.quiesce(cell, quiesceDeadline), 'quiesce');
    } catch (error) {
      // A live network's hosted Guardian or faucet failing the quiesce is infrastructure, not wallet state.
      if (error instanceof InfrastructureFault) {
        markInfraAbort(this.options.outDir, describeFailure(error));
        await this.options.hooks.restore(cell).catch(() => undefined);
        return this.save(
          this.record(cell.id, 'blocked-infra', this.now() - started, { error: describeFailure(error) })
        );
      }
      this.blockedState = `quiesce before ${cell.id} failed: ${describeFailure(error)}`;
      await this.options.hooks.restore(cell).catch(() => undefined);
      return this.save(this.record(cell.id, 'blocked-state', this.now() - started, { error: this.blockedState }));
    }
    const budget = { ...CELL_BUDGET_MS, ...this.options.budgets }[cell.budget];
    const deadline = deadlineIn(budget, cell.id, this.now);
    const evidence: FailureEvidence = {};
    const softFailures: SoftFailure[] = [];
    let hardError: unknown;
    try {
      // Not raced as a whole: an abandoned body would go on driving the wallet during the restore and the next cell.
      // Each wait inside it is raced against `deadline` instead.
      await cell.run({
        deadline,
        evidence,
        softFail: (check, detail, patch) => {
          softFailures.push({ check, detail });
          Object.assign(evidence, patch ?? {});
        }
      });
    } catch (error) {
      hardError = error;
    } finally {
      try {
        await this.options.hooks.restore(cell);
      } catch (error) {
        this.blockedState = `restore after ${cell.id} failed: ${describeFailure(error)}`;
      }
    }
    const judged = judgeCell({
      cellId: cell.id,
      axis: this.options.axis,
      hardError,
      softFailures,
      evidence,
      registry: this.options.registry
    });
    if (judged.verdict === 'blocked-infra') markInfraAbort(this.options.outDir, judged.error ?? 'infrastructure');
    return this.save(
      this.record(cell.id, judged.verdict, this.now() - started, {
        knownBugs: judged.knownBugs,
        staleKnownBugs: judged.staleKnownBugs,
        error: judged.error,
        stage: evidence.stage
      })
    );
  }

  /** Records every cell not yet run as blocked by infrastructure, for a journey that cannot even fund. */
  blockAll(reason: string): void {
    for (const [id, existing] of this.records) {
      if (existing.verdict === 'not-run') this.records.set(id, this.record(id, 'blocked-infra', 0, { error: reason }));
    }
    this.flush();
  }

  /** Fails the Playwright test with every cell that did not pass; the job verdict still comes from the records. */
  finish(): void {
    const bad = [...this.records.values()].filter(record => record.verdict !== 'pass');
    if (bad.length === 0) return;
    const lines = bad.map(
      record =>
        `  ${record.id} ${record.verdict}${record.knownBugs.length > 0 ? ` (${record.knownBugs.join(', ')})` : ''}` +
        `${record.needs ? ` needs ${record.needs}` : ''}${record.error ? `: ${record.error}` : ''}`
    );
    throw new Error(`${bad.length} of ${this.records.size} cells did not pass:\n${lines.join('\n')}`);
  }

  // Only a clean pass satisfies a prerequisite; the judge accepts a cell blocked behind a known bug (spec section 6).
  private satisfied(need: string): boolean {
    return this.records.get(need)?.verdict === 'pass';
  }

  private record(id: string, verdict: CellVerdict, durationMs: number, extra: Partial<CellRecord> = {}): CellRecord {
    return {
      id,
      verdict,
      knownBugs: [],
      staleKnownBugs: [],
      durationMs,
      finishedAt: new Date(this.now()).toISOString(),
      ...extra
    };
  }

  private save(record: CellRecord): CellRecord {
    this.records.set(record.id, record);
    this.flush();
    return record;
  }

  private flush(): void {
    const { part, axis, journey, testTitle } = this.options;
    const body: JourneyRecord = { part, axis, journey, testTitle, cells: [...this.records.values()] };
    // Written whole, then renamed into place, so no reader ever sees a half-written file.
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(temporary, this.file);
  }
}
