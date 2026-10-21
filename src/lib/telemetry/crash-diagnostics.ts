import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import {
  USER_ERROR_SURFACES,
  isUserErrorId,
  type UserErrorId,
  type UserErrorSurface
} from './user-visible-error-contract';
import { EXTENSION_VIEW_COUNTS, SHARED_MEMORY_PROBES, type WasmStartupEvidence } from './wasm-startup';

/** The background's state for a dApp approval no handler answered; its Not Found code is `confirmation_<state>`. */
export const CONFIRMATION_HANDLER_STATES = [
  'open',
  'answered',
  'window_closed',
  'expired',
  'payload_failed',
  'unknown'
] as const;
export type ConfirmationHandlerState = (typeof CONFIRMATION_HANDLER_STATES)[number];

export type CrashDiagnostics = WasmStartupEvidence & {
  operation?: 'intercom_request' | 'confirm_payload' | 'sdk_initialize';
  requestType?: WalletMessageType | MidenMessageType;
  confirmationId?: 'missing' | 'empty';
  stage?: 'wasm_ready' | 'mock_import' | 'mock_create' | 'client_create';
  workerMode?: 'enabled' | 'disabled';
  confirmationHandler?: ConfirmationHandlerState;
  portReconnected?: boolean;
  userErrorId?: UserErrorId;
  userErrorSurface?: UserErrorSurface;
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
    const {
      operation,
      requestType: suppliedRequestType,
      confirmationId,
      stage,
      workerMode,
      sharedMemoryProbe: suppliedProbe,
      extensionViews: suppliedViews,
      confirmationHandler: suppliedCode,
      portReconnected,
      userErrorId,
      userErrorSurface: suppliedSurface
    } = diagnostics;
    if (operation === 'intercom_request' || operation === 'confirm_payload' || operation === 'sdk_initialize') {
      safe.operation = operation;
    }
    const requestType = requestTypes.find(value => value === suppliedRequestType);
    if (requestType !== undefined) safe.requestType = requestType;
    if (confirmationId === 'missing' || confirmationId === 'empty') safe.confirmationId = confirmationId;
    if (stage === 'wasm_ready' || stage === 'mock_import' || stage === 'mock_create' || stage === 'client_create')
      safe.stage = stage;
    if (workerMode === 'enabled' || workerMode === 'disabled') safe.workerMode = workerMode;
    const sharedMemoryProbe = SHARED_MEMORY_PROBES.find(value => value === suppliedProbe);
    if (sharedMemoryProbe !== undefined) safe.sharedMemoryProbe = sharedMemoryProbe;
    const extensionViews = EXTENSION_VIEW_COUNTS.find(value => value === suppliedViews);
    if (extensionViews !== undefined) safe.extensionViews = extensionViews;
    const confirmationHandler = CONFIRMATION_HANDLER_STATES.find(state => `confirmation_${state}` === suppliedCode);
    if (confirmationHandler !== undefined) safe.confirmationHandler = confirmationHandler;
    if (typeof portReconnected === 'boolean') safe.portReconnected = portReconnected;
    if (isUserErrorId(userErrorId)) safe.userErrorId = userErrorId;
    const userErrorSurface = USER_ERROR_SURFACES.find(surface => surface === suppliedSurface);
    if (userErrorSurface !== undefined) safe.userErrorSurface = userErrorSurface;
    diagnosticsByError.set(error, { ...diagnosticsByError.get(error), ...safe });
  } catch {
    // Reporting cannot change the failure being handled.
  }
}

/** `error` and up to three of its causes, outermost first. */
export function errorChain(error: unknown): Error[] {
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
  return chain;
}

export function snapshotCrashDiagnostics(error: unknown): CrashDiagnostics {
  return Object.assign(
    {},
    ...errorChain(error)
      .reverse()
      .map(link => diagnosticsByError.get(link))
  );
}
