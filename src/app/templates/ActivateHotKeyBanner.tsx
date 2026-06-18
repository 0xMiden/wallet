import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { initiateReplaceHotKeyTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';

interface Props {
  className?: string;
}

/**
 * Surfaces post-recovery: Guardian accounts adopted via seed-phrase lookup have
 * no usable local hot key (the on-chain hot's secret is unrecoverable). The
 * banner CTA fires a cold-signed `replace_signer` rotation that mints a fresh
 * hot key and swaps it on-chain. `requiresHotKeyRotation` clears once
 * `Vault.swapHotKey` lands, at which point the banner self-hides.
 */
export const ActivateHotKeyBanner: FC<Props> = ({ className }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    if (submitting) return;
    hapticLight();
    setSubmitting(true);
    setError(null);
    try {
      await initiateReplaceHotKeyTransaction(account.publicKey, isDelegateProofEnabled(), zustandProvider);
      useWalletStore.getState().openTransactionModal();
      if (isExtension()) requestSWTransactionProcessing();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [account.publicKey, submitting]);

  if (!account.requiresHotKeyRotation) return null;

  return (
    <div
      className={classNames('min-h-14 flex items-center bg-white px-4 gap-x-2 py-2 rounded-t-3xl', className)}
      data-testid="activate-hot-key-banner"
    >
      <div className="flex items-center">
        <Icon name={IconName.InformationFill} size="md" fill="#5b8def" />
      </div>
      <div className="flex-1 flex flex-col justify-center items-start min-w-0">
        <p className="text-black text-sm font-medium">{t('activateHotKeyBannerTitle')}</p>
        <p className="text-gray-600 text-xs">{error ?? t('activateHotKeyBannerBody')}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={submitting}
        className="text-xs font-medium text-primary-500 px-2 py-1 rounded-md hover:bg-gray-100 disabled:opacity-50"
      >
        {t('activateHotKeyBannerCta')}
      </button>
    </div>
  );
};

export default ActivateHotKeyBanner;
