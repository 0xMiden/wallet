import React, { useRef, useState } from 'react';

import { wordlists } from 'bip39';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { requestSWTransactionProcessing } from 'lib/miden/activity';
import { getRecoveryAction } from 'lib/miden/back/recovery-authorization';
import type { ITransaction } from 'lib/miden/db/types';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { ImportSeedPhraseScreen } from 'screens/onboarding/import-wallet-flow/ImportSeedPhrase';

interface Props {
  transaction: ITransaction;
  onClose: () => void;
}

export const RecoverySeedPrompt: React.FC<Props> = ({ transaction, onClose }) => {
  const { t } = useTranslation();
  const provideSeed = useWalletStore(s => s.provideRecoverySeed);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inputVersion, setInputVersion] = useState(0);
  const busy = useRef(false);

  useMobileBackHandler(() => {
    onClose();
    return true;
  }, [onClose]);

  const submit = async (mnemonic: string) => {
    if (busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await provideSeed(transaction.id, mnemonic, getRecoveryAction(transaction));
      setInputVersion(version => version + 1);
      if (isExtension()) requestSWTransactionProcessing();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('invalidRecoverySeed'));
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-app-bg text-text-primary-token pb-6">
      <NavigationHeader onBack={onClose} />
      {transaction.type === 'switch-guardian' && (
        <p className="px-4 break-all">{transaction.extraInputs?.newGuardianEndpoint}</p>
      )}
      {error && (
        <p role="alert" className="px-4 py-3">
          {error}
        </p>
      )}
      <ImportSeedPhraseScreen
        key={inputVersion}
        wordslist={wordlists.english ?? []}
        titleKey="recoverySeedRequiredTitle"
        descriptionKey="recoverySeedTemporaryDescription"
        submitting={submitting}
        onSubmit={submit}
      />
      <div className="px-4 pt-4">
        <Button title={t('close')} variant={ButtonVariant.Secondary} onClick={onClose} />
      </div>
    </div>
  );
};
