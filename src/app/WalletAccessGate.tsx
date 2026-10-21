import React, { FC, PropsWithChildren, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { Spinner } from 'components/ui/Spinner';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import type { GeoLookup } from 'lib/remote-config/geo';
import { initFeatureEligibility } from 'lib/remote-config/runtime';

export const WalletAccessGate: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const [geo, setGeo] = useState<GeoLookup>({ state: 'loading' });

  useEffect(() => {
    let mounted = true;
    void loadEndpointOverrides()
      .then(() => initFeatureEligibility())
      .then(result => {
        if (mounted) setGeo(result);
      })
      .catch(() => {
        if (mounted) setGeo({ state: 'failed' });
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (geo.state === 'ready' && geo.allowed.wallet) return <>{children}</>;

  const status = geo.state === 'ready' ? 'restricted' : geo.state === 'failed' ? 'unavailable' : 'loading';
  const title =
    status === 'restricted'
      ? 'walletAccessRestrictedTitle'
      : status === 'unavailable'
        ? 'walletAccessUnavailableTitle'
        : 'walletAccessCheckingTitle';
  const body =
    status === 'restricted'
      ? 'walletAccessRestrictedBody'
      : status === 'unavailable'
        ? 'walletAccessUnavailableBody'
        : 'walletAccessCheckingBody';

  return (
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
          <Button
            variant={ButtonVariant.Secondary}
            onClick={() => window.location.reload()}
            data-testid="wallet-access-retry"
          >
            {t('retry')}
          </Button>
        )}
      </section>
    </main>
  );
};
