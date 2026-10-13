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
  return selectIntegrations([inboundFiltersIntegration(), linkedErrorsIntegration(), dedupeIntegration()]);
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
type DiagnosticSnapshot = CrashDiagnostics & ReturnType<typeof resolveTelemetryContext> & CrashBuildIdentity;
const capturedDiagnostics = new WeakMap<Error, DiagnosticSnapshot>();
type ReportableFrame = {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
};
const capturedFrames = new WeakMap<Error, ReportableFrame[]>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreDiagnostics(event: Record<string, unknown>, reportable: Error, diagnostics: DiagnosticSnapshot): void {
  event.extra = { walletDiagnostics: { ...diagnostics } };
  const exception = event.exception;
  if (!isRecord(exception) || !Array.isArray(exception.values)) return;
  let link: unknown = reportable;
  for (let index = exception.values.length - 1; index >= 0 && link instanceof Error; index--) {
    const value: unknown = exception.values[index];
    const frames = capturedFrames.get(link);
    if (isRecord(value) && frames !== undefined && frames.length > 0) {
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
  if (containsSeedMaterialDeep(event, WORDLIST)) return null;
  redactInPlace(event, WORDLIST);
  const original = hint?.originalException;
  const diagnostics = original instanceof Error ? capturedDiagnostics.get(original) : undefined;
  if (diagnostics !== undefined && original instanceof Error && isRecord(event))
    restoreDiagnostics(event, original, diagnostics);
  return event;
}

let scope: Scope | null = null;
let client: BrowserClient | null = null;

const onGlobalError = (event: ErrorEvent) => captureCrash(event.error, 'onerror');
const onUnhandledRejection = (event: PromiseRejectionEvent) => captureCrash(event.reason, 'onunhandledrejection');

export function initCrashReporting(): void {
  try {
    const created = new BrowserClient({
      dsn: process.env.SENTRY_DSN ?? '',
      transport: makeFetchTransport,
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
    globalThis.addEventListener('error', onGlobalError);
    globalThis.addEventListener('unhandledrejection', onUnhandledRejection);
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
  try {
    globalThis.removeEventListener('error', onGlobalError);
    globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
    if (closing !== null) void closing.close(0);
  } catch {
    // Best-effort.
  }
}

function rebuildError(error: Error, seen: Set<Error>, depth: number): Error {
  seen.add(error);
  const { name, message, stack } = error;
  const safeName = redactText(name, WORDLIST);
  const safeMessage = redactMessage(message, WORDLIST) ?? REDACTED;
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

export function captureCrash(error: unknown, source: CrashSource = 'manual'): void {
  try {
    if (!(error instanceof Error)) return;
    // Snapshot before consent's await: later handling may mutate the original failure.
    const reportable = rebuildError(error, new Set(), 0);
    capturedDiagnostics.set(reportable, {
      ...snapshotCrashDiagnostics(error),
      ...resolveTelemetryContext(),
      ...getCrashBuildIdentity()
    });
    const mechanism =
      source === 'onerror' || source === 'onunhandledrejection'
        ? { type: source, handled: false }
        : { type: source === 'react' ? 'react' : 'generic', handled: true };
    const reportingClient = client;
    void (async () => {
      try {
        if (!(await isTelemetryEnabledAsync())) return;
        const target = scope;
        if (target === null || client !== reportingClient) return;
        target.captureException(reportable, { mechanism });
      } catch {
        // Best-effort: telemetry must not be able to fail a wallet operation.
      }
    })();
  } catch {
    // A malformed error must not prevent the wallet from handling its failure.
  }
}
