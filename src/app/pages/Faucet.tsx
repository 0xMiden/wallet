import React, { FC, useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { Button } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { getFaucetUrl } from 'lib/miden-chain/faucet';
import { useAccount, useNetwork } from 'lib/miden/front';
import { openFaucetWebview } from 'lib/mobile/faucet-webview';
import { isMobile } from 'lib/platform';
import { goBack } from 'lib/woozie';

async function copyTextToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    // Clipboard API not available, you may want to fallback to a more traditional method
    console.error('Clipboard API not available');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text to clipboard', err);
  }
}

const Faucet: FC = () => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const account = useAccount();
  const address = account.publicKey;
  const { trackEvent } = useAnalytics();
  const network = useNetwork();

  const openFaucet = useCallback(async () => {
    copyTextToClipboard(address);
    trackEvent('Faucet/AddressCopied', AnalyticsEventCategory.ButtonPress);
    setCopied(true);
    const faucetUrl = getFaucetUrl(network.id);
    await openFaucetWebview({ url: faucetUrl, title: t('midenFaucet') });
  }, [address, trackEvent, network.id, t]);

  // On mobile, open the faucet webview immediately and go back when closed
  useEffect(() => {
    if (isMobile()) {
      openFaucet().then(() => goBack());
    }
  }, [openFaucet]);

  // On mobile, show nothing while the webview is open
  if (isMobile()) {
    return null;
  }

  return (
    <div className={clsx('flex flex-col h-full text-heading-gray')}>
      <NavigationHeader mode="back" title={t('faucet')} onBack={goBack} showBorder />
      <div className={clsx('flex flex-col flex-1 min-h-0 w-full', isMobile() ? 'px-8' : 'px-4')}>
        <div className="flex flex-col flex-1 items-center justify-center">
          <div className="flex items-center justify-center mb-6 w-[156px] h-[156px]">
            <FaucetIcon className="text-primary-orange" style={{ width: 78, height: 78 }} />
          </div>
          <h1 className="font-semibold text-2xl">{t('midenFaucet')}</h1>
          <p className="text-sm text-center mt-2">{t('faucetMessage')}</p>
        </div>
        <div className="shrink-0 pb-4">
          <Button onClick={openFaucet} className="w-full">
            <span className="text-base font-medium text-pure-white">
              {copied ? t('copiedAddress') : t('goToFaucet')}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Faucet;
