export const EXECUTION_ROUTES = ['ordinary_new_transaction', 'guardian_signed_request'] as const;
export const AUTH_OBSERVATIONS = ['not_reached', 'observed', 'read_failed'] as const;
export const AUTH_ARG_PRESENCE = ['present', 'absent', 'unavailable'] as const;
export const AUTH_LAYOUTS = ['absent', 'fee', 'guardian', 'other', 'missing_preimage', 'unavailable'] as const;
export const COMMITMENT_MATCHES = ['fee', 'guardian', 'neither', 'unavailable'] as const;
export const ACCOUNT_AUTH_CODES = ['current_guardian', 'unrecognized', 'unavailable'] as const;

export interface TransactionExecutionDiagnostics {
  executionRoute: (typeof EXECUTION_ROUTES)[number];
  authObservation: (typeof AUTH_OBSERVATIONS)[number];
  authArgPresence: (typeof AUTH_ARG_PRESENCE)[number];
  authLayout: (typeof AUTH_LAYOUTS)[number];
  commitmentMatch: (typeof COMMITMENT_MATCHES)[number];
  accountAuthCode: (typeof ACCOUNT_AUTH_CODES)[number];
}

export const EXECUTION_DIAGNOSTIC_KEYS = [
  'executionRoute',
  'authObservation',
  'authArgPresence',
  'authLayout',
  'commitmentMatch',
  'accountAuthCode'
] as const;

export function unobservedTransactionExecution(
  executionRoute: TransactionExecutionDiagnostics['executionRoute']
): TransactionExecutionDiagnostics {
  return {
    executionRoute,
    authObservation: 'not_reached',
    authArgPresence: 'unavailable',
    authLayout: 'unavailable',
    commitmentMatch: 'unavailable',
    accountAuthCode: 'unavailable'
  };
}

/** Copies only the complete closed payload; never copies an error, request, or unknown property. */
export function validateTransactionExecutionDiagnostics(value: unknown): TransactionExecutionDiagnostics | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const suppliedExecutionRoute = Reflect.get(value, 'executionRoute');
    const executionRoute = EXECUTION_ROUTES.find(item => item === suppliedExecutionRoute);
    const suppliedAuthObservation = Reflect.get(value, 'authObservation');
    const authObservation = AUTH_OBSERVATIONS.find(item => item === suppliedAuthObservation);
    const suppliedAuthArgPresence = Reflect.get(value, 'authArgPresence');
    const authArgPresence = AUTH_ARG_PRESENCE.find(item => item === suppliedAuthArgPresence);
    const suppliedAuthLayout = Reflect.get(value, 'authLayout');
    const authLayout = AUTH_LAYOUTS.find(item => item === suppliedAuthLayout);
    const suppliedCommitmentMatch = Reflect.get(value, 'commitmentMatch');
    const commitmentMatch = COMMITMENT_MATCHES.find(item => item === suppliedCommitmentMatch);
    const suppliedAccountAuthCode = Reflect.get(value, 'accountAuthCode');
    const accountAuthCode = ACCOUNT_AUTH_CODES.find(item => item === suppliedAccountAuthCode);
    if (!executionRoute || !authObservation || !authArgPresence || !authLayout || !commitmentMatch || !accountAuthCode)
      return undefined;
    if (
      authObservation === 'not_reached' &&
      (authArgPresence !== 'unavailable' || authLayout !== 'unavailable' || commitmentMatch !== 'unavailable')
    )
      return undefined;
    if (authArgPresence === 'absent' && (authLayout !== 'absent' || commitmentMatch !== 'unavailable'))
      return undefined;
    if (authArgPresence === 'present' && authLayout === 'absent') return undefined;
    return { executionRoute, authObservation, authArgPresence, authLayout, commitmentMatch, accountAuthCode };
  } catch {
    return undefined;
  }
}

const observations = new WeakMap<object, TransactionExecutionDiagnostics>();

export function annotateTransactionExecution(error: unknown, diagnostics: unknown): void {
  if (typeof error !== 'object' || error === null) return;
  const safe = validateTransactionExecutionDiagnostics(diagnostics);
  // Replace the entire attempt's observation, including when an old Error object is reused.
  if (safe === undefined) observations.delete(error);
  else observations.set(error, safe);
}

/** Root only: a previous attempt's cause never supplies the current execution observation. */
export function snapshotTransactionExecution(error: unknown): TransactionExecutionDiagnostics | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return validateTransactionExecutionDiagnostics(observations.get(error));
}
