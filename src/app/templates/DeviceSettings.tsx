import React, { useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { StrictActionAuthentication } from 'components/StrictActionAuthentication';
import { Button, ButtonVariant } from 'components/ui/Button';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import type { StrictAuthenticationResult } from 'lib/auth/strict-action-authentication';
import {
  initiateRevokeDeviceTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { useDeviceSigners } from 'lib/miden/front/useDeviceSigners';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useConfirm } from 'lib/ui/dialog';
import { navigate } from 'lib/woozie';

const DeviceSettings: React.FC = () => {
  const { t } = useTranslation();
  const account = useWalletStore(state => state.currentAccount);
  const seedStatus = useWalletStore(state => state.seedPhraseStatus);
  const { signTransaction } = useMidenContext();
  const confirm = useConfirm();
  const [refresh, setRefresh] = useState(0);
  const { devices, failed } = useDeviceSigners(account, refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [authTarget, setAuthTarget] = useState<{ accountId: string; commitment: string } | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    setAuthTarget(null);
  }, [account?.publicKey]);
  useMobileBackHandler(() => {
    if (!authTarget) return false;
    setAuthTarget(null);
    return true;
  }, [authTarget]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentAccountId = useRef(account?.publicKey);
  currentAccountId.current = account?.publicKey;

  const revoke = async (commitment: string) => {
    if (!account || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const accepted = await confirm({
        title: t('revokeDevice'),
        children: (
          <>
            <p>{t('revokeDeviceDescription')}</p>
            <p className="break-all">{commitment}</p>
          </>
        ),
        confirmLabel: t('revokeDevice'),
        destructive: true
      });
      if (!accepted || !mounted.current || currentAccountId.current !== account.publicKey) return;
      setAuthTarget({ accountId: account.publicKey, commitment });
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const authenticateAndRevoke = async (result: StrictAuthenticationResult) => {
    const target = authTarget;
    setAuthTarget(null);
    if (
      result !== 'authenticated' ||
      !target ||
      pending.current ||
      !mounted.current ||
      currentAccountId.current !== target.accountId
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const id = await initiateRevokeDeviceTransaction(
        target.accountId,
        target.commitment,
        isDelegateProofEnabled(),
        zustandProvider
      );
      if (isExtension()) requestSWTransactionProcessing();
      else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
      if (mounted.current && currentAccountId.current === target.accountId)
        navigate(`/generating-transaction-full/${encodeURIComponent(id)}`);
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (authTarget)
    return (
      <SubPageLayout data-testid="device-revoke-auth" onBack={() => setAuthTarget(null)}>
        <p className="text-caption text-muted break-all">{authTarget.commitment}</p>
        <StrictActionAuthentication reason={t('deviceRevokeAuthentication')} onResult={authenticateAndRevoke} />
      </SubPageLayout>
    );

  return (
    <SubPageLayout data-testid="device-settings">
      <p className="text-explainer text-muted">{t('deviceSignersDescription')}</p>
      <p className="text-body-sm text-muted">
        {t(seedStatus === 'stored' ? 'deviceRecoveryStored' : 'deviceRecoveryRequired')}
      </p>
      {error && (
        <Notice tone="negative" role="alert" errorId="smthWentWrong">
          {t('smthWentWrong')}
        </Notice>
      )}
      {failed && (
        <Notice tone="negative" role="alert" errorId="smthWentWrong">
          {t('deviceSignersUnavailable')}
        </Notice>
      )}
      {!devices && !failed && (
        <p role="status" className="text-body-sm text-muted">
          {t('loading')}
        </p>
      )}
      {devices && (
        <ListGroup surface="plain">
          {devices.map((device, index) => (
            <ListRow
              key={device.commitment}
              title={t('deviceSignerNumber', { number: index + 1 })}
              subtitle={<span className="break-all select-text">{device.commitment}</span>}
              trailing={
                device.current ? (
                  <Pill size="sm">{t('currentDevice')}</Pill>
                ) : (
                  <Button
                    size="sm"
                    variant={ButtonVariant.Destructive}
                    title={t('revokeDevice')}
                    disabled={busy || !devices.some(item => item.current)}
                    onClick={() => {
                      revoke(device.commitment);
                    }}
                  />
                )
              }
            />
          ))}
        </ListGroup>
      )}
      <Button
        variant={ButtonVariant.Secondary}
        title={t('refresh')}
        disabled={busy}
        onClick={() => setRefresh(value => value + 1)}
      />
    </SubPageLayout>
  );
};

export default DeviceSettings;
