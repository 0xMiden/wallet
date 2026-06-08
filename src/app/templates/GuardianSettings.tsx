import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import GuardianReplaceHotKey from 'app/templates/GuardianReplaceHotKey';
import { initiateSwitchGuardianTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';

const GuardianSettings: FC = () => {
  const { t } = useTranslation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  // Two-stage submit: first click validates + enters confirming, second click fires the tx.
  // switch_guardian requires the cold key (co-signed by the current guardian),
  // so the confirmation step mirrors the cold-signing acknowledgement pattern.
  const [confirming, setConfirming] = useState(false);
  const [pendingEndpoint, setPendingEndpoint] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentAccount = useWalletStore(s => s.currentAccount);

  const runSwitch = useCallback(
    async (newEndpoint: string) => {
      if (!currentAccount) return;
      setSubmitting(true);
      setError(null);
      try {
        const txId = await initiateSwitchGuardianTransaction(
          currentAccount.publicKey,
          newEndpoint,
          isDelegateProofEnabled(),
          zustandProvider
        );
        if (isExtension()) requestSWTransactionProcessing();
        navigate({
          pathname: '/generating-transaction-full',
          search: `?txId=${encodeURIComponent(txId)}`
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setSubmitting(false);
      }
    },
    [currentAccount]
  );

  const handleSubmit = useCallback(
    ({ guardianEndpoint }: { guardianId: string; guardianEndpoint: string }) => {
      if (submitting || !currentAccount) return;

      if (guardianEndpoint === currentEndpoint) {
        setError(t('guardianEndpointUnchanged'));
        setConfirming(false);
        setPendingEndpoint(null);
        return;
      }

      setError(null);

      if (!confirming || pendingEndpoint !== guardianEndpoint) {
        setConfirming(true);
        setPendingEndpoint(guardianEndpoint);
        return;
      }

      void runSwitch(guardianEndpoint);
    },
    [confirming, currentAccount, currentEndpoint, pendingEndpoint, runSwitch, submitting, t]
  );

  return (
    <div className="w-full max-w-sm p-2 mx-auto">
      <div className="mb-4">
        <p className="text-sm text-heading-gray font-medium mb-1">{t('currentGuardianEndpoint')}</p>
        <p className="text-sm text-black break-all select-text">{currentEndpoint || t('loading')}</p>
      </div>

      <ChooseGuardianScreen
        onSubmit={handleSubmit}
        currentEndpoint={currentEndpoint}
        hideHeader
        submitLabel={submitting ? t('loading') : confirming ? t('confirmSwitchGuardian') : t('switchGuardian')}
      />

      {confirming && !submitting && (
        <div className="text-xs text-heading-gray mt-3 select-text">{t('switchGuardianConfirmation')}</div>
      )}

      {error && <div className="mt-3 text-red-500 text-xs select-text">{error}</div>}

      <hr className="my-6" />

      <GuardianReplaceHotKey />
    </div>
  );
};

export default GuardianSettings;

function useCurrentGuardianEndpoint(): { endpoint: string; refresh: () => void } {
  const [endpoint, setEndpoint] = useState<string>('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)
      .then(stored => {
        if (cancelled) return;
        setEndpoint(stored ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        setEndpoint('');
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Extension builds get storage-change events for free; on mobile/desktop this
  // is a no-op and the explicit refresh() call after switch handles the update.
  useEffect(
    () =>
      onStorageChanged<string>(GUARDIAN_URL_STORAGE_KEY, next => {
        setEndpoint(next ?? '');
      }),
    []
  );

  return { endpoint, refresh };
}
