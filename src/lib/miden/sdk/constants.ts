export enum MidenWalletStorageType {
  PRIVATE = 'Private',
  PUBLIC = 'Public'
}

export enum NoteExportType {
  ID = 'Id',
  FULL = 'Full',
  DETAILS = 'Details'
}

/**
 * How long a wait for a transaction's commit sleeps between checks, in both of its loops: the SDK's
 * `transactions.waitFor` (`MidenClientInterface.waitForTransactionCommit`) and the offscreen document's own.
 * The first check runs straight after submit, before any block, so the wait nearly always ends on a later
 * check and overshoots the block by up to this much (#1492).
 */
export const COMMIT_WAIT_POLL_INTERVAL_MS = 1_000;
