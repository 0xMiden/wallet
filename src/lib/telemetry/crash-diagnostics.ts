import { MidenMessageType } from 'lib/miden/types';
import {
  STARTUP_ELIGIBILITY_STAGES,
  STARTUP_ELIGIBILITY_REASONS,
  STARTUP_ELIGIBILITY_RETRIES,
  type StartupEligibilityDiagnostics
} from 'lib/remote-config/geo';
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
  BRIDGE_BALANCE_CHECKS,
  BRIDGE_ORPHAN_CHECKS,
  BRIDGE_SOURCE_ROUTES,
  type BridgeBalanceCheck,
  type BridgeOrphanCheck,
  type BridgeSourceRoute
} from './bridge-receive-failure';
import {
  annotateGuardianProving,
  snapshotGuardianProving,
  type GuardianProvingDiagnostics
} from './guardian-proving-diagnostics';
import { snapshotOffscreenDeadlineForCrash, type OffscreenDeadlineDiagnostics } from './offscreen-deadline-diagnostics';
import { snapshotProofWaitAvailability, type ProofWaitAvailability } from './proof-wait-availability-diagnostics';
import {
  clearProposalCreateDiagnostics,
  snapshotProposalCreateDiagnostics,
  type ProposalCreateDiagnostics
} from './proposal-create-diagnostics';
import { snapshotTerminalReport, type TerminalReportDiagnostics } from './terminal-report-diagnostics';
import {
  annotateTransactionExecution,
  snapshotTransactionExecution,
  EXECUTION_DIAGNOSTIC_KEYS,
  type TransactionExecutionDiagnostics
} from './transaction-execution-diagnostics';
import {
  annotateUiProducer,
  snapshotUiProducer,
  UI_PRODUCER_KEYS,
  type UiProducerDiagnostics
} from './ui-producer-diagnostics';
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

/** What the request a background found no handler for carried as the approval's id. */
export const CONFIRMATION_REQUEST_SHAPES = [
  'string',
  'array_with_string',
  'array_without_string',
  'missing',
  'other'
] as const;
export type ConfirmationRequestShape = (typeof CONFIRMATION_REQUEST_SHAPES)[number];

/** Whether the background's memory of recent approvals is empty, holds some, or has dropped older ones. */
export const CONFIRMATION_REGISTRY_STATES = ['empty', 'holding', 'pruned'] as const;
export type ConfirmationRegistryState = (typeof CONFIRMATION_REGISTRY_STATES)[number];

export const BACKGROUND_AGES = ['under_10s', '10_to_60s', '60_to_300s', 'over_300s', 'unknown'] as const;
export type BackgroundAge = (typeof BACKGROUND_AGES)[number];

export const PAGE_NAVIGATIONS = ['navigate', 'reload', 'back_forward', 'prerender', 'unknown'] as const;
export type PageNavigation = (typeof PAGE_NAVIGATIONS)[number];

export const CONSUME_VERDICTS = [
  'landed-local',
  'landed-external',
  'invalid',
  'processing',
  'not-landed',
  'unknown'
] as const;
export type ConsumeVerdict = (typeof CONSUME_VERDICTS)[number];

/**
 * The step a Guardian proposal's preparation was in when it failed, from the service lookup through the signing stage
 * to the submit crossing that hands the co-signed request to the transaction pipeline.
 */
export const PROPOSAL_STEPS = [
  'service_select',
  'service_account_read',
  'service_signer_read',
  'service_load',
  'chain_sync',
  'reclaim_build',
  'reclaim_persist',
  'purchase_build',
  'purchase_persist',
  'swap_request_build',
  'swap_request_persist',
  'rebase_build',
  'proposal_create',
  'rebased_request_persist',
  'signing_stage_write',
  'sign_lock',
  'proposal_sign',
  'custom_advice',
  'custom_request_build',
  'proposal_request',
  'submit_serialize',
  'submit_pin',
  'client_build'
] as const;
export type ProposalStep = (typeof PROPOSAL_STEPS)[number];

