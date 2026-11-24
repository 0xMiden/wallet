import {
  BrowserClient,
  Scope,
  dedupeIntegration,
  defaultStackParser,
  getGlobalScope,
  getIsolationScope,
  inboundFiltersIntegration,
  linkedErrorsIntegration,
  logger,
  makeFetchTransport
} from '@sentry/browser';

import { englishWordlist } from '@miden/hd-key';
import { isCrashReportingEnabledAsync } from 'lib/settings/helpers';

import { resolveTelemetryContext } from './context';
import { getCrashBuildIdentity, type CrashBuildIdentity } from './crash-build';
import {
  readPageVisibility,
  snapshotCrashDiagnostics,
  type CrashDiagnostics,
  type PageVisibility
} from './crash-diagnostics';
import { sanitizeWalletFrame } from './crash-frames';
import { isClosedDiagnosticLog } from './diagnostic-log-contract';
import { REDACTED, containsSeedMaterialDeep, redactInPlace, redactMessage, redactText } from './redact';
import {
  RELAY_SERVICE,
  claimRelayRange,
  classifyRelayFailure,
  noteConnectivityChanged,
  type RelayDiagnostics
} from './relay-diagnostics';

/**
 * Crash reporting gated only by the browser's data-collection permission,
 * independently of the wallet's usage-data choice.
 *
 * Three deliberate departures from the way Sentry is normally set up, each one
 * a constraint of shipping inside an MV3 extension that holds keys:
 *
 * 1. **No `Sentry.init()`, and no namespace import.** `init` installs a client
 *    on global state that an extension shares with whatever else is running,
 *    so events can cross between us and a host page's own Sentry project. A
 *    wildcard namespace import of the SDK also defeats tree-shaking and drags
 *    the whole thing into the bundle, including the integrations excluded
 *    below — which has previously gotten an extension rejected from the Chrome
 *    Web Store under MV3's remote-code rule. Granular named imports plus a
 *    hand-built client and scope avoid both. A build requirement, not a style
 *    preference.
 *
 * 2. **Integrations are an allowlist, not a denylist.** See
 *    `CRASH_INTEGRATION_ALLOWLIST`.
 *
 * 3. **Scrubbing happens twice.** `scrubEvent` is wired as `beforeSend`, and
 *    `captureCrash` independently rebuilds the error from redacted parts before
 *    the scope ever sees it. A hook is a wire that can come loose; the message
 *    and stack are scrubbed whether or not it is connected.
 */

/**
 * The only integrations allowed to run.
 *
 * - `Dedupe` compares an event against the previous one in memory. No globals,
 *   no DOM, no network — and duplicate crash storms stop being duplicate
 *   egress.
 * - `LinkedErrors` walks `error.cause` and appends each link as another
 *   `exception.values` entry. Errors are wrapped at nearly every layer here, so
 *   the chain is the diagnosis; `scrubEvent` walks every value, so the chain is
 *   scrubbed as thoroughly as the outermost error.
 * - `InboundFilters` drops known-noise events against static config. A pure
 *   predicate, and it reduces egress.
 *
 * Everything else in the default set is excluded:
 *
 * - `Breadcrumbs` auto-captures console output, every fetch/XHR URL, DOM click
 *   targets, and history changes. That is a direct pipe for addresses,
 *   amounts, and RPC URLs into the payload — the largest leak vector Sentry
 *   ships by default.
 * - `BrowserApiErrors` (formerly `TryCatch`) wraps `setTimeout`,
 *   `setInterval`, `requestAnimationFrame` and `EventTarget.addEventListener`
 *   globally. Prototype instrumentation of shared objects, and it reads as
 *   remote-code injection under MV3 review.
 * - `GlobalHandlers` installs `window.onerror` / `onunhandledrejection`. There
 *   is no `window` in the service worker, and taking over the page's global
 *   handlers is exactly the global-state pollution point 1 avoids. The cost is
 *   that we register those handlers ourselves, below.
 * - `HttpContext` reads `window.location.href`, `document.referrer` and the
 *   browser's user-agent string into every event. URL plus user agent is PII we
 *   have committed never to send. (Named in prose rather than in code, so the
 *   fingerprinting-capability guard in `guarantees.test.ts` can be strict.)
 * - `CultureContext` reads locale and timezone. Fingerprinting surface, no
 *   diagnostic value.
 * - `FunctionToString` monkey-patches `Function.prototype.toString`. It exists
 *   to make SDK-wrapped functions print normally, and we do no wrapping.
 * - `ConversationId` attaches an identifier that persists across events — the
 *   same kind of durable id the legacy analytics cleanup exists to delete.
 * - `BrowserSession` emits session start/end pings independently of any crash,
 *   which is background egress on a timer rather than one auditable decision
 *   per crash.
 *
 * An allowlist rather than a denylist because a denylist admits whatever the
 * SDK adds next: `ConversationId` arrived in v10 and would have been admitted
 * silently by a list that only named the integrations known to be bad.
 */
