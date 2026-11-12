import { toLocalFormat } from 'lib/i18n/numbers';
import type {
  IBridgedSendExtraInputs,
  IOneClickPhase,
  IOneClickTrackingData,
  ISendExtraInputs,
  ITransaction,
  ITransactionStage,
  ITransactionType
} from 'lib/miden/db/types';
import { rotationVerdict } from 'lib/miden/guardian/rotation-verdict';
import { isPrivateNoteType } from 'lib/miden/helpers';
import type { OneClickAsset } from 'lib/one-click/types';
import { formatNearIntentsAmount } from 'screens/send-flow/near-intents-format';

import type { TransactionStepDef } from './constants';
import type { TransactionStepState } from './types';

/**
 * Index (within `steps`) of the step currently in progress, driving each row's
 * complete/active/pending state. Once the tx completes, every step is done
 * (`steps.length`).
 */
export const getActiveStepIndex = (
  steps: readonly TransactionStepDef[],
  stage: ITransactionStage | undefined,
  transactionComplete: boolean
): number => {
  if (transactionComplete || stage === 'complete') return steps.length;
  if (!stage) return 0;
  const idx = steps.findIndex(step => step.activeStages.includes(stage));
  if (idx !== -1) return idx;
  // In a set where no step owns 'guardian-synced', the Guardian sync is the last
  // step, so its end is every step done. A private send's set owns it in the
  // delivery step after the sync, hence the lookup first (#1492).
  if (stage === 'guardian-synced') return steps.length;
  // A stage owned by no step runs before the first shown step (e.g. a
  // non-guardian send's early 'syncing', when the standard set starts at
  // proof-generation) — treat the first step as the active one.
  return 0;
};

/**
 * Per-step durations in ms, computed from persisted stage timestamps. A step's
 * span runs from its `startStage` stamp to the next step's `startStage` stamp
 * (or the `complete` stamp for the terminal step). `undefined` when either
 * boundary isn't stamped yet — so a step renders no time rather than a
 * fabricated zero, and stays coalescing-proof (the stamps are persisted on the
 * row, not observed from live `stage` transitions).
 */
export const getStepDurationsMs = (
  steps: readonly TransactionStepDef[],
  stageTimestamps: Partial<Record<ITransactionStage, number>> | undefined
): (number | undefined)[] =>
  steps.map((step, index) => {
    const start = stepStartStamp(step, stageTimestamps);
    const nextStep = steps[index + 1];
    const end = nextStep ? stepStartStamp(nextStep, stageTimestamps) : stageTimestamps?.['complete'];
    if (start === undefined || end === undefined || end < start) return undefined;
    return end - start;
  });

/** A step's duration for `transactionStepDurationSec`: one fraction digit, in the wallet locale's own symbols. */
export const formatStepSeconds = (ms: number): string => toLocalFormat(ms / 1000, { decimalPlaces: 1 });

/**
 * When does this step begin? `startStage` first, then `fallbackStartStage` for a
 * path that stamps a different opening stage (see the field's docs). Used for
 * both ends of a span, so the boundary a step's duration ENDS on is resolved the
 * same way the next step's own start is — otherwise the two would disagree and a
 * step could be timed against a stamp the following step does not use.
 */
const stepStartStamp = (
  step: TransactionStepDef,
  stageTimestamps: Partial<Record<ITransactionStage, number>> | undefined
): number | undefined =>
  stageTimestamps?.[step.startStage] ??
  (step.fallbackStartStage === undefined ? undefined : stageTimestamps?.[step.fallbackStartStage]);

/**
 * Did this row rotate its guardian by signing locally, rather than through the
 * outgoing operator? Reads the `switchedDirectly` marker the direct path stamps
 * on the row before it signs, so the step labels are right while the steps are
 * happening and not only on the receipt.
 *
 * The `signing-locally` STAGE counts as the same evidence, because the marker
 * write is deliberately non-fatal: the direct path logs and continues when the
 * dexie `modify` fails (the flow it protects reads its own in-memory copy), and
 * the stage stamp that follows is a separate write that still lands. Without this
 * the screen would read the marker as absent and label a direct rotation with the
 * coordinated step "Guardian approved" — while its own title said "Signing
 * locally" — which is the contradiction these labels exist to remove. The
 * TIMESTAMP rather than the live stage, so it keeps holding once the row moves on
 * to executing/proving. `signing-locally` has exactly one producer.
 */
