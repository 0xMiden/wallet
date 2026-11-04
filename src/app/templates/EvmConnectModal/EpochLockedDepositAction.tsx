import React, { useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { Button, ButtonVariant } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import {
  EpochLockedDepositState,
  formatWithdrawCountdown,
  nowSec,
  secondsUntilWithdrawable
} from 'lib/epoch/bridge-in-lock';
import {
  finishLockedDepositWithdrawal,
  LockedDepositError,
  retryLockedDeposit,
  startLockedDepositWithdrawal
} from 'lib/epoch/bridge-in-recovery';
import type { IEpochLockedDeposit } from 'lib/miden/db/types';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { getChain } from 'lib/walletconnect/config';
import { nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';

import { shortenAddress } from './shared';

export interface EpochLockedDepositActionProps {
  txId: string;
  lock: IEpochLockedDeposit;
  state: EpochLockedDepositState;
  /** The deposit as the row shows it, for example `10 USDC`. */
  amountLabel: string;
  className?: string;
}

type RecoveryAction = 'retry' | 'withdraw';

/** The sentence for a recovery failure. A refusal has its own sentence, any other failure shows its message. */
function recoveryErrorText(cause: unknown, t: TFunction, network: string): string {
  if (!(cause instanceof LockedDepositError)) return nativeSigningErrorMessage(cause, t);
  switch (cause.reason) {
    case 'wrongChain':
      return t('epochDepositErrorWrongChain', { network });
    case 'withdrawalNotStarted':
      return t('epochDepositErrorNotStarted');
    case 'withdrawalNotDue':
      return t('epochDepositErrorNotDue');
    case 'depositMissing':
      return t('epochDepositErrorMissing');
    case 'lockMismatch':
      return t('epochDepositErrorLockMismatch');
    case 'walletDisconnected':
    case 'wrongAccount':
    case 'notRecoverable':
    default:
      return t('epochDepositErrorNotRecoverable');
  }
}

/** The clock in unix seconds, refreshed each second while `running` is true. */
function useNowSec(running: boolean): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    if (!running) return undefined;
    setNow(nowSec());
    const timer = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The recovery of an Epoch deposit that is in The Compact without an allocation (#2120), on its Activity row. The
 * sponsor's connected EVM wallet can register the deposit again (Retry bridge) or withdraw it back to itself. A
 * withdrawal is due only after the lock's reset period, so the row shows a countdown that survives a restart.
 */
export const EpochLockedDepositAction: React.FC<EpochLockedDepositActionProps> = ({
  txId,
  lock,
  state,
  amountLabel,
  className
}) => {
  const { t } = useTranslation();
  const { address, connected } = useEvmWalletConnection();
  const [connectOpen, setConnectOpen] = useState(false);
  const [busy, setBusy] = useState<RecoveryAction>();
  const [error, setError] = useState<string>();
  const network = getChain(lock.chainId)?.name ?? String(lock.chainId);
  const sponsor = shortenAddress(lock.sponsorAddress);
  const withdrawableAt = lock.withdrawableAt;
  const counting = state === 'locked' && withdrawableAt !== undefined && withdrawableAt > nowSec();
  const now = useNowSec(counting);
  const secondsLeft = withdrawableAt === undefined ? undefined : secondsUntilWithdrawable(withdrawableAt, now);
  const isSponsor = connected && address?.toLowerCase() === lock.sponsorAddress.toLowerCase();

  const run = useCallback(
    async (action: RecoveryAction, operation: () => Promise<unknown>) => {
      if (busy !== undefined) return;
      hapticMedium();
      setBusy(action);
      setError(undefined);
      try {
        await operation();
      } catch (cause) {
        console.error(`[EpochLockedDepositAction] ${action} failed`, cause);
        setError(recoveryErrorText(cause, t, network));
      } finally {
        setBusy(undefined);
      }
    },
    [busy, network, t]
  );

  const handleRetry = useCallback(() => run('retry', () => retryLockedDeposit(txId)), [run, txId]);
  const handleWithdraw = useCallback(
    () =>
      run('withdraw', () =>
        lock.withdrawEnabledAt === undefined ? startLockedDepositWithdrawal(txId) : finishLockedDepositWithdrawal(txId)
      ),
    [lock.withdrawEnabledAt, run, txId]
  );
  const handleConnect = useCallback(() => {
    hapticLight();
    setConnectOpen(true);
  }, []);

  if (state === 'withdrawn') {
    return (
      <p className={clsx('text-center text-sm text-muted', className)} data-testid="epoch-deposit-withdrawn">
        {t('epochDepositWithdrawnBody', { address: sponsor })}
      </p>
    );
  }

  const withdrawStatus = (() => {
    if (lock.withdrawEnabledAt === undefined) return undefined;
    if (secondsLeft === undefined) return t('epochDepositWithdrawStartedUnknown');
    if (secondsLeft > 0) return t('epochDepositWithdrawStarted', { time: formatWithdrawCountdown(secondsLeft) });
    return t('epochDepositWithdrawReady');
  })();
  const withdrawWaiting = secondsLeft !== undefined && secondsLeft > 0;

  return (
    <div className={clsx('flex flex-col gap-3', className)} data-testid="epoch-deposit-locked">
      <Notice
        tone="warning"
        icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
        title={t('epochDepositLockedTitle')}
      >
        {t('epochDepositLockedBody', { amount: amountLabel, network, address: sponsor })}
      </Notice>
      {withdrawStatus && (
        <p className="text-center text-sm text-muted" role="status" data-testid="epoch-deposit-withdraw-status">
          {withdrawStatus}
        </p>
      )}
      {isSponsor ? (
        <>
          <Button
            accent="receive"
            title={busy === 'retry' ? t('epochDepositRetrying') : t('epochDepositRetry')}
            variant={ButtonVariant.Primary}
            onClick={handleRetry}
            disabled={busy !== undefined}
            data-testid="epoch-deposit-retry"
            className="w-full max-w-none"
          />
          <Button
            title={busy === 'withdraw' ? t('epochDepositWithdrawing') : t('epochDepositWithdraw')}
            variant={ButtonVariant.Secondary}
            onClick={handleWithdraw}
            disabled={busy !== undefined || withdrawWaiting}
            data-testid="epoch-deposit-withdraw"
            className="w-full max-w-none"
          />
        </>
      ) : (
        <>
          <p className="text-center text-sm text-muted" data-testid="epoch-deposit-connect-hint">
            {connected
              ? t('epochDepositWrongWallet', { address: sponsor })
              : t('epochDepositConnectSponsor', { address: sponsor })}
          </p>
          <Button
            title={connected ? t('switchWallet') : t('connectEvmWallet')}
            variant={ButtonVariant.Secondary}
            onClick={handleConnect}
            data-testid="epoch-deposit-connect"
            className="w-full max-w-none"
          />
        </>
      )}
      {error && (
        <p role="alert" className="text-center text-sm text-negative-ink wrap-anywhere select-text">
          {error}
        </p>
      )}
      <EvmConnectModal open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
};
