import { captureDiagnosticLog } from './crash';
import {
  DIAGNOSTIC_END_OUTCOMES,
  DIAGNOSTIC_OPERATIONS,
  DIAGNOSTIC_STEP_OUTCOMES,
  DIAGNOSTIC_STEPS,
  isOneOf,
  type DiagnosticDuration,
  type DiagnosticEndOutcome,
  type DiagnosticLogEvent,
  type DiagnosticOperation,
  type DiagnosticStep,
  type DiagnosticStepOutcome
} from './diagnostic-log-contract';

export * from './diagnostic-log-contract';

/**
 * Diagnostic history: a few fixed records per operation, sent as Sentry Logs through the crash client, so a crash
 * report can be read beside the steps that led to it. Every value is one of the closed lists in
 * `diagnostic-log-contract.ts`; a record holding
 * anything else is dropped whole, and nothing a step threw is read except by the producer's own classifier.
 */
const DURATION_FLOORS: ReadonlyArray<readonly [number, DiagnosticDuration]> = [
  [600_000, 'over_10m'],
  [120_000, '2_to_10m'],
  [30_000, '30s_to_2m'],
  [5_000, '5_to_30s'],
  [1_000, '1_to_5s'],
  [0, 'under_1s']
];

// A requeue loop can fail the same step every few seconds for half an hour; these bound what one operation sends.
const BURST_WINDOW_MS = 10_000;
const BURST_LIMIT = 10;
const VOLUME_WINDOW_MS = 600_000;
const VOLUME_LIMIT = 60;
const sentAtByOperation = new Map<DiagnosticOperation, number[]>();

function durationBucket(durationMs: number | undefined): DiagnosticDuration | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  return DURATION_FLOORS.find(([floor]) => durationMs >= floor)?.[1];
}

function admit(operation: DiagnosticOperation): boolean {
  const now = performance.now();
  const recent = (sentAtByOperation.get(operation) ?? []).filter(time => now - time < VOLUME_WINDOW_MS);
  sentAtByOperation.set(operation, recent);
  if (recent.length >= VOLUME_LIMIT) return false;
  if (recent.filter(time => now - time < BURST_WINDOW_MS).length >= BURST_LIMIT) return false;
  recent.push(now);
  return true;
}

function send(
  event: DiagnosticLogEvent,
  operation: DiagnosticOperation,
  fields: Record<string, string>,
  durationMs: number | undefined
): void {
  try {
    if (!admit(operation)) return;
    const duration = durationBucket(durationMs);
    captureDiagnosticLog(event, { operation, ...fields, ...(duration === undefined ? {} : { duration }) });
  } catch {
    // Diagnostics must never change the operation they describe.
  }
}

export function logOperationStep(
  operation: DiagnosticOperation,
  step: DiagnosticStep,
  outcome: DiagnosticStepOutcome,
  durationMs?: number
): void {
  if (
    !isOneOf(DIAGNOSTIC_OPERATIONS, operation) ||
    !isOneOf(DIAGNOSTIC_STEPS, step) ||
    !isOneOf(DIAGNOSTIC_STEP_OUTCOMES, outcome)
  )
    return;
  send('operation_step', operation, { step, outcome }, durationMs);
}

export function logOperationEnd(
  operation: DiagnosticOperation,
  outcome: DiagnosticEndOutcome,
  durationMs?: number
): void {
  if (!isOneOf(DIAGNOSTIC_OPERATIONS, operation) || !isOneOf(DIAGNOSTIC_END_OUTCOMES, outcome)) return;
  send('operation_end', operation, { outcome }, durationMs);
}

/** Awaits `run`, records how the step ended, and returns or rethrows exactly what `run` did. */
export async function withOperationStep<T>(
  operation: DiagnosticOperation,
  step: DiagnosticStep,
  run: () => Promise<T>,
  outcomeOf: (error: unknown) => DiagnosticStepOutcome
): Promise<T> {
  const startedAt = performance.now();
  try {
    const value = await run();
    logOperationStep(operation, step, 'ok', performance.now() - startedAt);
    return value;
  } catch (error) {
    let outcome: DiagnosticStepOutcome = 'failed';
    try {
      outcome = outcomeOf(error);
    } catch {
      // An unclassifiable failure is still a failure of this step.
    }
    logOperationStep(operation, step, outcome, performance.now() - startedAt);
    throw error;
  }
}

export function _resetDiagnosticLogLimitsForTest(): void {
  sentAtByOperation.clear();
}
