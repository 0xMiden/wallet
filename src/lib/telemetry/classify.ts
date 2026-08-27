import { TelemetryErrorKind } from './types';

/**
 * Map an error to a broad category. The message is inspected but NEVER
 * returned — the return type is a closed union, so no caught text can reach
 * the wire through this function.
 *
 * Its own module so the transaction pipeline can reach it. The pipeline runs
 * inside the service worker on the extension, and `report-flow.ts` — where this
 * used to live — imports the intercom client and through it React, which the
 * worker cannot load.
 *
 * The order is deliberate: `timeout` precedes `network` because a timeout
 * message routinely contains both words, and `validation` comes last because
 * `invalid` appears inside many more specific messages.
 */
export function classifyError(error: unknown): TelemetryErrorKind {
  const message = messageOf(error);
  if (message === null) return 'unknown';

  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('failed to fetch') || message.includes('network')) return 'network';
  if (message.includes('rpc')) return 'rpc';
  if (message.includes('prov')) return 'proving';
  if (message.includes('quota') || message.includes('store') || message.includes('indexeddb')) return 'storage';
  if (message.includes('password') || message.includes('unauthor') || message.includes('biometric')) return 'auth';
  if (message.includes('invalid') || message.includes('must be') || message.includes('required')) return 'validation';
  return 'unknown';
}

/**
 * The text to classify, lowercased, or `null` when there is nothing to read.
 *
 * A bare `string` is accepted as well as an `Error` because the transaction
 * pipeline stores its failure reason as a string on the row and classifies it
 * later, by which point the `Error` it came from is long gone. Everything else —
 * a thrown object, a number, `undefined` — is `unknown` rather than coerced,
 * since `String(value)` on an arbitrary throw is exactly the kind of free-form
 * text this module exists to keep off the wire.
 */
function messageOf(error: unknown): string | null {
  if (typeof error === 'string') return error.toLowerCase();
  if (error instanceof Error) return error.message.toLowerCase();
  return null;
}
