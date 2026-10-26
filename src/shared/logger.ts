/**
 * Console-only logger.
 *
 * There used to be a server path here. It has been removed rather than fixed,
 * for three reasons:
 *
 * 1. `sendLogToServer` was an empty stub, so no log line ever actually left the
 *    device — the whole path was dead weight that read as if it shipped data.
 * 2. Its consent gate keyed off `localStorage['analytics']`, the identifier the
 *    removed analytics scaffold left behind, and read
 *    `if (analytics && !analyticsJson.enabled === true) return`. The `analytics &&`
 *    made it fail OPEN: with no key at all — a fresh install, or any install
 *    after `clearLegacyAnalyticsStorage()` deletes it — the gate was skipped
 *    and the code fell through to send. Only the stub transport kept that from
 *    mattering, which is not a property to leave a future implementer relying
 *    on: consent has to fail closed.
 * 3. It scrubbed `APrivateKey…` / `AViewKey…` strings. Those are Aleo key
 *    formats; Miden has neither, so the scrubber matched nothing that this
 *    wallet can produce while looking like real protection.
 *
 * Log egress now has exactly one route, `lib/telemetry`, which gates on the
 * user's recorded consent in the background and never puts a message body on
 * the wire.
 */

/**
 * `meta` is forwarded rather than dropped — a caller that bothers to pass the
 * caught error should see it in the console.
 */
function write(sink: (message: string, meta?: unknown) => void, message: string, meta: unknown): void {
  if (meta === undefined) {
    sink(message);
    return;
  }
  sink(message, meta);
}

class ConsoleLogger {
  info(message: string, meta?: unknown): void {
    write(console.info, message, meta);
  }

  warning(message: string, meta?: unknown): void {
    write(console.warn, message, meta);
  }

  error(message: string, meta?: unknown): void {
    write(console.error, message, meta);
  }
}

export const logger = new ConsoleLogger();
