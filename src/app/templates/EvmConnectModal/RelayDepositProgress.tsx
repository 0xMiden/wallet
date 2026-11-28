import React, { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { PageHeader } from 'components/PageHeader';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { IBridgedReceiveExtraInputs, IBridgedReceivePhase } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { isUserErrorId, type UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import {
  type DepositBadgeSide,
  DepositProcessingView,
  type DepositProcessingStep
} from 'screens/deposit-flow/DepositProcessingView';
import { DepositSuccessView } from 'screens/deposit-flow/DepositSuccessView';
import type { DepositFee } from 'screens/deposit-flow/types';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

/** What the screen shows of a tracked deposit row. */
export type RelayDepositProgressState =
  | { kind: 'processing'; step: DepositProcessingStep }
  | { kind: 'success' }
  | { kind: 'failed' };

/**
 * The view of a deposit row. No row yet: the deposit is not detected. A row exists: "Deposit detected" is done and
 * "Bridging to Miden" is in progress, until the phase says that the funds can be claimed (`ready`, then "Arrived in
 * Bread" is in progress) or are in the wallet (`received`, the success screen).
 */
export function relayDepositProgressOf(phase: IBridgedReceivePhase | undefined): RelayDepositProgressState {
  switch (phase) {
    case undefined:
      return { kind: 'processing', step: 0 };
    case 'failed':
      return { kind: 'failed' };
    case 'received':
      return { kind: 'success' };
    case 'ready':
      return { kind: 'processing', step: 2 };
    case 'submitting':
    case 'delivering':
    default:
      return { kind: 'processing', step: 1 };
  }
}

/**
 * True while the row holds a relay job and is not in a final phase: the job can still execute, so the deposit is in
 * progress and nothing may sign it again (no Retry), even when the Epoch store reads `failed`.
 */
export function hasOpenRelayJob(inputs: Pick<IBridgedReceiveExtraInputs, 'relayJob' | 'phase'>): boolean {
  if (inputs.relayJob === undefined) return false;
  switch (inputs.phase) {
    case 'received':
    case 'failed':
      return false;
    default:
      return true;
  }
}

/** True while the row `txId` holds an open relay job (`hasOpenRelayJob`). False for a null id: nothing is read. */
export function useOpenRelayJob(txId: string | null): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
    if (txId === null) return undefined;
    return subscribeToLiveQuery(() => Repo.transactions.where({ id: txId }).first(), {
      next: row => {
        const inputs: IBridgedReceiveExtraInputs | undefined = row?.extraInputs;
        setOpen(inputs !== undefined && hasOpenRelayJob(inputs));
      },
      // A failed read keeps the last answer: an open job stays open.
      error: error => console.warn('[RelayDepositProgress] the row read failed', error)
    });
  }, [txId]);
  return open;
}

/** The id that reports a failed row, by the rule of the bridge status screen (`EvmBridgeDepositStatus`). */
function failureIdOf(inputs: IBridgedReceiveExtraInputs | undefined): UserErrorId {
  if (!inputs?.error) return 'transactionErrorDescription';
  return isUserErrorId(inputs.errorId) ? inputs.errorId : 'raw_bridge_deposit_failed';
}

export interface RelayDepositProgressProps {
  /** The `bridged-receive` row of the deposit. */
  txId: string;
  sent: DepositBadgeSide;
  received: DepositBadgeSide;
  networkName: string;
  routeName: string;
  bridgeFee: DepositFee;
  feeSymbol: string;
  /** The route takes about 30 minutes (Agglayer). */
  slow: boolean;
  onDone: () => void;
  onDepositAgain: () => void;
}

/**
 * Processing and success of a relay deposit, driven by its tracked row: the processing steps while it bridges, the
 * failure with the row's message when it fails, and the success screen when the funds are in the wallet.
 */
export const RelayDepositProgress: React.FC<RelayDepositProgressProps> = ({
  txId,
  sent,
  received,
  networkName,
  routeName,
  bridgeFee,
  feeSymbol,
  slow,
  onDone,
  onDepositAgain
}) => {
  const { t } = useTranslation();
  const { row } = useTransactionRow(txId);
  const inputs: IBridgedReceiveExtraInputs | undefined = row?.id === txId ? row.extraInputs : undefined;
  const progress = relayDepositProgressOf(inputs?.phase);

  switch (progress.kind) {
    case 'success':
      return (
        <DepositSuccessView
          sent={sent}
          received={received}
          networkName={networkName}
          routeName={routeName}
          bridgeFee={bridgeFee}
          feeSymbol={feeSymbol}
          onDone={onDone}
          onDepositAgain={onDepositAgain}
        />
      );
    case 'failed':
    case 'processing':
      return (
        <>
          {/* `head('Processing', false, true, 'home')`: no back, a close that goes Home. */}
          <div className="shrink-0 px-4">
            <PageHeader title={t('transactionProcessingHeader')} onClose={onDone} />
          </div>
          {progress.kind === 'failed' ? (
            <DepositProcessingView
              sent={sent}
              received={received}
              activeStep={1}
              slow={slow}
              failure={{
                message: inputs?.error || t('transactionErrorDescription'),
                errorId: failureIdOf(inputs)
              }}
            />
          ) : (
            <DepositProcessingView sent={sent} received={received} activeStep={progress.step} slow={slow} />
          )}
        </>
      );
  }
};
