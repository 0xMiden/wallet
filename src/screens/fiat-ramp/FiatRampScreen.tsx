import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { startBuySession } from 'lib/fiat-ramp/buy-session';
import { fetchSignedMoonPayUrl, MOONPAY_IFRAME_ALLOW } from 'lib/fiat-ramp/moonpay';
import { useAccount } from 'lib/miden/front';
import { navigate } from 'lib/woozie';

// `credentialless` iframes (Chrome 110+) are exempt from COEP's CORP
// requirement — the extension pages run under `cross_origin_embedder_policy:
// require-corp` (manifest.json) and MoonPay sends no CORP header, so without
// this the frame is blocked ("refused to connect"). Not yet in React's types.
declare module 'react' {
  interface IframeHTMLAttributes<T> extends HTMLAttributes<T> {
    credentialless?: string;
  }
}

/**
 * Routed `/buy` screen: the MoonPay Buy widget embedded as a plain iframe.
 * The widget URL pre-fills the account's derived EVM deposit address, which
 * requires an HMAC signature from the local sign server — the only async step
 * before the iframe can mount.
 */
const FiatRampScreen: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const evmAddress = account.evmAddress;

  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    if (!evmAddress) return;
    setError(false);
    setUrl(null);
    fetchSignedMoonPayUrl(evmAddress, startBuySession())
      .then(setUrl)
      .catch(err => {
        console.warn('[moonpay] failed to build signed widget URL', err);
        setError(true);
      });
  }, [evmAddress]);

  useEffect(load, [load]);

  const close = useCallback(() => navigate('/'), []);

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={t('fiatRampTitleBuy')} onClose={close} closeLabel={t('close')} className="px-4" />
      <div className="flex-1 min-h-0">
        {!evmAddress ? (
          <p className="p-4 text-sm text-text-muted">{t('fiatRampNoEvmAddress')}</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-4 p-4">
            <p className="text-sm text-text-muted">{t('fiatRampWidgetError')}</p>
            <Button variant={ButtonVariant.Secondary} title={t('tryAgain')} onClick={load} />
          </div>
        ) : url ? (
          <iframe
            src={url}
            title={t('fiatRampTitleBuy')}
            allow={MOONPAY_IFRAME_ALLOW}
            credentialless=""
            className="h-full w-full"
          />
        ) : (
          <p className="p-4 text-sm text-text-muted">{t('fiatRampLoading')}</p>
        )}
      </div>
    </div>
  );
};

export default FiatRampScreen;