export const CRASH_INTEGRATION_ALLOWLIST: readonly string[] = ['InboundFilters', 'LinkedErrors', 'Dedupe'];

interface NamedIntegration {
  name: string;
}

export function selectIntegrations<T extends NamedIntegration>(integrations: T[]): T[] {
  return integrations.filter(integration => CRASH_INTEGRATION_ALLOWLIST.includes(integration.name));
}

/**
 * The three are constructed directly rather than filtered out of
 * `getDefaultIntegrations()`, because that helper *references* every default
 * integration and so drags all of them into the bundle even though the filter
 * would stop them running. Measured on this tree: 28.5 KB gzipped via
 * `getDefaultIntegrations`, 20.9 KB constructing the three directly — and,
 * more to the point, `GlobalHandlers`, `HttpContext` and `BrowserSession`
 * disappear from the shipped artifact entirely rather than sitting there dead
 * for a store reviewer to find. `selectIntegrations` still runs over the
 * result, so the allowlist stays an enforced invariant and not a comment.
 */
function buildIntegrations() {
  const dedupe = dedupeIntegration();
  const processEvent = dedupe.processEvent;
  dedupe.processEvent = (event, hint, activeClient) => {
    // Terminal writes and user-visible reports apply their own limits; each accepted report must be counted.
    if (
      event.exception?.values?.some(
        value => value.type === 'WalletTransactionFailure' || value.type === 'WalletUserVisibleError'
      )
    )
      return event;
    // A relay report is sent once per failure bucket of its window, and repeats the last one's text and frames.
    const original = hint.originalException;
    if (original instanceof Error && capturedDiagnostics.get(original)?.service === RELAY_SERVICE) return event;
    return processEvent ? processEvent(event, hint, activeClient) : event;
  };
  return selectIntegrations([inboundFiltersIntegration(), linkedErrorsIntegration(), dedupe]);
}

const WORDLIST: readonly string[] = englishWordlist;

/**
 * A V8 frame (`    at fn (file:1:2)`) or a SpiderMonkey/JSC one
 * (`fn@file:1:2`). Everything above the first frame is the header, which
 * carries the raw message and is rebuilt rather than scrubbed.
 */
const STACK_FRAME_PATTERN = /^\s*at\s|^[^@\n]*@(?:.+:\d+:\d+|\[wasm code\]|\[native code\])$/;

function framesAfterHeader(name: string, message: string, stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const header = message.length > 0 ? `${name}: ${message}` : name;
  if (stack === header) return '';
  if (stack.startsWith(`${header}\n`)) return stack.slice(header.length + 1);
  const first = stack.split('\n', 1)[0] ?? '';
  // A mismatched header may contain frame-looking user input, not compiled positions.
  if (/^[^@\n]+:\s/.test(first) || !STACK_FRAME_PATTERN.test(first)) return undefined;
  return stack;
}

/**
 * Rebuild a stack from redacted parts. The header is discarded outright: it
 * repeats `error.message` verbatim, so scrubbing it by pattern would leak
 * anything the pattern rules cannot see, such as a password.
 */
function reportableStack(name: string, safeMessage: string, stack: string | undefined): string {
  const header = `${name}: ${safeMessage}`;
  if (stack === undefined || stack.length === 0) return header;

  const lines = stack.split('\n');
  const firstFrame = lines.findIndex(line => STACK_FRAME_PATTERN.test(line));
  if (firstFrame === -1) return header;

  return [header, ...lines.slice(firstFrame).map(line => redactText(line, WORDLIST))].join('\n');
}