export const isDirectGuardianSwitch = (tx: ITransaction | undefined): boolean =>
  tx?.type === 'switch-guardian' &&
  (tx.extraInputs?.switchedDirectly === true ||
    tx.stage === 'signing-locally' ||
    tx.stageTimestamps?.['signing-locally'] !== undefined);

/** These stamp 'confirming' for a commit wait of their own and relay no note; their last step owns that wait. */
const OWN_COMMIT_WAIT_TYPES: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'switch-guardian',
  'replace-hot-key',
  'update-procedure-threshold'
]);

const DELIVERY_STAGES: readonly ITransactionStage[] = ['confirming', 'delivering'];

/**
 * A row whose completion waits for the commit and relays a private note before the row completes, so the screen
 * shows that wait and relay as a step of their own (#1492). `completeSendTransaction` and `completeCustomTransaction`
 * are the paths that do, and both stamp 'confirming' before the wait and 'delivering' before the relay.
 *
 * Read from signals that do not hang on the best-effort `noteDelivery` write: a send whose `noteType` is private
 * (`isPrivateNoteType`, so the SDK's numeric value counts; an unreadable one answers no here), either stamp on any
 * other type than the rotations above, or a delivery recorded 'pending' or 'relayed'. A row recorded 'undelivered'
 * without the stamps had no note it could relay, so nothing waited.
 */
export const waitsToDeliverNote = (tx: ITransaction | undefined): boolean => {
  if (!tx) return false;
  if (tx.type === 'send') {
    try {
      if (isPrivateNoteType(tx.noteType)) return true;
    } catch {
      // Unreadable: the stamps and the delivery record still answer.
    }
  }
  if (tx.noteDelivery === 'pending' || tx.noteDelivery === 'relayed') return true;
  if (OWN_COMMIT_WAIT_TYPES.has(tx.type)) return false;
  return DELIVERY_STAGES.some(stage => tx.stage === stage || tx.stageTimestamps?.[stage] !== undefined);
};

