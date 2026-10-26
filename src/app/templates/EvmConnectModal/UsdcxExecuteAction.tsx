import React, { useCallback, useEffect, useRef, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { IBridgedReceivePhase, IUsdcxCctpLeg } from 'lib/miden/db/types';
import { hapticMedium } from 'lib/mobile/haptics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { usdcxSourceChains, UsdcxSourceChain } from 'lib/usdcx/constant';
import { nativeSigningErrorId, nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';

import { useCctpExecute } from './useCctpExecute';

export interface UsdcxExecuteActionProps {
  txId: string;
  sourceChainId?: number;
  sourceConfig?: UsdcxSourceChain;
  phase: IBridgedReceivePhase;
  cctp?: IUsdcxCctpLeg;
  className?: string;
}

interface ExecuteSelection {
  txId: string;
  sourceChainId?: number;
}

interface ExecuteOperation {
  owner: ExecuteSelection;
}

interface ExecuteState {
  operation: ExecuteOperation;
  busy: boolean;
  error?: { text: string; id: UserErrorId };
}

/**
 * The Arc leg of an executor-route deposit, on the deposit status screen and in Activity: what the
 * transfer is waiting for, and once Circle attested the burn, the button that executes it on Arc from the
 * connected EVM wallet. Renders nothing for a direct xReserve deposit or once the row has left `delivering`.
 */
export const UsdcxExecuteAction: React.FC<UsdcxExecuteActionProps> = ({
  txId,
  sourceChainId,
  sourceConfig,
  phase,
  cctp,
  className
}) => {
  const { t } = useTranslation();
  const execute = useCctpExecute();
  const source = sourceConfig ?? (sourceChainId === undefined ? undefined : usdcxSourceChains().get(sourceChainId));
  const selectionRef = useRef<ExecuteSelection>({ txId, sourceChainId });
  // A return to the same row is a new visit, so an earlier operation cannot own its display.
  if (selectionRef.current.txId !== txId || selectionRef.current.sourceChainId !== sourceChainId) {
    selectionRef.current = { txId, sourceChainId };
  }
  const selection = selectionRef.current;
  const operationRef = useRef<ExecuteOperation | null>(null);
  const [execution, setExecution] = useState<ExecuteState>();
  const ownedExecution = execution?.operation.owner === selection ? execution : undefined;
  const busy = ownedExecution?.busy ?? false;
  const error = ownedExecution?.error;
  useEffect(
    () => () => {
      if (operationRef.current?.owner === selection) operationRef.current = null;
    },
    [selection]
  );
  const ready =
    sourceChainId !== undefined &&
    source?.route === 'cctp-executor' &&
    phase === 'delivering' &&
    !!cctp &&
    !cctp.executeTxHash &&
    !!cctp.message &&
    !!cctp.attestation;
  useUserVisibleError(ready ? error?.id : null, 'inline');

  const handleExecute = useCallback(async () => {
    if (busy || operationRef.current?.owner === selection || sourceChainId === undefined || !cctp) return;
    const operation: ExecuteOperation = { owner: selection };
    operationRef.current = operation;
    hapticMedium();
    setExecution({ operation, busy: true });
    try {
      await execute(txId, sourceChainId, cctp);
    } catch (cause) {
      console.error('[UsdcxExecuteAction] execute failed', cause);
      if (operationRef.current === operation && selectionRef.current === selection) {
        setExecution({
          operation,
          busy: true,
          error: {
            text: nativeSigningErrorMessage(cause, t),
            id: nativeSigningErrorId(cause) ?? 'raw_usdcx_execute_failed'
          }
        });
      }
    } finally {
      if (operationRef.current === operation && selectionRef.current === selection) {
        operationRef.current = null;
        setExecution(current => (current?.operation === operation ? { ...current, busy: false } : current));
      }
    }
  }, [busy, cctp, execute, selection, sourceChainId, t, txId]);

  if (sourceChainId === undefined || source?.route !== 'cctp-executor' || phase !== 'delivering' || !cctp) {
    return null;
  }
  const network = source.target.chain.name;

  if (cctp.executeTxHash) {
    return (
      <p className={clsx('text-center text-sm text-gray', className)} data-testid="usdcx-execute-submitted">
        {t('usdcxExecuteSubmitted', { network })}
      </p>
    );
  }
  if (!cctp.message || !cctp.attestation) {
    // A forwarded burn is Circle's to execute: the reconciler records the Arc hash when Circle sends it and
    // keeps the message on the row only if Circle gives up, which is when the button below appears.
    const forwarding = cctp.forwarded === true;
    return (
      <p
        className={clsx('text-center text-sm text-gray', className)}
        data-testid={forwarding ? 'usdcx-execute-forwarding' : 'usdcx-execute-waiting'}
      >
        {t(forwarding ? 'usdcxForwardingPending' : 'usdcxCctpAwaitingAttestation', { network })}
      </p>
    );
  }
  return (
    <div className={clsx('flex flex-col gap-3', className)} data-testid="usdcx-execute-ready">
      <p className="text-center text-sm text-gray">{t('usdcxExecuteNeeded', { network })}</p>
      <Button
        accent="receive"
        title={busy ? t('usdcxExecuting') : t('usdcxExecuteOnNetwork', { network })}
        variant={ButtonVariant.Primary}
        onClick={handleExecute}
        disabled={busy}
        data-testid="usdcx-execute-button"
        className="w-full max-w-none"
      />
      {error && (
        <p role="alert" className="text-center text-sm text-negative-ink wrap-anywhere select-text">
          {error.text}
        </p>
      )}
    </div>
  );
};
