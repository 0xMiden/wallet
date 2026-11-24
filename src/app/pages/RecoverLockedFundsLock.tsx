import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useNowSec } from 'app/hooks/useNowSec';
import { Icon, IconName } from 'app/icons/v2';
import {
  EVM_WALLET_PICKER_ERROR_ID,
  lockedDepositErrorDisplay,
  type LockedDepositErrorDisplay
} from 'app/templates/EvmConnectModal/locked-deposit-error-text';
import { shortenAddress } from 'app/templates/EvmConnectModal/shared';
import { Button, ButtonVariant } from 'components/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { EmptyState } from 'components/ui/EmptyState';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TokenAmount } from 'components/ui/TokenAmount';
import { formatWithdrawCountdown, secondsUntilWithdrawable } from 'lib/epoch/bridge-in-lock';
import {
  compactLockToken,
  type CompactLockState,
  type ForcedWithdrawalStatusName,
  readCompactLockState
} from 'lib/epoch/bridge-in-lock-scan';
import {
  cancelLockWithdrawal,
  finishLockWithdrawal,
  lockedDepositsOnLock,
  retryableLockedDepositId,
  retryLockedDeposit,
  sponsorWalletRefusal,
  startLockWithdrawal
} from 'lib/epoch/bridge-in-recovery';
import { readForcedWithdrawalRecord } from 'lib/epoch/forced-withdrawal-record';
import { requestLockRescan, useLockRescanGeneration } from 'lib/epoch/lock-scan-refresh';
import { hapticMedium } from 'lib/mobile/haptics';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectEpochTokens } from 'lib/remote-config/values';
import { getChain } from 'lib/walletconnect/config';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { useEvmWalletPicker } from 'lib/walletconnect/useEvmWalletPicker';
import { navigate, useLocation } from 'lib/woozie';

import { parseLockRoute, RECOVER_FUNDS_PATH, type RoutedLock } from './recover-funds-paths';

/** What this wallet knows about the lock beside the chain: its locked history rows and its storage record. */
interface LocalLockState {
  retryTxId?: string;
  /** Unix seconds at which this wallet enabled the forced withdrawal, from a row or the storage record. */
  enabledAt?: number;
  withdrawableAt?: number;
}

interface LockPageState {
  loaded: boolean;
  chain: CompactLockState;
  local: LocalLockState;
}

/** The withdrawal as the page shows it. `unknown`: The Compact did not answer and this wallet started none. */
type WithdrawPhase = 'off' | 'pending' | 'due' | 'unknown';

function withdrawPhaseOf(
  chainStatus: ForcedWithdrawalStatusName | undefined,
  enabledLocally: boolean,
  secondsLeft: number | undefined
): WithdrawPhase {
  const waiting = secondsLeft === undefined || secondsLeft > 0;
  switch (chainStatus) {
    case 'Disabled':
      return 'off';
    case 'Pending':
      return waiting ? 'pending' : 'due';
    case 'Enabled':
      return 'due';
    case undefined:
    default:
      if (!enabledLocally) return 'unknown';
      return waiting ? 'pending' : 'due';
  }
}

type LockAction = 'withdraw' | 'cancel' | 'retry';

interface RecoverLockedFundsLockProps {
  chainId?: string | null;
  lockId?: string | null;
}

/**
 * One Compact lock of the Settings recovery page: its balance, its forced withdrawal and the actions of its sponsor.
 * The sponsor withdraws the whole balance after the lock's reset period, cancels a withdrawal in progress, or, when a
 * history row still holds the refused intent, retries the bridge over the locked balance.
 */
const RecoverLockedFundsLock: FC<RecoverLockedFundsLockProps> = ({ chainId, lockId }) => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const handleBack = useBackWithFallback(RECOVER_FUNDS_PATH);
  const ref = useMemo(() => parseLockRoute(chainId, lockId, search), [chainId, lockId, search]);

  if (ref === undefined) {
    return (
      <SubPageLayout title={t('recoverFundsLockTitle')} onBack={handleBack} data-testid="recover-funds-lock-page">
        <EmptyState
          icon={IconName.Warning}
          title={t('recoverFundsLockInvalidTitle')}
          description={t('recoverFundsLockInvalidBody')}
          data-testid="recover-funds-lock-invalid"
        />
      </SubPageLayout>
    );
  }
  return <LockDetails key={`${ref.chainId}:${ref.lockId}:${ref.sponsorAddress}`} lock={ref} onBack={handleBack} />;
};

