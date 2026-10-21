import React, { FC, PropsWithChildren, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { Spinner } from 'components/ui/Spinner';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import {
  ensureWalletAccessAllowed,
  getWalletAccessSnapshot,
  subscribeWalletAccess
} from 'lib/remote-config/wallet-access';

export const WalletAccessGate: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const access = useSyncExternalStore(subscribeWalletAccess, getWalletAccessSnapshot);
  const [booted, setBooted] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [hasOpened, setHasOpened] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const allowed = booted && access.status === 'allowed';
  const status = bootFailed ? 'unavailable' : !booted ? 'loading' : access.status;

  useEffect(() => {
    if (allowed) setHasOpened(true);
    else if (status !== 'loading') setHasOpened(false);
    contentRef.current?.toggleAttribute('inert', !allowed);
  }, [allowed, status]);

  useEffect(() => {
    let mounted = true;
    setBootFailed(false);
    void loadEndpointOverrides()
      .then(() => initBridgeConfig())
      .then(() => {
        if (mounted) setBooted(true);
      })
      .catch(() => {
        if (mounted) setBootFailed(true);
      });
    return () => {
      mounted = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (booted && access.status === 'loading') void ensureWalletAccessAllowed().catch(() => undefined);
  }, [booted, access.status]);

  const retry = useCallback(() => {
    if (!booted) setAttempt(value => value + 1);
    else void ensureWalletAccessAllowed().catch(() => undefined);
  }, [booted]);

  const [title, body] =
    status === 'restricted'
      ? (['walletAccessRestrictedTitle', 'walletAccessRestrictedBody'] as const)
      : status === 'unavailable'
        ? (['walletAccessUnavailableTitle', 'walletAccessUnavailableBody'] as const)
        : (['walletAccessCheckingTitle', 'walletAccessCheckingBody'] as const);

  return (
    <>
      <div ref={contentRef} hidden={!allowed} style={{ display: allowed ? 'contents' : 'none' }}>
        {(allowed || (hasOpened && status === 'loading')) && children}
      </div>
      {!allowed && (
        <main
          data-testid="wallet-access-gate"
          data-access-state={status}
          className="min-h-screen bg-page text-ink flex items-center justify-center px-6 py-12 font-inter antialiased"
        >
          <section className="w-full max-w-92.5 flex flex-col items-center text-center gap-4" aria-live="polite">
            {status === 'loading' && <Spinner size="lg" />}
            <h1 className="text-xl font-semibold">{t(title)}</h1>
            <p className="text-sm text-muted leading-relaxed">{t(body)}</p>
            {status !== 'loading' && (
              <Button variant={ButtonVariant.Secondary} onClick={retry} data-testid="wallet-access-retry">
                {t('retry')}
              </Button>
            )}
          </section>
        </main>
      )}
    </>
  );
};
