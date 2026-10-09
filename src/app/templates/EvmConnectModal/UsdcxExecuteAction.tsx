import React, { useCallback, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { IBridgedReceivePhase, IUsdcxCctpLeg } from 'lib/miden/db/types';
import { hapticMedium } from 'lib/mobile/haptics';
import { getUsdcxExecutorSource, isUsdcxExecutorSource } from 'lib/usdcx/constant';

import { useCctpExecute } from './useCctpExecute';

export interface UsdcxExecuteActionProps {
  txId: string;
  sourceChainId?: number;
  phase: IBridgedReceivePhase;
  cctp?: IUsdcxCctpLeg;
  className?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Arc leg of an executor-route deposit, on the deposit status screen and in Activity: what the
 * transfer is waiting for, and once Circle attested the burn, the button that executes it on Arc from the
 * connected EVM wallet. Renders nothing for a direct xReserve deposit or once the row has left `delivering`.
 */
export const UsdcxExecuteAction: React.FC<UsdcxExecuteActionProps> = ({
  txId,
  sourceChainId,
  phase,
  cctp,
  className
}) => {
  const { t } = useTranslation();
  const execute = useCctpExecute();
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
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, cctp, execute, sourceChainId, txId]);

  if (sourceChainId === undefined || !isUsdcxExecutorSource(sourceChainId) || phase !== 'delivering' || !cctp) {
    return null;
  }
  const network = getUsdcxExecutorSource(sourceChainId).target.chain.name;

  if (cctp.executeTxHash) {
    return (
      <p className={clsx('text-center text-sm text-gray', className)} data-testid="usdcx-execute-submitted">
        {t('usdcxExecuteSubmitted', { network })}
      </p>
    );
  }
  if (!cctp.message || !cctp.attestation) {
    return (
      <p className={clsx('text-center text-sm text-gray', className)} data-testid="usdcx-execute-waiting">
        {t('usdcxCctpAwaitingAttestation', { network })}
      </p>
    );
  }
  return (
    <div className={clsx('flex flex-col gap-3', className)} data-testid="usdcx-execute-ready">
      <p className="text-center text-sm text-gray">{t('usdcxExecuteNeeded', { network })}</p>
      <Button
        title={busy ? t('usdcxExecuting') : t('usdcxExecuteOnNetwork', { network })}
        variant={ButtonVariant.Primary}
        onClick={handleExecute}
        disabled={busy}
        data-testid="usdcx-execute-button"
        className="w-full max-w-none"
      />
      {error && (
        <p role="alert" className="text-center text-sm text-negative-ink break-words">
          {error}
        </p>
      )}
    </div>
  );
};