type CrashSource = 'manual' | 'react' | 'onerror' | 'onunhandledrejection';
type DiagnosticSnapshot = CrashDiagnostics &
  ReturnType<typeof resolveTelemetryContext> &
  CrashBuildIdentity &
  Partial<RelayDiagnostics> & { pageVisibility: PageVisibility };
const capturedDiagnostics = new WeakMap<Error, DiagnosticSnapshot>();
type ReportableFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
};
const capturedFrames = new WeakMap<Error, ReportableFrame[]>();
const capturedClosedReports = new WeakMap<Error, Readonly<Pick<Error, 'name' | 'message'>>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closedReportValue(event: unknown, original: unknown): Record<string, unknown> | undefined {
  const captured = original instanceof Error ? capturedClosedReports.get(original) : undefined;
  if (captured === undefined || !isRecord(event) || !isRecord(event.exception)) return undefined;
  const values = event.exception.values;
  if (!Array.isArray(values)) return undefined;
  const value: unknown = values[values.length - 1];
  return isRecord(value) && value.type === captured.name && value.value === captured.message ? value : undefined;
}

function restoreDiagnostics(event: Record<string, unknown>, reportable: Error, diagnostics: DiagnosticSnapshot): void {
  const { authObservation, authArgPresence, authLayout, accountAuthCode, ...other } = diagnostics;
  event.extra = {
    walletDiagnostics: {
      ...other,
      ...(authObservation === undefined ? {} : { executionObservation: authObservation }),
      ...(authArgPresence === undefined ? {} : { executionArguments: authArgPresence }),
      ...(authLayout === undefined ? {} : { executionLayout: authLayout }),
      ...(accountAuthCode === undefined ? {} : { accountCodeFamily: accountAuthCode })
    }
  };
  const tags = isRecord(event.tags) ? { ...event.tags } : {};
  delete tags.reown_native_origin;
  delete tags.reown_wallet_response_code;
  delete tags.reown_request_age;
  delete tags.reown_published;
  delete tags.reown_backgrounded;
  // Also a tag, because Sentry can search and filter by tags but not by extra data.
  event.tags = {
    ...tags,
    network: diagnostics.network,
    ...(diagnostics.storageOwner === undefined ? {} : { storage_owner: diagnostics.storageOwner }),
    ...(diagnostics.storageOperation === undefined ? {} : { storage_operation: diagnostics.storageOperation }),
    ...(diagnostics.clientRole === undefined ? {} : { sdk_client_role: diagnostics.clientRole }),
    ...(diagnostics.service === undefined ? {} : { service: diagnostics.service }),
    ...(diagnostics.userErrorId === undefined ? {} : { 'user_error.id': diagnostics.userErrorId }),
    ...(diagnostics.userErrorSurface === undefined ? {} : { 'user_error.surface': diagnostics.userErrorSurface }),
    ...(diagnostics.reownNativeOrigin === undefined ? {} : { reown_native_origin: diagnostics.reownNativeOrigin }),
    ...(diagnostics.reownWalletResponseCode === undefined
      ? {}
      : { reown_wallet_response_code: diagnostics.reownWalletResponseCode }),
    ...(diagnostics.reownRequestAge === undefined ? {} : { reown_request_age: diagnostics.reownRequestAge }),
    ...(diagnostics.reownPublished === undefined ? {} : { reown_published: diagnostics.reownPublished }),
    ...(diagnostics.reownBackgrounded === undefined ? {} : { reown_backgrounded: diagnostics.reownBackgrounded })
  };
  if (
    reportable.name === 'WalletUserVisibleError' &&
    diagnostics.userErrorId !== undefined &&
    diagnostics.userErrorSurface !== undefined
  ) {
    event.fingerprint = ['WalletUserVisibleError', diagnostics.userErrorId, diagnostics.userErrorSurface];
  }
  const exception = event.exception;
  if (!isRecord(exception) || !Array.isArray(exception.values)) return;
  let link: unknown = reportable;
  for (let index = exception.values.length - 1; index >= 0 && link instanceof Error; index--) {
    const value: unknown = exception.values[index];
    const frames = capturedFrames.get(link);
    // An empty snapshot overrides frames parsed from a multiline error message.
    if (isRecord(value) && frames !== undefined) {
      value.stacktrace = { frames: frames.map(frame => ({ ...frame })) };
    }
    link = link.cause;
  }
}