/** The wallet's own checks that refuse to build a Guardian service for an account, or to use one. */
export const PROPOSAL_GUARDS = ['account_not_guardian', 'hot_key_missing', 'guardian_out_of_sync'] as const;
export type ProposalGuard = (typeof PROPOSAL_GUARDS)[number];

/**
 * The account's own security changes. These are the names in `STRUCTURAL_GUARDIAN_TYPES` and nothing else: a
 * proposal failure for one of them otherwise looks the same as the other two.
 */
export const SECURITY_CHANGE_ACTIONS = ['switch-guardian', 'replace-hot-key', 'update-procedure-threshold'] as const;
export type SecurityChangeAction = (typeof SECURITY_CHANGE_ACTIONS)[number];

/** The step a submitted transaction's completion was in when it failed, from reading its result to recording it. */
export const COMPLETION_STEPS = ['result_read', 'row_read', 'result_serialize', 'status_write'] as const;
export type CompletionStep = (typeof COMPLETION_STEPS)[number];

/** The wallet's own checks that refuse an executed result its completion cannot record. */
export const COMPLETION_GUARDS = ['no_input_notes', 'no_fungible_assets'] as const;
export type CompletionGuard = (typeof COMPLETION_GUARDS)[number];

/**
 * Beside a Guardian authentication refusal: whether the key this device signed with commits to one of the account's
 * signers on chain, which of its keys that was, and whether the account still waits for its everyday key to be
 * replaced.
 */
export const GUARDIAN_SIGNER_IN_SET = ['yes', 'no', 'unknown'] as const;
export type GuardianSignerInSet = (typeof GUARDIAN_SIGNER_IN_SET)[number];
export const GUARDIAN_SIGNING_KEYS = ['hot', 'cold'] as const;
export type GuardianSigningKey = (typeof GUARDIAN_SIGNING_KEYS)[number];
export const HOT_KEY_ROTATION_PENDING = ['yes', 'no'] as const;
export type HotKeyRotationPending = (typeof HOT_KEY_ROTATION_PENDING)[number];

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

export type CrashDiagnostics = Partial<
  ProposalCreateDiagnostics &
    GuardianProvingDiagnostics &
    OffscreenDeadlineDiagnostics &
    TerminalReportDiagnostics & { proofWaitAvailability: ProofWaitAvailability }
