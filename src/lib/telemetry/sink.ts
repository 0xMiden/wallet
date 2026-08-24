import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { aptabaseEndpointFromEnv, buildEnvelope, isNameableEvent } from './aptabase';
import { serializeEvent } from './serialize';
import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

/**
 * The ONLY telemetry egress point in the wallet.
 *
 * Nothing in `src/` may make a telemetry network request outside this module,
 * and this module runs in the background service worker. That is what makes the
 * consent gate a single auditable check rather than a discipline applied at
 * every call site, and what lets the E2E egress test assert against one
 * boundary instead of thirty.
 */

/** Bounded so an offline device cannot grow the queue without limit. */
const QUEUE_CAPACITY = 50;

type Transport = (payload: TelemetryWirePayload) => Promise<void>;

let queue: TelemetryWirePayload[] = [];
let transportOverride: Transport | null = null;

/**
 * POST one event to Aptabase, or nothing at all when it is not configured.
 *
 * One request per event, never the 25-event batch endpoint: an MV3 service
 * worker has no guaranteed lifetime, so a batch buffer is a buffer that gets
 * killed with the worker. `credentials: 'omit'` matches what Aptabase's own web
 * SDK sends, and means no cookie can ride along and turn a stateless POST into
 * something that identifies a browser.
 */
async function defaultTransport(payload: TelemetryWirePayload): Promise<void> {
  const endpoint = aptabaseEndpointFromEnv();
  // Unconfigured, or configured wrongly. Sending nothing is the correct
  // outcome and must not read as a failure — this path is best-effort.
  if (endpoint === null) return;

  await fetch(endpoint.url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'App-Key': endpoint.appKey },
    body: JSON.stringify(buildEnvelope(payload))
  });
}

/**
 * Consent-gate, serialize, and send one event. Never throws and never rejects:
 * telemetry must not be able to fail a wallet operation.
 */
export async function sendEvent(event: TelemetryEvent, context: TelemetryContext): Promise<void> {
  try {
    if (!(await isTelemetryEnabledAsync())) return;

    const payload = serializeEvent(event, context);
    // The one thing the allowlist cannot check. Every field the serializer
    // copies is either a closed union at the type level or discarded, but the
    // event NAME is built by joining two of them, so a caller that did not
    // typecheck can put an arbitrary string in a dashboard's event list. Every
    // legitimate caller is typed; the offscreen document's forward is not,
    // arriving over `chrome.runtime.sendMessage` as `unknown` from a channel any
    // installed extension may post to. Refused before the queue as well as
    // before the request, so a malformed event cannot sit in the retry buffer.
    if (!isNameableEvent(payload)) return;
    queue.push(payload);
    while (queue.length > QUEUE_CAPACITY) queue.shift();

    const transport = transportOverride ?? defaultTransport;
    await transport(payload);
    queue = queue.filter(queued => queued !== payload);
  } catch {
    // Best-effort by design.
  }
}

/**
 * Discard everything pending. Called when consent is withdrawn, so turning the
 * setting off stops in-flight sharing rather than merely stopping new events.
 */
export function dropQueue(): void {
  queue = [];
}

/** Test-only: substitute the transport. */
export function __setTransportForTest(transport: Transport | null): void {
  transportOverride = transport;
}

/** Test-only: current queue depth. */
export function __getQueueLengthForTest(): number {
  return queue.length;
}
