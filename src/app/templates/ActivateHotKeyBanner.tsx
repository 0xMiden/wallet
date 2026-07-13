import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { PromptCard } from 'components/ui';
import { initiateReplaceHotKeyTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { navigate } from 'lib/woozie';

interface Props {
  className?: string;
}

/**
 * Post-recovery prompt: Guardian accounts adopted via seed-phrase lookup have
 * no usable local hot key (the on-chain hot's secret is unrecoverable). Tapping
 * the prompt fires a cold-signed `replace_signer` rotation that mints a fresh
 * hot key and swaps it on-chain. `requiresHotKeyRotation` clears once
 * `Vault.swapHotKey` lands, at which point this returns null.
 *
 * Now renders through the shared PromptCard so it can sit inside the
 * home-page PromptCarousel alongside other notices.
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
      const txId = await initiateReplaceHotKeyTransaction(account.publicKey, isDelegateProofEnabled(), zustandProvider);
      if (isExtension()) requestSWTransactionProcessing();
      navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [account.publicKey, submitting]);

  return (
    <PromptCard
      title={t('activateHotKeyBannerTitle')}
      body={error ?? t('activateHotKeyBannerBody')}
      variant="warning"
      onClick={onClick}
      className={className}
    />
  );
};

export default ActivateHotKeyBanner;