> &
  Partial<TransactionExecutionDiagnostics> &
  UiProducerDiagnostics &
  WasmStartupEvidence &
  Partial<StartupEligibilityDiagnostics> & {
    operation?: 'intercom_request' | 'confirm_payload' | 'sdk_initialize';
    requestType?: WalletMessageType | MidenMessageType;
    confirmationId?: 'missing' | 'empty';
    stage?: 'wasm_ready' | 'mock_import' | 'mock_create' | 'client_create';
    workerMode?: 'enabled' | 'disabled';
    clientRole?: 'primary' | 'realm_reader';
    confirmationHandler?: ConfirmationHandlerState;
    confirmationRequestShape?: ConfirmationRequestShape;
    confirmationRegistry?: ConfirmationRegistryState;
    backgroundAge?: BackgroundAge;
    pageNavigation?: PageNavigation;
    consumeVerdict?: ConsumeVerdict;
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
    securityChange?: SecurityChangeAction;
    completionStep?: CompletionStep;
    completionGuard?: CompletionGuard;
    bridgeBalanceCheck?: BridgeBalanceCheck;
    bridgeOrphanCheck?: BridgeOrphanCheck;
    bridgeSourceRoute?: BridgeSourceRoute;
    guardianSignerInSet?: GuardianSignerInSet;
    guardianSigningKey?: GuardianSigningKey;
    hotKeyRotationPending?: HotKeyRotationPending;
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

type ConfirmationDiagnostics = Pick<
  CrashDiagnostics,
  'confirmationHandler' | 'confirmationRequestShape' | 'confirmationRegistry' | 'backgroundAge'
>;

/**
 * The background's Not Found code: `confirmation_<state>`, or that followed by `:<shape>:<registry>:<age>`. Anything
 * else, including one wrong part, carries nothing.
 */
function readConfirmationCode(code: unknown): ConfirmationDiagnostics {
  if (typeof code !== 'string') return {};
  const [stateCode, ...labels] = code.split(':');
  const confirmationHandler = CONFIRMATION_HANDLER_STATES.find(state => `confirmation_${state}` === stateCode);
  if (confirmationHandler === undefined) return {};
  if (labels.length === 0) return { confirmationHandler };
  if (labels.length !== 3) return {};
  const [shape, registry, age] = labels;
  const confirmationRequestShape = CONFIRMATION_REQUEST_SHAPES.find(value => value === shape);
  const confirmationRegistry = CONFIRMATION_REGISTRY_STATES.find(value => value === registry);
  const backgroundAge = BACKGROUND_AGES.find(value => value === age);
  if (confirmationRequestShape === undefined || confirmationRegistry === undefined || backgroundAge === undefined)
    return {};
  return { confirmationHandler, confirmationRequestShape, confirmationRegistry, backgroundAge };
}

const diagnosticsByError = new WeakMap<object, CrashDiagnostics>();
const requestTypes = [
  ...Object.entries(WalletMessageType)
    .filter(([key]) => key.endsWith('Request'))
    .map(([, value]) => value),
  ...Object.entries(MidenMessageType)
    .filter(([key]) => key.endsWith('Request'))
    .map(([, value]) => value)
];

export function annotateCrash(error: unknown, diagnostics: Record<string, unknown>): void {
  annotateCrashAtBoundary(error, diagnostics);
}

function annotateCrashAtBoundary(
  error: unknown,
  diagnostics: Record<string, unknown>,
  preserveInner = false,
  refreshProposal = false
): void {
  try {
    if (typeof error !== 'object' || error === null) return;
    if (!(error instanceof Error)) {
      const { operation, stage, workerMode, clientRole } = diagnostics;
      if (
        operation === 'sdk_initialize' &&
        stage === 'client_create' &&
        (clientRole === 'primary' || clientRole === 'realm_reader')
      ) {
        diagnosticsByError.set(error, {
          operation,
          stage,
          ...(workerMode === 'enabled' || workerMode === 'disabled' ? { workerMode } : {}),
          clientRole
        });
      }
      return;
    }
    const safe: CrashDiagnostics = {};
    if ('executionRoute' in diagnostics) annotateTransactionExecution(error, diagnostics);
    const {
      operation,
      requestType: suppliedRequestType,
      confirmationId,
      stage,
      workerMode,
      clientRole: suppliedClientRole,
      sharedMemoryProbe: suppliedProbe,
      extensionViews: suppliedViews,
      confirmationHandler: suppliedCode,
      pageNavigation: suppliedNavigation,
      consumeVerdict: suppliedConsumeVerdict,
      portReconnected,
      storageOwner: suppliedOwner,
      storageOperation: suppliedStorageOperation,
      userErrorId,
      userErrorSurface: suppliedSurface,
      proposalStep: suppliedStep,
      proposalGuard: suppliedGuard,
      securityChange: suppliedChange,
      completionStep: suppliedCompletionStep,
      completionGuard: suppliedCompletionGuard,
      bridgeBalanceCheck: suppliedBalanceCheck,
      bridgeOrphanCheck: suppliedOrphanCheck,
      bridgeSourceRoute: suppliedSourceRoute,
      guardianSignerInSet: suppliedSignerInSet,
      guardianSigningKey: suppliedSigningKey,
      hotKeyRotationPending: suppliedRotationPending
    } = diagnostics;
    if (!preserveInner && (suppliedStep !== undefined || suppliedCompletionStep !== undefined))
      annotateGuardianProving(error, undefined);
    if (
      !preserveInner &&
      (refreshProposal ||
        (suppliedStep !== undefined && suppliedStep !== 'proposal_create') ||
        suppliedCompletionStep !== undefined)
    )
      clearProposalCreateDiagnostics(error);
    if (operation === 'intercom_request' || operation === 'confirm_payload' || operation === 'sdk_initialize') {
      safe.operation = operation;
    }
    const requestType = requestTypes.find(value => value === suppliedRequestType);
    if (requestType !== undefined) safe.requestType = requestType;
    if (confirmationId === 'missing' || confirmationId === 'empty') safe.confirmationId = confirmationId;
    if (stage === 'wasm_ready' || stage === 'mock_import' || stage === 'mock_create' || stage === 'client_create')
      safe.stage = stage;
    if (workerMode === 'enabled' || workerMode === 'disabled') safe.workerMode = workerMode;
    if (
      operation === 'sdk_initialize' &&
      stage === 'client_create' &&
      (suppliedClientRole === 'primary' || suppliedClientRole === 'realm_reader')
    )
      safe.clientRole = suppliedClientRole;
    const sharedMemoryProbe = SHARED_MEMORY_PROBES.find(value => value === suppliedProbe);
    if (sharedMemoryProbe !== undefined) safe.sharedMemoryProbe = sharedMemoryProbe;
    const extensionViews = EXTENSION_VIEW_COUNTS.find(value => value === suppliedViews);
    if (extensionViews !== undefined) safe.extensionViews = extensionViews;
    Object.assign(safe, readConfirmationCode(suppliedCode));
    const pageNavigation = PAGE_NAVIGATIONS.find(value => value === suppliedNavigation);
    if (pageNavigation !== undefined) safe.pageNavigation = pageNavigation;
    const consumeVerdict = CONSUME_VERDICTS.find(value => value === suppliedConsumeVerdict);
    if (consumeVerdict !== undefined) safe.consumeVerdict = consumeVerdict;
    if (typeof portReconnected === 'boolean') safe.portReconnected = portReconnected;
    if (userErrorId !== undefined || suppliedSurface !== undefined)
      annotateUiProducer(error, undefined, undefined, undefined);
    if (isUserErrorId(userErrorId)) safe.userErrorId = userErrorId;
    const userErrorSurface = USER_ERROR_SURFACES.find(surface => surface === suppliedSurface);
    if (userErrorSurface !== undefined) safe.userErrorSurface = userErrorSurface;
    const storageOwner = STORAGE_OWNERS.find(value => value === suppliedOwner);
    const storageOperation = STORAGE_OPERATIONS.find(value => value === suppliedStorageOperation);
    const previous = { ...diagnosticsByError.get(error) };
    if (refreshProposal) {
      delete previous.proposalStep;
      delete previous.proposalGuard;
      delete previous.securityChange;
    }
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
    const startupKeys = ['startupEligibilityStage', 'startupEligibilityReason', 'startupEligibilityRetry'] as const;
    if (startupKeys.some(key => key in diagnostics) || userErrorId !== undefined || suppliedSurface !== undefined) {
      startupKeys.forEach(key => {
        delete previous[key];
      });
      const startupEligibilityStage = STARTUP_ELIGIBILITY_STAGES.find(
        value => value === diagnostics.startupEligibilityStage
      );
      const startupEligibilityReason = STARTUP_ELIGIBILITY_REASONS.find(
        value => value === diagnostics.startupEligibilityReason
      );
      const startupEligibilityRetry = STARTUP_ELIGIBILITY_RETRIES.find(
        value => value === diagnostics.startupEligibilityRetry
      );
      if (
        userErrorId === 'walletAccessUnavailableBody' &&
        userErrorSurface === 'startup' &&
        startupEligibilityStage &&
        startupEligibilityReason &&
        startupEligibilityRetry
      ) {
        Object.assign(safe, { startupEligibilityStage, startupEligibilityReason, startupEligibilityRetry });
      }
    }
    // The innermost boundary names the step first; an outer one it propagates through only knows a broader one.
    const proposalStep = PROPOSAL_STEPS.find(step => step === suppliedStep);
    if (proposalStep !== undefined && previous.proposalStep === undefined) {
      safe.proposalStep = proposalStep;
      const proposalGuard = PROPOSAL_GUARDS.find(guard => guard === suppliedGuard);
      if (proposalGuard !== undefined) safe.proposalGuard = proposalGuard;
      // Only beside proposal creation, and only a listed change. A listed name on any other step is dropped.
      const securityChange = SECURITY_CHANGE_ACTIONS.find(action => action === suppliedChange);
      if (proposalStep === 'proposal_create' && securityChange !== undefined) safe.securityChange = securityChange;
    }
    const completionStep = COMPLETION_STEPS.find(step => step === suppliedCompletionStep);
    if (completionStep !== undefined && previous.completionStep === undefined) {
      safe.completionStep = completionStep;
      const completionGuard = COMPLETION_GUARDS.find(guard => guard === suppliedCompletionGuard);
      if (completionGuard !== undefined) safe.completionGuard = completionGuard;
    }
    const bridgeBalanceCheck = BRIDGE_BALANCE_CHECKS.find(value => value === suppliedBalanceCheck);
    if (bridgeBalanceCheck !== undefined) safe.bridgeBalanceCheck = bridgeBalanceCheck;
    const bridgeOrphanCheck = BRIDGE_ORPHAN_CHECKS.find(value => value === suppliedOrphanCheck);
    if (bridgeOrphanCheck !== undefined) safe.bridgeOrphanCheck = bridgeOrphanCheck;
    const bridgeSourceRoute = BRIDGE_SOURCE_ROUTES.find(value => value === suppliedSourceRoute);
    if (bridgeSourceRoute !== undefined) safe.bridgeSourceRoute = bridgeSourceRoute;
    // The three describe one signing attempt, so a partial set is dropped rather than joined to another's.
    const guardianSignerInSet = GUARDIAN_SIGNER_IN_SET.find(value => value === suppliedSignerInSet);
    const guardianSigningKey = GUARDIAN_SIGNING_KEYS.find(value => value === suppliedSigningKey);
    const hotKeyRotationPending = HOT_KEY_ROTATION_PENDING.find(value => value === suppliedRotationPending);
    if (guardianSignerInSet !== undefined && guardianSigningKey !== undefined && hotKeyRotationPending !== undefined) {
      Object.assign(safe, { guardianSignerInSet, guardianSigningKey, hotKeyRotationPending });
    }
    // A native annotation replaces a request's whole group, including absent optional observations.
    if (nativeKeys.some(key => key in diagnostics)) clearNativeDiagnostics(previous);
    diagnosticsByError.set(error, { ...previous, ...safe, ...nativeDiagnostics(diagnostics) });
  } catch {
    // Reporting cannot change the failure being handled.
  }
}

let proposalInvocation = 0n;
const proposalInvocationByError = new WeakMap<Error, bigint>();

async function annotatingRejection<T>(
  diagnostics: CrashDiagnostics,
  operation: () => Promise<T>,
  onReject?: (error: unknown) => void,
  invocation?: bigint
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    let preserveInner = false;
    let refreshProposal = false;
    try {
      if (invocation !== undefined && error instanceof Error) {
        const previousInvocation = proposalInvocationByError.get(error);
        // An enclosing invocation starts earlier than the leaf that already observed this rejection.
        preserveInner = previousInvocation !== undefined && previousInvocation > invocation;
        if (!preserveInner) {
          proposalInvocationByError.set(error, invocation);
          refreshProposal = onReject !== undefined || snapshotProposalCreateDiagnostics(error) !== undefined;
        }
      }
    } catch {}
    annotateCrashAtBoundary(error, diagnostics, preserveInner, refreshProposal);
    try {
      if (!preserveInner) onReject?.(error);
    } catch {}
    throw error;
  }
}