/** The 1Click tracking on a row, read through the `extraInputs` type of the row's own type. */
const oneClickOfRow = (tx: ITransaction): IOneClickTrackingData | undefined => {
  switch (tx.type) {
    // A row that an older build stored.
    case 'send': {
      const inputs: ISendExtraInputs | undefined = tx.extraInputs;
      return inputs?.oneClick;
    }
    case 'bridged-send': {
      const inputs: IBridgedSendExtraInputs | undefined = tx.extraInputs;
      switch (inputs?.provider) {
        case 'near-intents':
          return inputs.oneClick;
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
};

/**
 * The 1Click tracking of a NEAR Intents send from Miden: a `bridged-send` row with provider `near-intents`, or a
 * `send` row that an older build stored, whose `extraInputs.oneClick` goes from Miden to another chain. A row
 * restored from a backup is not reconciled (`reconcileOneClickSwaps` skips it), so it gets none here.
 */
export const nearIntentsSendTracking = (tx: ITransaction | undefined): IOneClickTrackingData | undefined => {
  if (!tx || tx.restoredFromBackup) return undefined;
  const tracking = oneClickOfRow(tx);
  return tracking?.direction === 'miden-to-evm' ? tracking : undefined;
};

/**
 * The state of the "Sending to deposit address" step of a NEAR Intents send: it runs while any of its sub-steps (the
 * Miden steps) runs, and ends when the Miden transaction ends. An outcome that is not known stays pending.
 */
export const getNearIntentsSendStepState = (
  transactionComplete: boolean,
  hasErrors: boolean,
  unconfirmed: boolean
): TransactionStepState => {
  if (!transactionComplete) return 'active';
  if (!hasErrors) return 'complete';
  return unconfirmed ? 'pending' : 'failed';
};

/**
 * The delivery of a NEAR Intents send after its Miden transaction: still on its way, delivered, or not delivered.
 * The progress screen does not wait for it; the success view and Activity show it.
 */
export type NearIntentsDeliveryOutcome = 'pending' | 'delivered' | 'failed';

/**
 * The delivery outcome of a 1Click phase. For a send from Miden, 1Click `SUCCESS` means the destination chain got
 * the funds, so `arriving` counts as delivered. `refunded`, `failed` and `expired` are the terminal failures.
 */
export const nearIntentsDeliveryOutcome = (phase: IOneClickPhase): NearIntentsDeliveryOutcome => {
  switch (phase) {
    case 'delivered':
    case 'arriving':
      return 'delivered';
    case 'refunded':
    case 'failed':
    case 'expired':
      return 'failed';
    default:
      return 'pending';
  }
};

/** The i18n keys of the title and the description of a NEAR Intents send that was not delivered. */
export const nearIntentsDeliveryFailureKeys = (phase: IOneClickPhase): { title: string; description: string } => {
  switch (phase) {
    case 'refunded':
      return { title: 'nearIntentsSendRefundedTitle', description: 'nearIntentsSendRefundedDescription' };
    case 'expired':
      return { title: 'nearIntentsSendExpiredTitle', description: 'nearIntentsSendExpiredDescription' };
    default:
      return { title: 'nearIntentsSendFailedTitle', description: 'nearIntentsSendFailedDescription' };
  }
};

/** The reason that 1Click gives for a failed or refunded delivery, or undefined. */
export const nearIntentsDeliveryReason = (tracking: IOneClickTrackingData): string | undefined => {
  const reason = tracking.error ?? tracking.statusResponse?.swapDetails.refundReason;
  return reason && reason.trim().length > 0 ? reason : undefined;
};

/**
 * A 1Click base-unit amount of `asset` as "amount symbol", with the same rounding as the route card and the review
 * page (at most 6 decimal places). Undefined when the value is not a base-unit amount.
 */
const nearIntentsAmountText = (value: string | undefined, asset: OneClickAsset): string | undefined => {
  const amount = formatNearIntentsAmount(value, asset.decimals);
  return amount === undefined ? undefined : `${amount} ${asset.symbol}`;
};

/**
 * What a NEAR Intents send took from Miden, from the row's own quote and Miden asset. The wallet can have no
 * metadata for the faucet yet, so the screens do not read `assetsMetadata` for this row (as for a GC purchase).
 */
export const nearIntentsSentText = (tracking: IOneClickTrackingData): string | undefined =>
  nearIntentsAmountText(tracking.quote.quote.amountIn, tracking.originAsset);

/** What the recipient got, when 1Click has reported it; else undefined. */
export const nearIntentsDeliveredText = (tracking: IOneClickTrackingData): string | undefined =>
  nearIntentsAmountText(tracking.statusResponse?.swapDetails.amountOut, tracking.destinationAsset);

/** What the quote said that the recipient gets: an estimate until 1Click reports the delivery. */
export const nearIntentsQuotedText = (tracking: IOneClickTrackingData): string | undefined =>
  nearIntentsAmountText(tracking.quote.quote.amountOut, tracking.destinationAsset);

/** The minimum that the quote guarantees to the recipient. */
export const nearIntentsMinimumText = (tracking: IOneClickTrackingData): string | undefined =>
  nearIntentsAmountText(tracking.quote.quote.minAmountOut, tracking.destinationAsset);

/** The output of a NEAR Intents send: the delivered amount when 1Click reports it, else the quoted amount. */
export const nearIntentsOutputText = (tracking: IOneClickTrackingData): string | undefined =>
  nearIntentsDeliveredText(tracking) ?? nearIntentsQuotedText(tracking);

/** The name of the destination chain of a NEAR Intents send, from the config stored on the row. */
export const nearIntentsDestinationName = (tracking: IOneClickTrackingData): string => {
  const blockchain = tracking.destinationAsset.blockchain;
  return (tracking.config.chains ?? []).find(chain => chain.id === blockchain)?.name ?? blockchain;
};

/**
 * A `switch-guardian` row the pipeline SUBMITTED without ever establishing that
 * the rotation committed. The row still completes — it is not a failure, and
 * there is no honest way to call it one — so every surface that reads
 * "completed" as "confirmed on chain" has to consult this instead. The receipt
 * was the first to do so; the in-progress screen and the Activity row title
 * followed, because a receipt that is careful for 1.5 seconds after two screens
 * have already certified the opposite is not careful at all.
 */
export const isUnconfirmedGuardianSwitch = (tx: ITransaction | undefined): boolean =>
  rotationVerdict(tx)?.kind === 'submitted-unconfirmed';

/**
 * `unconfirmed` marks a row whose outcome is unknown (`readsAsNotConfirmed`): the step it
 * froze on may still finish, so it reads pending rather than failed.
 */
export const getTransactionStepState = (
  index: number,
  activeStepIndex: number,
  transactionComplete: boolean,
  hasErrors: boolean,
  unconfirmed = false
): TransactionStepState => {
  if (transactionComplete) {
    if (!hasErrors) return 'complete';
    if (index === activeStepIndex) return unconfirmed ? 'pending' : 'failed';
    return index < activeStepIndex ? 'complete' : 'pending';
  }
  if (index < activeStepIndex) {
    return 'complete';
  }
  if (index === activeStepIndex) {
    return 'active';
  }
  return 'pending';
};

export const getStageTitleKey = (stage?: ITransactionStage, type?: ITransactionType): string => {
  if (!stage) return 'generatingTransaction';
  if (stage === 'syncing') return 'transactionStageSyncing';
  if (stage === 'creating-proposal') return 'transactionStageCreatingProposal';
  if (stage === 'signing-proposal') return 'transactionStageSigningProposal';
  if (stage === 'signing-locally') return 'transactionStageSigningLocally';
  if (stage === 'proving') return 'transactionStageProving';
  if (stage === 'submitting') return 'transactionStageSubmitting';
  if (stage === 'guardian-syncing') return 'transactionStageGuardianSyncing';
  if (stage === 'complete') return 'transactionStageComplete';
  if (stage === 'confirming') return 'transactionStageConfirming';
  if (stage === 'registering-guardian') return 'transactionStageRegisteringGuardian';
  if (stage === 'delivering') return 'transactionStageDelivering';
  if (type === 'consume') return 'transactionStageClaiming';
  if (type === 'execute') return 'transactionStageExecuting';
  if (type === 'switch-guardian') return 'transactionStageSwitching';
  if (type === 'swap') return 'transactionStageSwapping';
  return 'transactionStageSending';
};

export const getStageDescriptionKey = (stage?: ITransactionStage): string => {
  if (!stage) return 'generatingTransactionDescription';
  if (stage === 'syncing') return 'transactionStageSyncingDescription';
  if (stage === 'creating-proposal') return 'transactionStageCreatingProposalDescription';
  if (stage === 'signing-proposal') return 'transactionStageSigningProposalDescription';
  if (stage === 'signing-locally') return 'transactionStageSigningLocallyDescription';
  if (stage === 'executing') return 'transactionStageExecutingDescription';
  if (stage === 'proving') return 'transactionStageProvingDescription';
  if (stage === 'submitting') return 'transactionStageSubmittingDescription';
  if (stage === 'guardian-syncing') return 'transactionStageGuardianSyncingDescription';
  if (stage === 'complete') return 'transactionStageCompleteDescription';
  if (stage === 'confirming') return 'transactionStageConfirmingDescription';
  if (stage === 'registering-guardian') return 'transactionStageRegisteringGuardianDescription';
  if (stage === 'delivering') return 'transactionStageDeliveringDescription';
  return 'transactionStageSendingDescription';
};

/**
 * The title while the row is processed. A NEAR Intents send (a `bridged-send` row or an older `send` row) is a
 * payment to a recipient, so it reads as a send whatever its row type.
 */
export const getProcessingTitleKey = (type?: ITransactionType, tx?: ITransaction): string => {
  if (nearIntentsSendTracking(tx) !== undefined) return 'transactionTitleSend';
  if (type === 'send') return 'transactionTitleSend';
  if (type === 'swap') return 'transactionTitleSwap';
  return 'generatingTransaction';
};
