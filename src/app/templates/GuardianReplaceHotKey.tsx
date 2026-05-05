import React, { FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import FormSubmitButton from 'app/atoms/FormSubmitButton';
import {
  initiateReplaceHotKeyTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';

type Props = {
  onClose?: () => void;
};

/**
 * Proactive hot-key rotation. Cold-signed (recovery key); the on-chain proposal
 * swaps the hot signer commitment in-place via update_signers. The seed phrase
 * is NOT required — the cold key derived at create time is already in the vault.
 */
const GuardianReplaceHotKey: FC<Props> = ({ onClose }) => {
  const { t } = useTranslation();
  const currentAccount = useWalletStore(s => s.currentAccount);

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const onClick = useCallback(async () => {
    if (!currentAccount) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      const txId = await initiateReplaceHotKeyTransaction(
        currentAccount.publicKey,
        isDelegateProofEnabled(),
        zustandProvider
      );
      useWalletStore.getState().openTransactionModal();
      if (isExtension()) requestSWTransactionProcessing();

      const result = await waitForTransactionCompletion(txId);
      if ('errorMessage' in result) {
        setError(result.errorMessage);
        return;
      }
      setSuccess(true);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [confirming, currentAccount]);

  return (
    <div className="w-full pb-10">
      <p className="text-sm text-heading-gray font-medium mb-1">{t('replaceHotKey')}</p>
      <p className="text-xs text-heading-gray mb-3 select-text">{t('replaceHotKeyDescription')}</p>

      {confirming && !success && (
        <div className="text-xs text-heading-gray mb-3 select-text">{t('replaceHotKeyConfirmation')}</div>
      )}

      <FormSubmitButton
        type="button"
        onClick={onClick}
        loading={submitting}
        disabled={!currentAccount || submitting}
        className="capitalize w-full justify-center"
        style={{
          fontSize: '16px',
          lineHeight: '20px',
          paddingTop: '10px',
          paddingBottom: '10px'
        }}
      >
        {confirming ? t('confirmReplaceHotKey') : t('replaceHotKey')}
      </FormSubmitButton>

      {error && <div className="mt-3 text-red-600 text-sm font-medium select-text">{error}</div>}

      {success && (
        <div className="mt-3 text-green-600 text-sm font-medium" onAnimationEnd={() => onClose?.()}>
          {t('hotKeyRotated')}
        </div>
      )}
    </div>
  );
};

export default GuardianReplaceHotKey;
