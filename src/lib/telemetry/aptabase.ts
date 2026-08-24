import {
  TelemetryErrorKind,
  TelemetryFlow,
  TelemetryOperation,
  TelemetryPlatform,
  TelemetryResult,
  TelemetryStep,
  TelemetryWirePayload
} from './types';

/**
 * The Aptabase wire format, and the two places this wallet deliberately
 * departs from how Aptabase's own SDKs fill it in.
 *
 * The policy at `docs/privacy/index.md` names Aptabase as the processor for
 * usage data, so this module is what makes that sentence true. It maps the
 * ten-field allowlisted payload onto Aptabase's envelope and does nothing
 * else — no queueing, no batching, and no network call. The single egress
 * point stays `sink.ts`.
 *
 * **`sessionId` is one run of the app, and `flowId` moved into `props`.** This
 * originally sent the per-flow id as `sessionId`, on the reasoning that an
 * Aptabase "session" carrying one wallet flow is the least linkable thing that
 * could go in a field with that name. It was, and it made the data useless: the
 * dashboard groups by `sessionId`, so every session held one flow, every
 * session duration was 0s, and no session ever described anything a person did.
 * The first build on a real device reported two 0s "sessions" for a swap and
 * could not say that a swap had happened.
 *
 * So `sessionId` now carries `runId` — minted in memory per app run, rotating
 * after idle, never stored (see `report-flow.ts`). A session is a visit again,
 * with a real duration and an ordered list of events. `flowId` moves to `props`
 * so a `started` can still be paired with its `ended`, which is what makes an
 * unmatched `started` readable as an abandonment.
 *
 * What that costs is stated plainly, because it is a real cost: the flows one
 * person performs in one run are linkable to each other. What it does not cost
 * is anything durable — no id survives a reload, nothing identifies a device or
 * an install, and `guarantees.test.ts` asserts this module cannot reach a
 * persistence API at all, so there is nowhere for a longer-lived id to hide.
 *
 * **`systemProps` is a device fingerprint, so it is sent nearly empty.**
 * Aptabase's example envelope carries `osVersion`, `locale` and `deviceModel`.
 * All three are new data and all three are fingerprinting vectors, and none is
 * mandatory — Aptabase's own custom-SDK example omits most of them. What goes
 * out is `appVersion` and `osName`, both of which this wallet already collects
 * and already discloses, plus `isDebug` and a constant naming this transport.
 * Do not add the other three, and do not add code that could compute them.
 */

/**
 * Names this transport to Aptabase, in the `<name>@<version>` form its own
 * SDKs use. Versioned separately from the app so a change to the mapping below
 * is visible on the receiving side.
 */
export const APTABASE_SDK_VERSION = 'miden-wallet-aptabase@1.0.0';

/**
 * `<flow>_<phase>` or `<operation>_settled` — `send_started`, `unlock_ended`,
 * `tx_send_settled`, `service_prover_settled`.
 *
 * Every part is a closed union, so the full set of names is fixed at compile
 * time and no free text can reach the event name. It reads well in an Aptabase
 * dashboard, which lists events by name: the two halves of a flow sort next to
 * each other, the shared suffix groups the starts against the ends, and the
 * wallet's own operations sort together under their `tx_` and `service_`
 * prefixes rather than mixing in among the things a person did.
 */
export type AptabaseEventName = `${TelemetryFlow}_started` | `${TelemetryFlow}_ended` | `${TelemetryOperation}_settled`;

/**
 * Aptabase's `props` is an open object, so the type system cannot do here what
 * it does for `TelemetryWirePayload`. This interface is closed on purpose, and
 * `buildEnvelope` fills it field by field — never by spreading — so the
 * allowlist survives the crossing.
 */
export interface AptabaseProps {
  /**
   * Pairs this event with the other half of its flow. In `props` rather than
   * `sessionId` since the run took that field over — grouping by it inside a
   * session is what turns a list of events back into flows.
   *
   * Optional because a `settled` operation has no pair to join to: the wallet
   * finished the work in one go, and there is deliberately nothing linking it
   * back to the flow that asked for it.
   */
  flowId?: string;
  result?: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs?: number;
  step?: TelemetryStep;
}

export interface AptabaseSystemProps {
  isDebug: boolean;
  /** Our coarse `platform`, which is the only OS-shaped value we collect. */
  osName: TelemetryPlatform;
  appVersion: string;
  sdkVersion: string;
}

export interface AptabaseEnvelope {
  timestamp: string;
  /** The ephemeral per-run id. Never durable — see the module comment. */
  sessionId: string;
  eventName: AptabaseEventName;
  systemProps: AptabaseSystemProps;
  props: AptabaseProps;
}

/**
 * The complete key sets that may appear in an outgoing envelope. Exported so
 * the tests assert against one source of truth per level rather than against
 * lists that drift.
 */
export const APTABASE_ENVELOPE_KEYS: readonly string[] = [
  'timestamp',
  'sessionId',
  'eventName',
  'systemProps',
  'props'
];

export const APTABASE_SYSTEM_PROP_KEYS: readonly string[] = ['isDebug', 'osName', 'appVersion', 'sdkVersion'];

export const APTABASE_PROP_KEYS: readonly string[] = ['flowId', 'result', 'errorKind', 'durationMs', 'step'];

