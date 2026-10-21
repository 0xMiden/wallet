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

/** The step a Guardian proposal's preparation was in when it failed, from the service lookup to the signing stage. */
export const PROPOSAL_STEPS = [
  'service_select',
  'service_account_read',
  'service_signer_read',
  'service_load',
  'chain_sync',
  'reclaim_build',
  'reclaim_persist',
  'proposal_create',
  'signing_stage_write'
] as const;
export type ProposalStep = (typeof PROPOSAL_STEPS)[number];

/** The wallet's own checks that refuse to build a Guardian service for an account. */
export const PROPOSAL_GUARDS = ['account_not_guardian', 'hot_key_missing'] as const;
export type ProposalGuard = (typeof PROPOSAL_GUARDS)[number];

export type StorageOwner = 'wallet_transactions' | 'wallet_limits' | 'wallet_database';
export type StorageOperation = 'get' | 'query' | 'count' | 'cursor' | 'mutate' | 'transaction' | 'open';
export type PageVisibility = 'visible' | 'hidden' | 'unknown';

export const STORAGE_OWNERS: readonly StorageOwner[] = ['wallet_transactions', 'wallet_limits', 'wallet_database'];
export const STORAGE_OPERATIONS: readonly StorageOperation[] = [
  'get',
  'query',
  'count',
  'cursor',
  'mutate',
  'transaction',
  'open'
];
export const PAGE_VISIBILITY: readonly PageVisibility[] = ['visible', 'hidden', 'unknown'];

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
  storageOwner?: StorageOwner;
  storageOperation?: StorageOperation;
  userErrorId?: UserErrorId;
  userErrorSurface?: UserErrorSurface;
  proposalStep?: ProposalStep;
  proposalGuard?: ProposalGuard;
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

export type StorageCrashDiagnostics = Pick<CrashDiagnostics, 'storageOwner' | 'storageOperation'>;

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
      storageOwner: suppliedOwner,
      storageOperation: suppliedStorageOperation,
      userErrorId,
      userErrorSurface: suppliedSurface,
      proposalStep: suppliedStep,
      proposalGuard: suppliedGuard
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
    const storageOwner = STORAGE_OWNERS.find(value => value === suppliedOwner);
    const storageOperation = STORAGE_OPERATIONS.find(value => value === suppliedStorageOperation);
    const previous = { ...diagnosticsByError.get(error) };
    if (
      storageOwner !== undefined &&
      storageOperation !== undefined &&
      (storageOwner !== 'wallet_database' || storageOperation === 'transaction' || storageOperation === 'open')
    ) {
      // Do not join a new operation to a stale owner.
      delete previous.storageOwner;
      delete previous.storageOperation;
      safe.storageOwner = storageOwner;
      safe.storageOperation = storageOperation;
    }
    // The innermost boundary names the step first; an outer one it propagates through only knows a broader one.
    const proposalStep = PROPOSAL_STEPS.find(step => step === suppliedStep);
    if (proposalStep !== undefined && previous.proposalStep === undefined) {
      safe.proposalStep = proposalStep;
      const proposalGuard = PROPOSAL_GUARDS.find(guard => guard === suppliedGuard);
      if (proposalGuard !== undefined) safe.proposalGuard = proposalGuard;
    }
    // A native annotation replaces a request's whole group, including absent optional observations.
    if (nativeKeys.some(key => key in diagnostics)) clearNativeDiagnostics(previous);
    diagnosticsByError.set(error, { ...previous, ...safe, ...nativeDiagnostics(diagnostics) });
  } catch {
    // Reporting cannot change the failure being handled.
  }
}

/** Awaits `operation` and rethrows its rejection unchanged, naming `step` on it unless a step inside already did. */
export async function withProposalStep<T>(step: ProposalStep, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    annotateCrash(error, { proposalStep: step });
    throw error;
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

function storageDiagnosticsAt(error: Error): StorageCrashDiagnostics | undefined {
  const seen = new Set<Error>();
  const visiting = new Set<Error>();
  let failureEntries = 0;
  const visit = (link: unknown, depth: number): StorageCrashDiagnostics | undefined => {
    if (!(link instanceof Error) || depth > 3 || visiting.has(link)) return {};
    seen.add(link);
    if (seen.size > 32) return {};
    const explicit = diagnosticsByError.get(link);
    if (explicit?.storageOwner !== undefined && explicit.storageOperation !== undefined) {
      return { storageOwner: explicit.storageOwner, storageOperation: explicit.storageOperation };
    }
    visiting.add(link);
    const inner: unknown = 'inner' in link ? link.inner : undefined;
    const failures: unknown = 'failures' in link ? link.failures : undefined;
    let candidate: StorageCrashDiagnostics | undefined;
    let missingCandidate = false;
    if (inner !== undefined && inner !== null) {
      candidate = visit(inner, depth + 1);
      if (candidate !== undefined && candidate.storageOperation === undefined) return {};
      missingCandidate = candidate === undefined;
    }
    if (failures !== undefined) {
      if (!Array.isArray(failures)) return {};
      const length: unknown = failures.length;
      if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0 || length > 32) return {};
      failureEntries += length;
      // Count entries even when several slots reference the same Error.
      if (failureEntries > 32) return {};
      for (let index = 0; index < length; index++) {
        const entry: unknown = failures[index];
        const promoted = visit(entry, depth + 1);
        if (promoted === undefined) {
          missingCandidate = true;
          continue;
        }
        if (promoted.storageOwner === undefined || promoted.storageOperation === undefined) return {};
        if (
          candidate !== undefined &&
          (candidate.storageOwner !== promoted.storageOwner || candidate.storageOperation !== promoted.storageOperation)
        )
          return {};
        candidate = promoted;
      }
    }
    visiting.delete(link);
    return missingCandidate && candidate !== undefined ? {} : candidate;
  };
  try {
    // Undefined permits cause inheritance; an empty result rejects uncertain attribution.
    return visit(error, 0);
  } catch {
    // Inaccessible fixed links make attribution uncertain, never the failure itself.
    return {};
  }
}

export function snapshotCrashDiagnostics(error: unknown): CrashDiagnostics {
  const snapshot: CrashDiagnostics = {};
  for (const link of errorChain(error).reverse()) {
    const stored = diagnosticsByError.get(link);
    const { storageOwner, storageOperation, ...other } = stored ?? {};
    clearNativeDiagnostics(other);
    Object.assign(snapshot, other);
    const native: CrashDiagnostics = stored === undefined ? {} : nativeDiagnostics(stored);
    if (native.reownNativeOrigin !== undefined) {
      clearNativeDiagnostics(snapshot);
      Object.assign(snapshot, native);
    }
    const storage = storageDiagnosticsAt(link);
    if (storage !== undefined) {
      // A link's own pair replaces inherited storage fields, and a rejected promotion clears them.
      delete snapshot.storageOwner;
      delete snapshot.storageOperation;
      Object.assign(snapshot, storage);
    }
  }
  return snapshot;
}

export function readPageVisibility(): PageVisibility {
  try {
    if (typeof document === 'undefined') return 'unknown';
    const visibility = document.visibilityState;
    return visibility === 'visible' || visibility === 'hidden' ? visibility : 'unknown';
  } catch {
    return 'unknown';
  }
}