const TRACE_ID_FORMATS: Readonly<Record<string, RegExp>> = {
  trace_id: /^[0-9a-f]{32}$/,
  span_id: /^[0-9a-f]{16}$/,
  parent_span_id: /^[0-9a-f]{16}$/
};

/**
 * The trace ids of this client's own scope, which the hex rule would otherwise erase and with them the link to the
 * run's records. A `trace` context set on a shared scope replaces the SDK's, so only a value equal to the scope's
 * propagation context counts; a span id the SDK mints per event cannot be told from a foreign one and stays redacted.
 */
function sdkTraceIds(event: unknown): Record<string, string> {
  const trace = isRecord(event) && isRecord(event.contexts) ? event.contexts.trace : undefined;
  if (!isRecord(trace) || typeof scope?.getPropagationContext !== 'function') return {};
  const own = scope.getPropagationContext();
  const expected: Record<string, unknown> = {
    trace_id: own.traceId,
    span_id: own.propagationSpanId,
    parent_span_id: own.parentSpanId
  };
  return Object.fromEntries(
    Object.entries(TRACE_ID_FORMATS).flatMap(([key, format]) => {
      const value = trace[key];
      return typeof value === 'string' && format.test(value) && value === expected[key] ? [[key, value]] : [];
    })
  );
}

/**
 * `beforeSend`. Returns `null` to discard the event entirely.
 *
 * A recovery phrase anywhere in the payload discards the whole report rather
 * than just that field: if a phrase reached one field, the payload has to be
 * treated as contaminated, and a crash report is worth far less than the risk.
 */
export function scrubEvent<T>(event: T, hint?: { originalException?: unknown }): T | null {
  const original = hint?.originalException;
  const fixedValue = closedReportValue(event, original);
  const fixedMessage = fixedValue?.value;
  const traceIds = sdkTraceIds(event);
  try {
    // Only the identity-bound fixed exception text is exempt; SDK-added text always uses the full phrase guard.
    if (fixedValue !== undefined) fixedValue.value = REDACTED;
    if (containsSeedMaterialDeep(event, WORDLIST)) return null;
    redactInPlace(event, WORDLIST);
  } finally {
    if (fixedValue !== undefined) fixedValue.value = fixedMessage;
  }
  if (Object.keys(traceIds).length > 0 && isRecord(event) && isRecord(event.contexts) && isRecord(event.contexts.trace))
    Object.assign(event.contexts.trace, traceIds);
  const diagnostics = original instanceof Error ? capturedDiagnostics.get(original) : undefined;
  if (diagnostics !== undefined && original instanceof Error && isRecord(event))
    restoreDiagnostics(event, original, diagnostics);
  return event;
}

/** The record `captureDiagnosticLog` is emitting; `scrubLog` admits nothing else. */
let pendingLog: { message: string; attributes: Readonly<Record<string, string>> } | null = null;

/**
 * `beforeSendLog`. Rebuilds the log from the record in flight, keeping of what the SDK added only the release, so
 * scope users, SDK names and any attribute a future SDK version adds before this hook never reach the wire.
 */
export function scrubLog<T extends { message: unknown; attributes?: Record<string, unknown> }>(log: T): T | null {
  const record = pendingLog;
  if (record === null || log.message !== record.message) return null;
  const release = log.attributes?.['sentry.release'];
  return {
    ...log,
    message: record.message,
    attributes: { ...record.attributes, ...(typeof release === 'string' ? { 'sentry.release': release } : {}) }
  };
}

function hasScopeAttributes(target: Scope): boolean {
  // The SDK merges scope attributes into a log AFTER `beforeSendLog`, so a record is sent only while none exist.
  return [getGlobalScope(), getIsolationScope(), target].some(
    candidate => Object.keys(candidate.getScopeData().attributes ?? {}).length > 0
  );
}

