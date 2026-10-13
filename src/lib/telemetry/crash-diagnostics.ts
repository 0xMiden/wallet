import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

export type CrashDiagnostics = {
  operation?: 'intercom_request' | 'confirm_payload' | 'sdk_initialize';
  requestType?: WalletMessageType | MidenMessageType;
  confirmationId?: 'missing' | 'empty';
  stage?: 'wasm_ready' | 'mock_import' | 'mock_create' | 'client_create';
  workerMode?: 'enabled' | 'disabled';
};

const diagnosticsByError = new WeakMap<Error, CrashDiagnostics>();
const requestTypes = [
  ...Object.entries(WalletMessageType)
    .filter(([key]) => key.endsWith('Request'))
    .map(([, value]) => value),
  ...Object.entries(MidenMessageType)
    .filter(([key]) => key.endsWith('Request'))
    .map(([, value]) => value)
];

export function annotateCrash(error: unknown, diagnostics: Record<string, unknown>): void {
  try {
    if (!(error instanceof Error)) return;
    const safe: CrashDiagnostics = {};
    const { operation, requestType: suppliedRequestType, confirmationId, stage, workerMode } = diagnostics;
    if (operation === 'intercom_request' || operation === 'confirm_payload' || operation === 'sdk_initialize') {
      safe.operation = operation;
    }
    const requestType = requestTypes.find(value => value === suppliedRequestType);
    if (requestType !== undefined) safe.requestType = requestType;
    if (confirmationId === 'missing' || confirmationId === 'empty') safe.confirmationId = confirmationId;
    if (stage === 'wasm_ready' || stage === 'mock_import' || stage === 'mock_create' || stage === 'client_create')
      safe.stage = stage;
    if (workerMode === 'enabled' || workerMode === 'disabled') safe.workerMode = workerMode;
    diagnosticsByError.set(error, { ...diagnosticsByError.get(error), ...safe });
  } catch {
    // Reporting cannot change the failure being handled.
  }
}

export function snapshotCrashDiagnostics(error: unknown): CrashDiagnostics {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  try {
    while (error instanceof Error && !seen.has(error) && chain.length < 4) {
      seen.add(error);
      chain.push(error);
      error = error.cause;
    }
  } catch {
    // A hostile cause accessor cannot prevent the outer diagnostic snapshot.
  }
  return Object.assign({}, ...chain.reverse().map(link => diagnosticsByError.get(link)));
}
