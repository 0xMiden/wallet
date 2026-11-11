import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { isAddress } from 'viem';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
import { compactLockId, readCompactLockConfig, readCompactLockState } from 'lib/epoch/bridge-in-lock-scan';
import { cancelLockWithdrawal, type CompactLockRef } from 'lib/epoch/bridge-in-recovery';
import { requestLockRescan } from 'lib/epoch/lock-scan-refresh';
import { getChain } from 'lib/walletconnect/config';

import { lockedDepositErrorText } from './locked-deposit-error-text';
import { shortenAddress } from './shared';

interface EpochWithdrawalGateProps {
  chainId: number;
  tokenAddress: string;
  tokenLabel: string;
  sponsorAddress: string;
  allocatorUrl: string;
  onDisabled: () => Promise<void> | undefined;
  alternative?: { label: string; onSelect: () => void };
  children: React.ReactNode;
}

type WithdrawalCheck =
  | { status: 'checking' }
  | { status: 'failed' }
  | { status: 'ready'; lock: CompactLockRef; active: boolean };

/** Check the selected lock before the bridge can submit. Mount a new gate when the lock or sponsor changes. */
export const EpochWithdrawalGate: React.FC<EpochWithdrawalGateProps> = ({
  chainId,
  tokenAddress,
  tokenLabel,
  sponsorAddress,
  allocatorUrl,
  onDisabled,
  alternative,
  children
}) => {
  const { t } = useTranslation();
  const [check, setCheck] = useState<WithdrawalCheck>({ status: 'checking' });
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const mounted = useRef(false);
  const network = getChain(chainId)?.name ?? String(chainId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCheck({ status: 'checking' });
    const load = async () => {
      if (!isAddress(sponsorAddress)) throw new Error('Invalid bridge sponsor address.');
      const config = await readCompactLockConfig(allocatorUrl, chainId);
      const lockId = compactLockId(config.allocator, config.resetPeriod, config.scope, tokenAddress);
      const state = await readCompactLockState(chainId, sponsorAddress, lockId);
      if (state.withdrawal === undefined) throw new Error('Could not read the forced withdrawal status.');
      if (cancelled) return;
      setCheck({
        status: 'ready',
        lock: { chainId, lockId: lockId.toString(), sponsorAddress },
        active: state.withdrawal.status !== 'Disabled'
      });
    };
    load().catch(() => {
      if (!cancelled) setCheck({ status: 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [allocatorUrl, chainId, tokenAddress, sponsorAddress, generation]);

  const disable = useCallback(async () => {
    if (running.current || check.status !== 'ready' || !check.active) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await cancelLockWithdrawal(check.lock);
      requestLockRescan();
      if (!mounted.current) return;
      // A fresh quote must replace any quote refused while withdrawal was active.
      await onDisabled();
      if (mounted.current) setCheck({ ...check, active: false });
    } catch (cause) {
      if (mounted.current) {
        setError(lockedDepositErrorText(cause, t, { network, address: shortenAddress(sponsorAddress) }));
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [check, network, onDisabled, sponsorAddress, t]);

  if (check.status === 'ready' && !check.active) return <>{children}</>;

  const checking = check.status === 'checking';
  const failed = check.status === 'failed';
  const copy = (() => {
    switch (check.status) {
      case 'checking':
        return { action: t('recoverFundsChecking'), body: t('bridgeWithdrawalChecking') };
      case 'failed':
        return { action: t('retry'), body: t('bridgeWithdrawalCheckFailed') };
      case 'ready':
        return {
          action: t('bridgeWithdrawalDisable'),
          body: t('bridgeWithdrawalBody', { token: tokenLabel, network })
        };
    }
  })();

  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <div className="flex w-full flex-col gap-3">
          <Button
            title={busy ? t('bridgeWithdrawalDisabling') : copy.action}
            accent="receive"
            disabled={checking || busy}
            aria-busy={checking || busy}
            onClick={failed ? () => setGeneration(value => value + 1) : disable}
            className="w-full max-w-none"
            data-testid="bridge-withdrawal-disable"
          />
          {alternative && (
            <Button
              title={alternative.label}
              variant={ButtonVariant.Secondary}
              onClick={alternative.onSelect}
              disabled={busy}
              className="w-full max-w-none"
              data-testid="bridge-withdrawal-alternative"
            />
          )}
        </div>
      }
    >
      <SectionHeader size="lg">{t('bridgeWithdrawalTitle')}</SectionHeader>
      <Notice tone={failed ? 'warning' : 'neutral'} role="status" data-testid="bridge-withdrawal-notice">
        {copy.body}
      </Notice>
      {check.status === 'ready' && (
        <Notice variant="inline" className="mt-4" role="status">
          {t(busy ? 'bridgeWithdrawalWalletPrompt' : 'bridgeWithdrawalEffect', { network })}
        </Notice>
      )}
      <ErrorLine className="mt-4" data-testid="bridge-withdrawal-error">
        {error}
      </ErrorLine>
    </HomeGroupPaneBody>
  );
};