/**
 * Every shape the event name may take. Three lower-case words at most, then the
 * phase.
 *
 * Checked rather than trusted, because this is the one field in the envelope
 * built by *concatenation* rather than by copying an allowlisted value, and so
 * the one place a string can reach the wire without having passed a closed
 * union. Every legitimate caller is typed, but the offscreen document forwards
 * over `chrome.runtime.sendMessage`, which is `unknown` at the wire and which
 * any other installed extension may post to — so "typed at every call site" is
 * not the same as "closed at the boundary".
 *
 * A pattern rather than the enumerated union: the union is already written down
 * three times, and a fourth copy that has to be kept in step by hand is a worse
 * guarantee than a rule that cannot drift. What matters here is that nothing
 * arbitrary lands in a dashboard's event list, and a name is either of this
 * shape or it is not.
 */
const EVENT_NAME_PATTERN = /^[a-z]+(_[a-z]+){0,2}_(started|ended|settled)$/;

/** The event name this payload would be posted under. */
function eventNameOf(payload: TelemetryWirePayload): string {
  return payload.phase === 'settled' ? `${payload.operation}_settled` : `${payload.flow}_${payload.phase}`;
}

/**
 * Whether this payload can be named at all.
 *
 * The gate the sink applies before anything is queued or posted, so a payload
 * that cannot produce a well-formed name never reaches the wire and never
 * reaches the retry queue either. Refusing it outright is the right outcome: an
 * event whose subject cannot be named carries no information, so there is
 * nothing to salvage by guessing a substitute — and a guessed name is worse than
 * no event, because it lands in a dashboard looking like a real one.
 */
export function isNameableEvent(payload: TelemetryWirePayload): boolean {
  // The subject is checked for presence separately, because a missing one
  // stringifies to `undefined` — which is lower-case letters and would sail
  // through the pattern as a perfectly well-formed `undefined_settled`.
  const subject = payload.phase === 'settled' ? payload.operation : payload.flow;
  if (typeof subject !== 'string' || subject.length === 0) return false;
  return EVENT_NAME_PATTERN.test(eventNameOf(payload));
}

/**
 * Map one allowlisted payload onto one Aptabase envelope.
 *
 * Every field is copied by name. This function must never spread the payload,
 * never `Object.assign` it, and never iterate its keys: a field added upstream
 * would otherwise reach `props` without appearing here, which is the failure
 * mode the allowlist exists to prevent and which `yarn ts` can no longer catch
 * on its own once the payload lands in an open object.
 *
 * Each of the eleven allowlisted fields appears exactly once in the result —
 * `phase` with either `flow` or `operation` in `eventName`, `runId` in
 * `sessionId`, `appVersion` and `platform` in `systemProps`, and the remaining
 * five in `props`.
 */
export function buildEnvelope(payload: TelemetryWirePayload, now: Date = new Date()): AptabaseEnvelope {
  const props: AptabaseProps = {};
  if (payload.flowId !== undefined) props.flowId = payload.flowId;
  if (payload.result !== undefined) props.result = payload.result;
  if (payload.errorKind !== undefined) props.errorKind = payload.errorKind;
  if (payload.durationMs !== undefined) props.durationMs = payload.durationMs;
  if (payload.step !== undefined) props.step = payload.step;

  return {
    timestamp: now.toISOString(),
    sessionId: payload.runId,
    eventName: eventNameOf(payload) as AptabaseEventName,
    systemProps: {
      isDebug: process.env.NODE_ENV !== 'production',
      osName: payload.platform,
      appVersion: payload.appVersion,
      sdkVersion: APTABASE_SDK_VERSION
    },
    props
  };
}

export interface AptabaseEndpoint {
  url: string;
  appKey: string;
}

/** The two hosted regions. `DEV` and `SH` have no derivable host of their own. */
const REGION_HOSTS: Readonly<Record<string, string>> = {
  EU: 'https://eu.aptabase.com',
  US: 'https://us.aptabase.com'
};

const APP_KEY_PATTERN = /^A-(EU|US|DEV|SH)-[A-Za-z0-9]+$/;

/**
 * The single-event endpoint, deliberately not `/api/v0/events`.
 *
 * Aptabase accepts up to 25 events per batch, but an MV3 service worker has no
 * guaranteed lifetime, so a batch buffer is a buffer that gets killed with the
 * worker. The bounded queue in `sink.ts` plus one request per event is the
 * choice this design already made.
 */
const EVENT_PATH = '/api/v0/event';

const ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/**
 * Resolve where to POST, or `null` to send nothing.
 *
 * Returning `null` rather than throwing is the contract: telemetry is
 * best-effort and must never fail a wallet operation, so a missing key, a
 * malformed key, a self-hosted key with no host, and a host that is not a URL
 * all disable sending silently. Unset is the default everywhere, which is what
 * keeps an unconfigured build inert.
 *
 * An explicit host wins over the region default for every key, not just
 * `A-SH-*`. Silently ignoring a host somebody set would ship a build pointing
 * somewhere they did not intend, which is a worse surprise than honouring it.
 */
export function resolveAptabaseEndpoint(appKey: string, host: string): AptabaseEndpoint | null {
  const key = appKey.trim();
  const region = APP_KEY_PATTERN.exec(key)?.[1];
  if (region === undefined) return null;

  const configured = host.trim();
  const base = configured === '' ? REGION_HOSTS[region] : configured;
  if (base === undefined) return null;

  let origin: string;
  try {
    const parsed = new URL(base);
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return null;
    origin = parsed.origin;
  } catch {
    return null;
  }

  return { url: `${origin}${EVENT_PATH}`, appKey: key };
}

/**
 * The build-time configuration, read at call time so an unset key disables
 * sending rather than baking a decision in at module load.
 */
export function aptabaseEndpointFromEnv(): AptabaseEndpoint | null {
  return resolveAptabaseEndpoint(process.env.APTABASE_APP_KEY ?? '', process.env.APTABASE_HOST ?? '');
}
