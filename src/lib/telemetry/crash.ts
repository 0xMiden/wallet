import {
  BrowserClient,
  Scope,
  dedupeIntegration,
  defaultStackParser,
  inboundFiltersIntegration,
  linkedErrorsIntegration,
  makeFetchTransport
} from '@sentry/browser';

import { englishWordlist } from '@miden/hd-key';
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { resolveTelemetryContext } from './context';
import { getCrashBuildIdentity, type CrashBuildIdentity } from './crash-build';
import { snapshotCrashDiagnostics, type CrashDiagnostics } from './crash-diagnostics';
import { sanitizeWalletFrame } from './crash-frames';
import { REDACTED, containsSeedMaterialDeep, redactInPlace, redactMessage, redactText } from './redact';
import {
  RELAY_SERVICE,
  claimRelayRange,
  classifyRelayFailure,
  noteConnectivityChanged,
  type RelayDiagnostics
} from './relay-diagnostics';

/**
 * Consent-gated crash reporting.
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
    // Guarded terminal writes already deduplicate no-ops; separate failed attempts must each be counted.
    if (event.exception?.values?.some(value => value.type === 'WalletTransactionFailure')) return event;
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
  Partial<RelayDiagnostics>;
const capturedDiagnostics = new WeakMap<Error, DiagnosticSnapshot>();
type ReportableFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
};
const capturedFrames = new WeakMap<Error, ReportableFrame[]>();
const capturedClosedNames = new WeakMap<Error, ReadonlySet<string>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreDiagnostics(event: Record<string, unknown>, reportable: Error, diagnostics: DiagnosticSnapshot): void {
  event.extra = { walletDiagnostics: { ...diagnostics } };
  // Also a tag, because Sentry can search and filter by tags but not by extra data.
  event.tags = {
    ...(isRecord(event.tags) ? event.tags : {}),
    network: diagnostics.network,
    ...(diagnostics.service === undefined ? {} : { service: diagnostics.service })
  };
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

/**
 * `beforeSend`. Returns `null` to discard the event entirely.
 *
 * A recovery phrase anywhere in the payload discards the whole report rather
 * than just that field: if a phrase reached one field, the payload has to be
 * treated as contaminated, and a crash report is worth far less than the risk.
 */
export function scrubEvent<T>(event: T, hint?: { originalException?: unknown }): T | null {
  const original = hint?.originalException;
  const closedNames = original instanceof Error ? capturedClosedNames.get(original) : undefined;
  if (containsSeedMaterialDeep(event, WORDLIST, closedNames)) return null;
  redactInPlace(event, WORDLIST, closedNames);
  const diagnostics = original instanceof Error ? capturedDiagnostics.get(original) : undefined;
  if (diagnostics !== undefined && original instanceof Error && isRecord(event))
    restoreDiagnostics(event, original, diagnostics);
  return event;
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
          if (!(await isTelemetryEnabledAsync()) || generation !== reportingGeneration)
            return new Response('', { status: 200 });
          return globalThis.fetch(...args);
        }),
      stackParser: defaultStackParser,
      integrations: buildIntegrations(),
      sendDefaultPii: false,
      release: resolveTelemetryContext().appVersion,
      beforeSend: scrubEvent
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
 * Stop reporting and discard what is buffered. Called when consent is
 * withdrawn, so turning the setting off stops a crash that is already in
 * flight rather than merely stopping the next one.
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
  const safeName = redactText(name, WORDLIST, closedNames);
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
    reportable.cause = rebuildError(cause, seen, depth + 1, closedNames);
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
    /** The reporter's own closed identifiers, which the recovery-phrase guard reads as non-wordlist words if whole. */
    closedNames?: ReadonlySet<string>;
  } = {}
): void {
  try {
    if (!(error instanceof Error)) return;
    // Snapshot before consent's await: later handling may mutate the original failure, and the relay verdict and the
    // report have to describe the same text.
    const fields: ErrorFields = { name: error.name, message: error.message, stack: error.stack };
    const relay = classifyRelayFailure(error, fields.message);
    if (relay?.report === false) return;
    const reportable = relay?.report
      ? rebuildRelayError(fields, relay.message)
      : rebuildError(error, new Set(), 0, options.closedNames, fields);
    if (options.closedNames !== undefined) capturedClosedNames.set(reportable, options.closedNames);
    capturedDiagnostics.set(reportable, {
      ...snapshotCrashDiagnostics(error),
      ...resolveTelemetryContext(),
      ...getCrashBuildIdentity(),
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
        if (!(await isTelemetryEnabledAsync())) return;
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