const LockDetails: FC<{ lock: RoutedLock; onBack: () => void }> = ({ lock, onBack }) => {
  const { t } = useTranslation();
  const { address, connected } = useEvmWalletConnection();
  const { openWalletPicker, error: pickerError } = useEvmWalletPicker();
  const generation = useLockRescanGeneration();
  const bridgeConfig = useBridgeConfigSnapshot();
  const [state, setState] = useState<LockPageState>({ loaded: false, chain: {}, local: {} });
  const [busy, setBusy] = useState<LockAction>();
  const [error, setError] = useState<LockedDepositErrorDisplay>();
  const [withdrawn, setWithdrawn] = useState(false);
  const [withdrawalDisabled, setWithdrawalDisabled] = useState(false);

  const network = getChain(lock.chainId)?.name ?? String(lock.chainId);
  const sponsor = shortenAddress(lock.sponsorAddress);
  const tokenAddress = compactLockToken(lock.lockId);
  const token = selectEpochTokens(bridgeConfig, lock.chainId).find(
    candidate => candidate.address.toLowerCase() === tokenAddress.toLowerCase()
  );
  const tokenSymbol = token?.symbol ?? shortenAddress(tokenAddress);

  // Read the lock on chain and what this wallet recorded about it. Again after every recovery action.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [chain, deposits, record] = await Promise.all([
        readCompactLockState(lock.chainId, lock.sponsorAddress, BigInt(lock.lockId)),
        lockedDepositsOnLock(lock),
        readForcedWithdrawalRecord(lock)
      ]);
      const row = deposits.find(deposit => deposit.lock.withdrawEnabledAt !== undefined)?.lock;
      const local: LocalLockState = {
        retryTxId: retryableLockedDepositId(deposits),
        enabledAt: row?.withdrawEnabledAt ?? record?.enabledAt,
        withdrawableAt: row?.withdrawableAt ?? record?.withdrawableAt
      };
      if (!cancelled) setState({ loaded: true, chain, local });
    };
    load().catch((err: unknown) => {
      console.error('[RecoverLockedFundsLock] read failed', err);
      if (!cancelled) setState({ loaded: true, chain: {}, local: {} });
    });
    return () => {
      cancelled = true;
    };
  }, [lock, generation]);

  // The chain is the source of truth for the withdrawal. The recorded time is only for a chain that does not answer.
  const withdrawableAt = state.chain.withdrawal?.withdrawableAt ?? state.local.withdrawableAt;
  const countdownRunning = withdrawableAt !== undefined;
  const now = useNowSec(countdownRunning);
  const secondsLeft = withdrawableAt === undefined ? undefined : secondsUntilWithdrawable(withdrawableAt, now);
  const phase = withdrawPhaseOf(state.chain.withdrawal?.status, state.local.enabledAt !== undefined, secondsLeft);
  const withdrawalOn = phase === 'pending' || phase === 'due';
  const refusal = connected ? sponsorWalletRefusal(address, lock.sponsorAddress) : 'walletDisconnected';

  const run = useCallback(
    async (action: LockAction, operation: () => Promise<unknown>) => {
      if (busy !== undefined) return;
      hapticMedium();
      setBusy(action);
      setError(undefined);
      try {
        await operation();
      } catch (cause) {
        console.error(`[RecoverLockedFundsLock] ${action} failed`, cause);
        setError(lockedDepositErrorDisplay(cause, t, { network, address: sponsor }));
      } finally {
        setBusy(undefined);
        requestLockRescan();
      }
    },
    [busy, network, sponsor, t]
  );

  const handleWithdraw = useCallback(
    () =>
      run('withdraw', async () => {
        if (phase === 'due') {
          await finishLockWithdrawal(lock);
          setWithdrawn(true);
          return;
        }
        await startLockWithdrawal(lock);
      }),
    [lock, phase, run]
  );
  const handleCancel = useCallback(
    () =>
      run('cancel', async () => {
        await cancelLockWithdrawal(lock);
        if (withdrawn) setWithdrawalDisabled(true);
      }),
    [lock, run, withdrawn]
  );
  const retryTxId = state.local.retryTxId;
  const handleRetry = useCallback(
    () => run('retry', async () => (retryTxId === undefined ? undefined : retryLockedDeposit(retryTxId))),
    [retryTxId, run]
  );

  const balance = state.chain.balance;
  const balanceContent = (() => {
    if (!state.loaded) return t('recoverFundsChecking');
    if (balance === undefined) return t('recoverFundsCouldNotCheckShort');
    // A token the document does not list has no known scale, so the page never guesses one.
    if (token === undefined) return t('assetValueUnknownScale');
    return (
      <TokenAmount
        amount={balance}
        decimals={token.decimals}
        symbol={token.symbol}
        formatting="exact"
        rounding="down"
      />
    );
  })();
  const withdrawalText = (() => {
    if (!state.loaded) return t('recoverFundsChecking');
    switch (phase) {
      case 'off':
        return t('recoverFundsWithdrawOff');
      case 'pending':
        return secondsLeft === undefined
          ? t('epochDepositWithdrawStartedUnknown')
          : t('epochDepositWithdrawStarted', { time: formatWithdrawCountdown(secondsLeft) });
      case 'due':
        return t('epochDepositWithdrawReady');
      case 'unknown':
      default:
        return t('recoverFundsCouldNotCheckShort');
    }
  })();
  const empty = balance === 0n && !withdrawalOn;

  const connectHint = (() => {
    switch (refusal) {
      case 'walletDisconnected':
        return t('epochDepositConnectSponsor', { address: sponsor });
      case 'wrongAccount':
        return t('epochDepositWrongWallet', { address: sponsor });
      case undefined:
      default:
        return undefined;
    }
  })();

  const connectButton = (
    <Button
      variant={ButtonVariant.Secondary}
      title={refusal === 'wrongAccount' ? t('switchWallet') : t('connectEvmWallet')}
      onClick={openWalletPicker}
      data-testid="recover-funds-lock-connect"
      className="w-full max-w-none"
    />
  );

  const cancelButton = (
    <Button
      variant={ButtonVariant.Secondary}
      title={busy === 'cancel' ? t('recoverFundsCancelling') : t('recoverFundsCancelWithdrawal')}
      onClick={handleCancel}
      disabled={busy !== undefined}
      data-testid="recover-funds-lock-cancel"
      className="w-full max-w-none"
    />
  );

  const actions = (() => {
    if (withdrawn) {
      return (
        <>
          <Button
            variant={ButtonVariant.Primary}
            title={t('returnToLockedFunds')}
            onClick={() => navigate(RECOVER_FUNDS_PATH)}
            data-testid="recover-funds-return-to-list"
            className="w-full max-w-none"
          />
          <Button
            variant={ButtonVariant.Secondary}
            title={t('home')}
            onClick={() => navigate('/')}
            data-testid="recover-funds-return-home"
            className="w-full max-w-none"
          />
          {!withdrawalDisabled && (refusal === undefined ? cancelButton : connectButton)}
        </>
      );
    }
    // An empty lock with no withdrawal on leaves the sponsor nothing to do.
    if (refusal === undefined && empty) return undefined;
    if (refusal !== undefined) return connectButton;
    return (
      <>
        {retryTxId !== undefined && (
          <Button
            variant={ButtonVariant.Primary}
            title={busy === 'retry' ? t('epochDepositRetrying') : t('epochDepositRetry')}
            onClick={handleRetry}
            disabled={busy !== undefined}
            data-testid="recover-funds-lock-retry"
            className="w-full max-w-none"
          />
        )}
        <Button
          variant={retryTxId === undefined ? ButtonVariant.Primary : ButtonVariant.Secondary}
          title={busy === 'withdraw' ? t('epochDepositWithdrawing') : t('epochDepositWithdraw')}
          onClick={handleWithdraw}
          disabled={busy !== undefined || phase === 'pending' || !state.loaded}
          data-testid="recover-funds-lock-withdraw"
          className="w-full max-w-none"
        />
        {withdrawalOn && cancelButton}
      </>
    );
  })();

  const showCancellationUi = !withdrawn || !withdrawalDisabled;

  return (
    <SubPageLayout
      title={t('recoverFundsLockTitle')}
      onBack={onBack}
      footer={actions}
      footerLayout="stack"
      data-testid={withdrawn ? 'recover-funds-withdrawal-success' : 'recover-funds-lock-page'}
    >
      <SubPageSection footnote={showCancellationUi ? connectHint : undefined}>
        {withdrawn ? (
          <EmptyState
            icon={IconName.ShieldCheck}
            title={t('bridgeWithdrawalSuccessful')}
            data-testid="recover-funds-withdrawal-success-state"
          />
        ) : (
          <DetailCard>
            <DetailRow label={t('recoverFundsWallet')} stacked>
              <span className="font-mono select-text" data-testid="recover-funds-lock-sponsor">
                {lock.sponsorAddress}
              </span>
            </DetailRow>
            <DetailRow label={t('network')}>{network}</DetailRow>
            <DetailRow label={t('recoverFundsLocked')} data-testid="recover-funds-lock-balance">
              {balanceContent}
            </DetailRow>
            <DetailRow label={t('recoverFundsWithdrawal')} data-testid="recover-funds-lock-status">
              {withdrawalText}
            </DetailRow>
          </DetailCard>
        )}
      </SubPageSection>
      {empty && (
        <EmptyState
          icon={IconName.ShieldCheck}
          size="compact"
          title={t('recoverFundsLockEmpty')}
          data-testid="recover-funds-lock-empty"
        />
      )}
      {showCancellationUi && (
        <>
          {/* This notice is never an error display: its tone is warning or neutral, so it has no error id. */}
          <Notice
            tone={withdrawn || withdrawalOn ? 'warning' : 'neutral'}
            errorId={null}
            icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
            data-testid="recover-funds-lock-notice"
          >
            {t('recoverFundsWithdrawBlocksBridge', { token: tokenSymbol, address: sponsor })}
          </Notice>
          <ErrorLine errorId={error?.id ?? EVM_WALLET_PICKER_ERROR_ID} data-testid="recover-funds-lock-error">
            {error?.text ?? pickerError}
          </ErrorLine>
        </>
      )}
    </SubPageLayout>
  );
};

export default RecoverLockedFundsLock;
