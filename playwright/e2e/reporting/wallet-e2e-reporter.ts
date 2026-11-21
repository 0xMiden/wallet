import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { INVOCATIONS, STATUS, TITLES } from '../../../scripts/wallet-e2e/invocations.cjs';
import { trustedEnvironment } from '../../../scripts/wallet-e2e/job.cjs';
import {
  MAX_REPORT_BYTES,
  errorFor,
  known,
  matches,
  publishAtomically,
  schema,
  testId,
  unknown,
  valueOrUnknown
} from '../../../scripts/wallet-e2e/report.cjs';

const OBSERVATION = 'wallet-e2e-observation-v1';
type WireOperation = {
  key: string;
  stages: unknown[];
  outcome: string;
  recoveryEffect: string;
  sourceRunId: { value: string | null; reason: string | null };
  offered: { value: unknown; reason: string | null };
  minimum: { value: unknown; reason: string | null };
  received: { value: unknown; reason: string | null };
  fee: { value: unknown; reason: string | null };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOperation(value: unknown): value is WireOperation {
  return matches(value, schema.$defs.operation);
}

function readObservations(result: TestResult): { operations: WireOperation[]; timeout?: number } {
  const operations = new Map<string, WireOperation>();
  let timeout: number | undefined;
  for (const annotation of result.annotations) {
    if (annotation.type !== OBSERVATION || !annotation.description || annotation.description.length > 8_000) continue;
    const parsed: unknown = JSON.parse(annotation.description);
    if (!isRecord(parsed) || !isOperation(parsed.operation)) throw new Error('Malformed wallet E2E observation');
    const { operation } = parsed;
    const earlier = operations.get(operation.key);
    if (earlier) {
      operation.stages = [...earlier.stages, ...operation.stages];
      if (operation.outcome === 'unknown') operation.outcome = earlier.outcome;
      if (operation.recoveryEffect === 'unknown') operation.recoveryEffect = earlier.recoveryEffect;
      if (operation.sourceRunId.value === null) operation.sourceRunId = earlier.sourceRunId;
      if (operation.offered.value === null) operation.offered = earlier.offered;
      if (operation.minimum.value === null) operation.minimum = earlier.minimum;
      if (operation.received.value === null) operation.received = earlier.received;
      if (operation.fee.value === null) operation.fee = earlier.fee;
    }
    operations.set(operation.key, operation);
    if (typeof parsed.timeout === 'number' && matches(parsed.timeout, schema.$defs.duration)) timeout = parsed.timeout;
  }
  return { operations: Array.from(operations.values()), timeout };
}

function attemptFor(test: TestCase, result: TestResult, ended: boolean) {
  const started = result.workerIndex >= 0;
  const { operations, timeout } = ended ? readObservations(result) : { operations: [], timeout: undefined };
  const status = ended ? (STATUS.get(result.status) ?? 'unknown') : 'in_progress';
  const error =
    status === 'failed' ? errorFor('test_failed') : status === 'timed_out' ? errorFor('test_timed_out') : null;
  return {
    retry: result.retry,
    worker: started ? known(result.workerIndex) : unknown('not_applicable'),
    status,
    expectedStatus: STATUS.get(test.expectedStatus) ?? 'unknown',
    startAt: started ? known(result.startTime.toISOString()) : unknown(),
    endAt: started && ended ? known(new Date().toISOString()) : unknown(),
    elapsedMs: started && ended ? known(result.duration) : unknown(),
    timeoutMs: valueOrUnknown(timeout),
    error,
    operations
  };
}

function logicalTest(test: TestCase, spec: string) {
  return {
    id: testId(spec, test.title),
    title: test.title,
    project: 'default',
    status: 'unknown',
    outcome: 'unknown',
    attempts: new Map<number, ReturnType<typeof attemptFor>>()
  };
}

export default class WalletE2eReporter implements Reporter {
  private readonly invocation = INVOCATIONS.get(process.env.E2E_WALLET_REPORT_INVOCATION ?? '');
  private readonly root = process.env.E2E_WALLET_REPORT_ROOT;
  private readonly identity = trustedEnvironment(process.env);
  private readonly tests = new Map<string, ReturnType<typeof logicalTest>>();
  private path?: string;
  private startedAt?: string;
  private startedMono?: number;
  private shard?: string;

  onBegin(config: FullConfig, suite: Suite): void {
    const { root, invocation, identity } = this;
    if (
      !root ||
      !identity ||
      !invocation ||
      invocation.jobKey !== identity.jobKey ||
      !existsSync(join(root, 'job.json'))
    ) {
      return;
    }
    this.path = join(root, 'invocations', invocation.id, 'playwright.json');
    this.capture(() => {
      this.startedAt = new Date().toISOString();
      this.startedMono = performance.now();
      this.shard = config.shard ? config.shard.current + '/' + config.shard.total : undefined;
      for (const test of suite.allTests()) {
        if (
          basename(test.location.file) !== invocation.spec ||
          test.parent.project()?.name !== '' ||
          !TITLES.get(invocation.suite)?.includes(test.title)
        ) {
          // An unexpected spec or title is outside the reviewed public contract.
          throw new Error('Test outside wallet E2E reporting contract');
        }
        this.tests.set(test.id, logicalTest(test, invocation.spec));
      }
    });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.capture(() => {
      const row = this.tests.get(test.id);
      if (!row) return;
      row.status = 'in_progress';
      row.attempts.set(result.retry, attemptFor(test, result, false));
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.capture(() => {
      const row = this.tests.get(test.id);
      if (!row) return;
      const attempt = attemptFor(test, result, true);
      row.status = attempt.status;
      row.outcome = test.outcome();
      row.attempts.set(result.retry, attempt);
    });
  }

  onEnd(result: FullResult): void {
    this.capture(() => {}, STATUS.get(result.status));
  }

  private capture(update: () => void, finalStatus?: string): void {
    if (!this.path || !this.invocation) return;
    const path = this.path;
    try {
      update();
      const raw = {
        id: this.invocation.id,
        mode: this.invocation.mode,
        suite: this.invocation.suite,
        spec: this.invocation.spec,
        shard: valueOrUnknown(this.shard, 'not_applicable'),
        status: finalStatus ?? 'in_progress',
        startAt: valueOrUnknown(this.startedAt),
        endAt: finalStatus ? known(new Date().toISOString()) : unknown('report_incomplete'),
        elapsedMs:
          finalStatus && this.startedMono !== undefined
            ? known(Math.round(performance.now() - this.startedMono))
            : unknown('report_incomplete'),
        deadlineAt: unknown('not_applicable'),
        timeoutMs: unknown('not_observed'),
        exitCode: unknown('not_observed'),
        playwrightOutcome: valueOrUnknown(finalStatus, 'report_incomplete'),
        tests: Array.from(this.tests.values(), ({ attempts, ...test }) => ({
          ...test,
          attempts: Array.from(attempts.values())
        }))
      };
      if (!matches(raw, schema.$defs.invocation)) throw new Error('Invalid wallet E2E invocation');
      const bytes = JSON.stringify(raw);
      if (Buffer.byteLength(bytes) > MAX_REPORT_BYTES) throw new Error('Wallet E2E invocation too large');
      publishAtomically(path, bytes);
    } catch {
      this.path = undefined;
      try {
        rmSync(path, { force: true });
      } catch {
        // Filesystem failure also may make cleanup unavailable.
      }
      process.stderr.write('Wallet E2E invocation evidence unavailable.\n');
    }
  }
}
