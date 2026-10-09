import { errorMessageParts, isKilledPipeline } from '../sdk/sdk-error-code';

/** What a failed push says about what to do next; see {@link classifyRelayFailure}. */
export type RelayFailureClass = 'notConfigured' | 'interrupted' | 'outage' | 'storeLoss' | 'noteLocal';

/** gRPC codes for which the request itself, not the transport, is at fault. */
const NOTE_LOCAL_CODES = ['InvalidArgument', 'FailedPrecondition'];

/**
 * Classify a failed push by what it means for this note, this row and the rest of the
 * pass. Pure: it reads only the error.
 *
 * - `notConfigured`: the client has no transport (`NoteTransportError::Disabled`). No
 *   push can work, so none is made and nothing is spent; receipts still run.
 * - `interrupted`: the call was torn down from outside (a lock eviction poisoning the
 *   client or an offscreen kill, either of which may still be running, or a terminated
 *   client), so the pass stops, nothing is spent or recorded, and the row only moves to
 *   its next step.
 * - `storeLoss`: this client's store has no relayable copy of the note (a restore into
 *   a fresh store, a reinstall, a raze, or a record with no details). No later push can
 *   work, so the note is recorded dead; its siblings go on.
 * - `noteLocal`: the note's own request was refused (no inclusion proof yet, or the
 *   transport rejected it as invalid). The note spends its attempt and the pass goes on:
 *   the next row's note is a different request.
 * - `outage`: everything else, including a gRPC status the sweep does not know and text
 *   it does not recognize. A transport that is down or overloaded fails every push the
 *   same way, so the pass stops pushing rather than spend an attempt on every row.
 *
 * Matched on the SDK's error text, with or without the offscreen bus's
 * `Offscreen call '...' failed:` prefix. A failed send reads
 * `... Send note with proof failed: Status { code: <Code>, ... }` (tonic's Debug output),
 * and a failed browser fetch is `Unknown`.
 */
export const classifyRelayFailure = (error: unknown): RelayFailureClass => {
  if (isKilledPipeline(error)) return 'interrupted';
  const parts = errorMessageParts(error);
  const has = (phrase: string) => parts.some(part => part.includes(phrase));
  if (has('note transport is disabled')) return 'notConfigured';
  if (has('No output note found for the given id') || has('output note has no details to relay')) return 'storeLoss';
  if (has('output note has no inclusion proof')) return 'noteLocal';
  const code = statusCodeOf(parts);
  return code && NOTE_LOCAL_CODES.includes(code) ? 'noteLocal' : 'outage';
};

/** The gRPC code a failed send reports (tonic's `Status { code: <Code>, ... }`), if any. */
export function statusCodeOf(parts: string[]): string | undefined {
  return parts.map(part => /\bStatus \{ code: (\w+)/.exec(part)?.[1]).find(Boolean);
}
