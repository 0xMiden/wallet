import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';
import {
  validateReownNativeFailure,
  type ReownNativeOrigin,
  type ReownWalletResponseCode,
  type ReownRequestAge,
  type ReownPublication,
  type ReownBackgroundAnswer
} from 'lib/walletconnect/native-request-failure';

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
  reownNativeOrigin?: ReownNativeOrigin;
  reownWalletResponseCode?: ReownWalletResponseCode;
  reownRequestAge?: ReownRequestAge;
  reownPublished?: ReownPublication;
  reownBackgrounded?: ReownBackgroundAnswer;
  userErrorId?: UserErrorId;
  userErrorSurface?: UserErrorSurface;
};

const nativeKeys: ReadonlyArray<keyof CrashDiagnostics> = [
  'reownNativeOrigin',
  'reownWalletResponseCode',
  'reownRequestAge',
  'reownPublished',
  'reownBackgrounded'
];

function clearNativeDiagnostics(diagnostics: CrashDiagnostics): void {
  for (const key of nativeKeys) delete diagnostics[key];
}

function nativeDiagnostics(diagnostics: Record<string, unknown>): CrashDiagnostics {
  const native = validateReownNativeFailure({
    get nativeOrigin() {
      return diagnostics.reownNativeOrigin;
    },
    get walletResponseCode() {
      return diagnostics.reownWalletResponseCode;
    },
    get requestAge() {
      return diagnostics.reownRequestAge;
    },
    get published() {
      return diagnostics.reownPublished;
    },
    get backgrounded() {
      return diagnostics.reownBackgrounded;
    }
  });
  if (native === undefined) return {};
  const safe: CrashDiagnostics = {
    reownNativeOrigin: native.nativeOrigin,
    reownRequestAge: native.requestAge,
    reownPublished: native.published
  };
  if (native.nativeOrigin === 'wallet_error') safe.reownWalletResponseCode = native.walletResponseCode;
  if (native.backgrounded !== undefined) safe.reownBackgrounded = native.backgrounded;
  return safe;
}

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
    const previous = { ...diagnosticsByError.get(error) };
    // A native annotation replaces a request's whole group, including absent optional observations.
    if (nativeKeys.some(key => key in diagnostics)) clearNativeDiagnostics(previous);
    diagnosticsByError.set(error, { ...previous, ...safe, ...nativeDiagnostics(diagnostics) });
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
  const snapshot: CrashDiagnostics = {};
  for (const link of errorChain(error).reverse()) {
    const stored = diagnosticsByError.get(link);
    if (stored === undefined) continue;
    const unrelated = { ...stored };
    clearNativeDiagnostics(unrelated);
    Object.assign(snapshot, unrelated);
    const native = nativeDiagnostics(stored);
    if (native.reownNativeOrigin !== undefined) {
      clearNativeDiagnostics(snapshot);
      Object.assign(snapshot, native);
    }
  }
  return snapshot;
}