let scope: Scope | null = null;
let client: BrowserClient | null = null;
let reportingGeneration = 0;
let listenersInstalled = false;

const onGlobalError = (event: ErrorEvent) => captureCrash(event.error, 'onerror');
const onUnhandledRejection = (event: PromiseRejectionEvent) => captureCrash(event.reason, 'onunhandledrejection');

function installCrashListeners(): void {
  if (listenersInstalled || typeof globalThis.addEventListener !== 'function') return;
  globalThis.addEventListener('error', onGlobalError);
  globalThis.addEventListener('unhandledrejection', onUnhandledRejection);
  globalThis.addEventListener('online', noteConnectivityChanged);
  globalThis.addEventListener('offline', noteConnectivityChanged);
  listenersInstalled = true;
}

export function initCrashReporting(options: { listenToGlobals?: boolean } = {}): void {
  if (client !== null) {
    if (options.listenToGlobals !== false) installCrashListeners();
    return;
  }
  try {
    const generation = reportingGeneration;
    const created = new BrowserClient({
      dsn: process.env.SENTRY_DSN ?? '',
      transport: options =>
        makeFetchTransport(options, async (...args) => {
          if (!(await isCrashReportingEnabledAsync()) || generation !== reportingGeneration)
            return new Response('', { status: 200 });
          return globalThis.fetch(...args);
        }),
      stackParser: defaultStackParser,
      integrations: buildIntegrations(),
      sendDefaultPii: false,
      release: resolveTelemetryContext().appVersion,
      beforeSend: scrubEvent,
      enableLogs: true,
      beforeSendLog: scrubLog
    });

    const createdScope = new Scope();
    createdScope.setClient(created);
    created.init();

    client = created;
    scope = createdScope;

    // `GlobalHandlers` is excluded, so these are ours to register.
    if (options.listenToGlobals !== false) installCrashListeners();
  } catch {
    // Crash reporting must never keep the wallet from starting.
  }
}

/**
 * Stop reporting and discard what is buffered. The generation check also
 * invalidates captures and transport sends waiting on browser permission.
 */
export function stopCrashReporting(): void {
  const closing = client;
  scope = null;
  client = null;
  reportingGeneration++;
  try {
    if (listenersInstalled) {
      globalThis.removeEventListener('error', onGlobalError);
      globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
      globalThis.removeEventListener('online', noteConnectivityChanged);
      globalThis.removeEventListener('offline', noteConnectivityChanged);
    }
  } catch {
    // Best-effort.
  } finally {
    listenersInstalled = false;
    try {
      if (closing !== null) void Promise.resolve(closing.close(0)).catch(() => {});
    } catch {
      // Closing a telemetry client must not affect the wallet.
    }
  }
}

/** A failure's own name, message and stack, read once so that every reader of one capture sees the same text. */
type ErrorFields = Pick<Error, 'name' | 'message' | 'stack'>;

function rebuildError(
  error: Error,
  seen: Set<Error>,
  depth: number,
  closedNames?: ReadonlySet<string>,
  fields: ErrorFields = error
): Error {
  seen.add(error);
  const { name, message, stack } = fields;
  const safeName = redactText(name, WORDLIST);
  const safeMessage = redactMessage(message, WORDLIST, closedNames) ?? REDACTED;
  const frames = framesAfterHeader(name, message, stack);
  const reportable = new Error(safeMessage);
  reportable.name = safeName;
  reportable.stack = reportableStack(safeName, safeMessage, frames);
  const parsed = defaultStackParser(frames ?? '');
  if (Array.isArray(parsed)) {
    capturedFrames.set(
      reportable,
      parsed.map(frame => {
        const safe: ReportableFrame = sanitizeWalletFrame(frame.filename, frame.lineno, frame.colno) ?? {};
        if (safe.filename === undefined && typeof frame.filename === 'string') {
          safe.filename = '[unvalidated]';
        }
        if (typeof frame.function === 'string') safe.function = redactText(frame.function, WORDLIST);
        return safe;
      })
    );
  }
  let cause: unknown;
  try {
    cause = error.cause;
  } catch {
    /* Ignore hostile cause accessors. */
  }
  if (cause instanceof Error && depth < 3 && !seen.has(cause)) {
    reportable.cause = rebuildError(cause, seen, depth + 1);
  }
  return reportable;
}

