import React, { useCallback, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { IBridgedReceivePhase, IUsdcxCctpLeg } from 'lib/miden/db/types';
import { hapticMedium } from 'lib/mobile/haptics';
import { usdcxSourceChains, UsdcxSourceChain } from 'lib/usdcx/constant';
import { nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';

import { useCctpExecute } from './useCctpExecute';

export interface UsdcxExecuteActionProps {
  txId: string;
  sourceChainId?: number;
  sourceConfig?: UsdcxSourceChain;
  phase: IBridgedReceivePhase;
  cctp?: IUsdcxCctpLeg;
  className?: string;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExecute = useCallback(async () => {
    if (busy || sourceChainId === undefined || !cctp) return;
    hapticMedium();
    setBusy(true);
    setError(null);
    try {
      await execute(txId, sourceChainId, cctp);
    } catch (cause) {
      console.error('[UsdcxExecuteAction] execute failed', cause);
      setError(nativeSigningErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  }, [busy, cctp, execute, sourceChainId, t, txId]);

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
          {error}
        </p>
      )}
    </div>
  );
};
