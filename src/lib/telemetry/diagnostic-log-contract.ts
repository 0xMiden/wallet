/** The closed vocabulary of diagnostic log records. Imports nothing, so the crash client can re-check what it sends. */
export const DIAGNOSTIC_LOG_EVENTS = ['operation_step', 'operation_end'] as const;
export const DIAGNOSTIC_OPERATIONS = ['swap'] as const;
export const DIAGNOSTIC_STEPS = [
  'service_prepare',
  'request_build',
  'request_persist',
  'proposal_create',
  'proposal_execute'
] as const;
export const DIAGNOSTIC_STEP_OUTCOMES = ['ok', 'failed', 'timeout', 'aborted', 'locked'] as const;
export const DIAGNOSTIC_END_OUTCOMES = ['completed', 'failed', 'timeout', 'cancelled', 'interrupted'] as const;
export const DIAGNOSTIC_DURATIONS = ['under_1s', '1_to_5s', '5_to_30s', '30s_to_2m', '2_to_10m', 'over_10m'] as const;

export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number];
export type DiagnosticStep = (typeof DIAGNOSTIC_STEPS)[number];
export type DiagnosticStepOutcome = (typeof DIAGNOSTIC_STEP_OUTCOMES)[number];
export type DiagnosticEndOutcome = (typeof DIAGNOSTIC_END_OUTCOMES)[number];
export type DiagnosticDuration = (typeof DIAGNOSTIC_DURATIONS)[number];

export type DiagnosticLogEvent = (typeof DIAGNOSTIC_LOG_EVENTS)[number];

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some(listed => listed === value);
}

/** True only for a record of one fixed event whose every attribute is a value that event allows. */
export function isClosedDiagnosticLog(message: unknown, attributes: Readonly<Record<string, unknown>>): boolean {
  const { operation, step, outcome, duration, ...rest } = attributes;
  if (Object.keys(rest).length > 0 || !isOneOf(DIAGNOSTIC_OPERATIONS, operation)) return false;
  if (duration !== undefined && !isOneOf(DIAGNOSTIC_DURATIONS, duration)) return false;
  if (message === 'operation_step') {
    return isOneOf(DIAGNOSTIC_STEPS, step) && isOneOf(DIAGNOSTIC_STEP_OUTCOMES, outcome);
  }
  return message === 'operation_end' && step === undefined && isOneOf(DIAGNOSTIC_END_OUTCOMES, outcome);
}
