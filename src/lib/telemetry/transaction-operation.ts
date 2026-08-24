// Type-only, and written as such rather than relying on erasure: the module-graph
// assertion in `guarantees.test.ts` treats a bare `import` as a real edge, so a
// plain import here would show this module reaching into the database layer when
// nothing of the sort survives the build.
import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import { TelemetryOperation, TelemetryStep } from './types';

/**
 * Translate the transaction pipeline's own vocabulary into the reporting one.
 *
 * Two vocabularies rather than one, deliberately. `ITransactionType` and
 * `ITransactionStage` exist to drive the pipeline and the progress screen, and
 * they change when the pipeline changes — a new row type or a new intermediate
 * stage is a routine addition there. The reporting names are a published
 * vocabulary: they appear in an Aptabase dashboard, in the store declarations,
 * and in the privacy policy's list of what is collected. Mapping between them
 * here means a pipeline change cannot silently add an event name to a dashboard
 * or a row to a policy, and the total maps below are what make that a compile
 * error rather than a discovery.
 */

/**
 * Deliberately total: `Record`, not a lookup with a fallback. A new
 * `ITransactionType` fails `yarn ts` here, which is the point — somebody has to
 * decide whether it deserves its own name or folds into an existing one.
 */
const OPERATION_BY_TYPE: Record<ITransactionType, TelemetryOperation> = {
  send: 'tx_send',
  consume: 'tx_receive',
  swap: 'tx_swap',
  execute: 'tx_dapp',
  'bridged-send': 'tx_bridge',
  'bridged-receive': 'tx_bridge',
  'earn-deposit': 'tx_earn',
  'earn-withdraw': 'tx_earn',
  // One name for every operation on the account's own security, because the
  // question worth asking of them is the same: is the guardian infrastructure
  // healthy. Splitting them would make each too rare to read.
  'switch-guardian': 'tx_guardian',
  'replace-hot-key': 'tx_guardian',
  'update-procedure-threshold': 'tx_guardian'
};

/**
 * Where a transaction died, coarsened to the distinctions worth acting on.
 *
 * The pipeline's stages are finer than the reporting vocabulary because they
 * drive a progress bar. What a reader needs is which *system* failed, so the
 * stages fold onto that: everything that talks to the guardian while building a
 * transaction is `signing`, everything that hands bytes to the network is
 * `submitting`. `proving` stays on its own because a prover failure is the whole
 * reason this reporting exists.
 *
 * `complete` maps to `undefined`: a row that reached it did not fail anywhere,
 * so there is no failure location to name.
 */
const STEP_BY_STAGE: Record<ITransactionStage, TelemetryStep | undefined> = {
  syncing: 'syncing',
  executing: 'executing',
  proving: 'proving',
  sending: 'submitting',
  submitting: 'submitting',
  delivering: 'submitting',
  confirming: 'confirming',
  'creating-proposal': 'signing',
  'signing-proposal': 'signing',
  'registering-guardian': 'signing',
  'guardian-syncing': 'signing',
  'guardian-synced': 'signing',
  complete: undefined
};

/** The reporting name for a transaction row's type. */
export function operationOfType(type: ITransactionType): TelemetryOperation {
  // The `??` is unreachable through the type system and is here for the wire:
  // rows are read back from IndexedDB, where a row written by an older or newer
  // build can hold a `type` this build has never heard of.
  return OPERATION_BY_TYPE[type] ?? 'tx_other';
}

/** Where a transaction got to, or `undefined` if there is nothing to name. */
export function stepOfStage(stage: ITransactionStage | undefined): TelemetryStep | undefined {
  if (stage === undefined) return undefined;
  return STEP_BY_STAGE[stage];
}
