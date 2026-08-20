import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

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

async function defaultTransport(payload: TelemetryWirePayload): Promise<void> {
  await fetch(process.env.TELEMETRY_INGEST_URL ?? '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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
