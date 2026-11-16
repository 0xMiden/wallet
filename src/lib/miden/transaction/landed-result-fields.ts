import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { feeFieldsFromResult } from '../activity/fee';
import { retireLandedTrap } from '../sdk/landed-trap-retirement';

/** One read of a landed result's field: what it answered, or what it threw. */
export type LandedRead<T> = { value: T } | { error: unknown };

export type LandedResultFields = {
  transactionId: LandedRead<string>;
  resultBytes: LandedRead<Uint8Array>;
  feeFields: LandedRead<ReturnType<typeof feeFieldsFromResult>>;
};

// Keyed by the result object, so the structural tail's read is the one its completion writes.
const kept = new WeakMap<TransactionResult, LandedResultFields>();

export const readOnce = <T>(read: () => T, landing: string, result: TransactionResult): LandedRead<T> => {
  try {
    return { value: read() };
  } catch (error) {
    // No lock sees this trap: the read runs past submit, outside any hold.
    retireLandedTrap(error, landing, result);
    return { error };
  }
};

/**
 * The id, bytes and fee of a landed result, read once, before the first wait that can replace the client: a handle
 * answers only while the client that produced it has not been retired, and every post-submit wait (the commit wait,
 * the relay, a re-register, a registration) can retire it. Never throws. A read that throws is retired under `landing`
 * (the wallet row id) when it is a trap and kept as its error; later calls answer from what was kept and touch the
 * handle no more.
 */
export function readLandedResultFields(result: TransactionResult, landing: string): LandedResultFields {
  const known = kept.get(result);
  if (known !== undefined) return known;
  const fields: LandedResultFields = {
    transactionId: readOnce(() => result.executedTransaction().id().toHex(), landing, result),
    resultBytes: readOnce(() => result.serialize(), landing, result),
    feeFields: readOnce(() => feeFieldsFromResult(result, landing), landing, result)
  };
  kept.set(result, fields);
  return fields;
}

export const keptValue = <T>(read: LandedRead<T>): T | undefined => ('value' in read ? read.value : undefined);

/**
 * The kept fee fields, or the kept error rethrown as itself. `feeFieldsFromResult` lets only an eviction out, so the
 * write that spreads this throws where it threw when it read the fee itself.
 */
export function landedFee(fields: LandedResultFields): ReturnType<typeof feeFieldsFromResult> {
  if ('error' in fields.feeFields) throw fields.feeFields.error;
  return fields.feeFields.value;
}

/** The id a read of `result` kept, without reading the handle. */
export function keptLandedTransactionId(result: TransactionResult): string | undefined {
  const known = kept.get(result);
  return known === undefined ? undefined : keptValue(known.transactionId);
}