/**
 * A relay report keeps the failure's own frames under WalletConnect's fixed name and text, and neither the failure's
 * name nor any of its causes, which are free text.
 */
function rebuildRelayError(failure: ErrorFields, message: string): Error {
  const relay = new Error(message);
  relay.name = 'Error';
  const frames = framesAfterHeader(failure.name, failure.message, failure.stack);
  relay.stack = frames && `${relay.name}: ${message}\n${frames}`;
  return rebuildError(relay, new Set(), 0);
}

export function captureCrash(
  error: unknown,
  source: CrashSource = 'manual',
  options: {
    initializeIfNeeded?: boolean;
    level?: 'error' | 'warning';
    /** Closed identifiers used only to rebuild the fixed report message, never arbitrary SDK-added event fields. */
    closedNames?: ReadonlySet<string>;
  } = {}
): void {
  try {
    if (!(error instanceof Error)) return;
    // Snapshot before permission's await: later handling may mutate the original failure, and the relay verdict and the
    // report have to describe the same text.
    const fields: ErrorFields = { name: error.name, message: error.message, stack: error.stack };
    const relay = classifyRelayFailure(error, fields.message);
    if (relay?.report === false) return;
    const reportable = relay?.report
      ? rebuildRelayError(fields, relay.message)
      : rebuildError(error, new Set(), 0, options.closedNames, fields);
    if (options.closedNames !== undefined)
      capturedClosedReports.set(reportable, { name: reportable.name, message: reportable.message });
    capturedDiagnostics.set(reportable, {
      ...snapshotCrashDiagnostics(error),
      ...resolveTelemetryContext(),
      ...getCrashBuildIdentity(),
      pageVisibility: readPageVisibility(),
      ...(relay?.report ? relay.diagnostics : {})
    });
    // WalletConnect retries a failed relay on its own, so the failure is a warning however it surfaced.
    const level = relay?.report ? 'warning' : options.level;
    const mechanism =
      source === 'onerror' || source === 'onunhandledrejection'
        ? { type: source, handled: false }
        : { type: source === 'react' ? 'react' : 'generic', handled: true };
    const reportingClient = client;
    const generation = reportingGeneration;
    void (async () => {
      try {
        if (!(await isCrashReportingEnabledAsync())) return;
        if (generation !== reportingGeneration) return;
        if (options.initializeIfNeeded && client === null) initCrashReporting({ listenToGlobals: false });
        const target = scope;
        if (
          target === null ||
          ((!options.initializeIfNeeded || reportingClient !== null) && client !== reportingClient)
        )
          return;
        // Last, so a report dropped by any check above leaves its range to the next failure in it.
        if (relay?.report && !claimRelayRange(relay.diagnostics.relayFailures)) return;
        target.captureException(reportable, {
          mechanism,
          ...(level === undefined ? {} : { captureContext: { level } })
        });
      } catch {
        // Best-effort: telemetry must not be able to fail a wallet operation.
      }
    })();
  } catch {
    // A malformed error must not prevent the wallet from handling its failure.
  }
}

/**
 * Send one diagnostic record as a Sentry log, under the same permission and lifetime as crash reports. Only
 * `diagnostic-log.ts` calls this; a record outside its closed vocabulary is dropped here as well.
 */
export function captureDiagnosticLog(message: string, attributes: Readonly<Record<string, string>>): void {
  try {
    if (!isClosedDiagnosticLog(message, attributes)) return;
    const record = { message, attributes: { ...attributes } };
    const generation = reportingGeneration;
    void (async () => {
      try {
        if (!(await isCrashReportingEnabledAsync())) return;
        if (generation !== reportingGeneration) return;
        if (client === null) initCrashReporting({ listenToGlobals: false });
        const target = scope;
        if (target === null || hasScopeAttributes(target)) return;
        pendingLog = record;
        try {
          logger.info(record.message, record.attributes, { scope: target });
        } finally {
          pendingLog = null;
        }
      } catch {
        // Best-effort: diagnostics must not be able to fail a wallet operation.
      }
    })();
  } catch {
    // A malformed record must not reach the operation it describes.
  }
}
