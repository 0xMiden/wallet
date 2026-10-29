import React, { FC, PropsWithChildren, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import type { GeoLookup, StartupEligibilityDiagnostics } from 'lib/remote-config/geo';
import { initFeatureEligibility } from 'lib/remote-config/runtime';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';

const OVERRIDE_LOAD_FAILED: StartupEligibilityDiagnostics = {
  startupEligibilityStage: 'endpoint_overrides',
  startupEligibilityReason: 'override_load_failed',
  startupEligibilityRetry: 'not_attempted'
};

const INITIALIZATION_FAILED: GeoLookup = {
  state: 'failed',
  diagnostics: {
    startupEligibilityStage: 'config_initialization',
    startupEligibilityReason: 'config_initialization_failed',
    startupEligibilityRetry: 'not_attempted'
  }
};

export const WalletAccessGate: FC<PropsWithChildren> = ({ children }) => {
  performance.mark("proof-wallet-gate-render");
  const { t } = useTranslation();
  const [endpointsReady, setEndpointsReady] = useState(false);
  const [geo, setGeo] = useState<GeoLookup>({ state: 'loading' });
  useUserVisibleError(
    geo.state === 'failed' ? 'walletAccessUnavailableBody' : null,
    'startup',
    geo,
    geo.state === 'failed' ? geo.diagnostics : undefined
  );

  useEffect(() => {
    let mounted = true;
    void loadEndpointOverrides()
      .then(
        () => undefined,
        () => OVERRIDE_LOAD_FAILED
      )
      .then(overrideFailure => {
        // The executor runs now, so the lookup starts before the wallet mounts; a synchronous throw still settles.
        const decision = new Promise<GeoLookup>(resolve => resolve(initFeatureEligibility())).catch(
          () => INITIALIZATION_FAILED
        );
        performance.mark("proof-endpoints-ready");
        if (mounted) setEndpointsReady(true);
        return decision.then(
          (result): GeoLookup =>
            result.state === 'failed' && overrideFailure ? { state: 'failed', diagnostics: overrideFailure } : result
        );
      })
      .then(result => {
        if (mounted) setGeo(result);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (!endpointsReady) return null;
  if (geo.state !== 'ready' || geo.allowed.wallet) return <>{children}</>;

  return (
    <main
      data-testid="wallet-access-gate"
      data-access-state="restricted"
      className="min-h-screen bg-page text-ink flex items-center justify-center px-6 py-12 font-inter antialiased"
    >
      <section className="w-full max-w-92.5 flex flex-col items-center text-center gap-4" aria-live="polite">
        <h1 className="text-xl font-semibold">{t('walletAccessRestrictedTitle')}</h1>
        <p className="text-sm text-muted leading-relaxed">{t('walletAccessRestrictedBody')}</p>
        <Button
          variant={ButtonVariant.Secondary}
          onClick={() => window.location.reload()}
          data-testid="wallet-access-retry"
        >
          {t('retry')}
        </Button>
      </section>
    </main>
  );
};