/**
 * Awaits `operation` and rethrows its rejection unchanged, naming `step` on it unless a step inside already did.
 * `securityChange` is recorded with that step when this boundary is one of the account's own security changes.
 */
export function withProposalStep<T>(
  step: ProposalStep,
  operation: () => Promise<T>,
  securityChange?: SecurityChangeAction,
  onReject?: (error: unknown) => void
): Promise<T> {
  return annotatingRejection(
    securityChange === undefined ? { proposalStep: step } : { proposalStep: step, securityChange },
    operation,
    onReject,
    ++proposalInvocation
  );
}

/** {@link withProposalStep} for the completion of a submitted transaction. */
export function withCompletionStep<T>(step: CompletionStep, operation: () => Promise<T>): Promise<T> {
  return annotatingRejection({ completionStep: step }, operation);
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
  const chain = errorChain(error);
  for (const link of chain.reverse()) {
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
  if (chain.length === 0 && typeof error === 'object' && error !== null)
    Object.assign(snapshot, diagnosticsByError.get(error));
  for (const key of EXECUTION_DIAGNOSTIC_KEYS) delete snapshot[key];
  Object.assign(snapshot, snapshotTransactionExecution(error));
  // Startup evidence belongs to this displayed attempt, never an earlier cause.
  delete snapshot.startupEligibilityStage;
  delete snapshot.startupEligibilityReason;
  delete snapshot.startupEligibilityRetry;
  const startup = typeof error === 'object' && error !== null ? diagnosticsByError.get(error as Error) : undefined;
  if (
    startup?.userErrorId === 'walletAccessUnavailableBody' &&
    startup.userErrorSurface === 'startup' &&
    startup.startupEligibilityStage &&
    startup.startupEligibilityReason &&
    startup.startupEligibilityRetry
  ) {
    snapshot.startupEligibilityStage = startup.startupEligibilityStage;
    snapshot.startupEligibilityReason = startup.startupEligibilityReason;
    snapshot.startupEligibilityRetry = startup.startupEligibilityRetry;
  }
  // A name recorded on proposal creation must not survive onto a later step in the cause chain.
  if (snapshot.proposalStep !== 'proposal_create') delete snapshot.securityChange;
  for (const key of [
    'proofWaitAvailability',
    'proposalCreateApi',
    'proposalCreateFamily',
    'guardianProvingSubstep',
    'offscreenDeadlineMethod',
    'offscreenDeadlineStage',
    'queueAdmissionObservation',
    'queueSighting',
    'preflightSync',
    'queueHidden',
    'reapStartRelation'
  ] as const)
    delete snapshot[key];
  if (snapshot.proposalStep === 'proposal_create') Object.assign(snapshot, snapshotProposalCreateDiagnostics(error));
  Object.assign(snapshot, snapshotGuardianProving(error));
  Object.assign(snapshot, snapshotOffscreenDeadlineForCrash(error));
  Object.assign(snapshot, snapshotTerminalReport(error));
  for (const key of UI_PRODUCER_KEYS) delete snapshot[key];
  const own = typeof error === 'object' && error !== null ? diagnosticsByError.get(error as Error) : undefined;
  Object.assign(snapshot, snapshotUiProducer(error, own?.userErrorId, own?.userErrorSurface));
  const proofWaitAvailability = snapshotProofWaitAvailability(error);
  if (proofWaitAvailability !== undefined) snapshot.proofWaitAvailability = proofWaitAvailability;
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

/** How long a background has run, from `performance.now()`, whose origin in a worker is the worker's start. */
export function backgroundAgeOf(ms: number): BackgroundAge {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 10_000) return 'under_10s';
  if (ms < 60_000) return '10_to_60s';
  if (ms < 300_000) return '60_to_300s';
  return 'over_300s';
}

/** How this page was last loaded, from its navigation timing entry. */
export function readPageNavigation(): PageNavigation {
  try {
    const [entry]: unknown[] = performance.getEntriesByType('navigation');
    const type: unknown = typeof entry === 'object' && entry !== null && 'type' in entry ? entry.type : undefined;
    return PAGE_NAVIGATIONS.find(value => value === type) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
