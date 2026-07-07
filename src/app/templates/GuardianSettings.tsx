import React, { FC, useCallback, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import GuardianReplaceHotKey from 'app/templates/GuardianReplaceHotKey';
import {
  initiateSwitchGuardianTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { isExtension } from 'lib/platform';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { isDelegateProofEnabled, sanitizeGuardianUrl } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';

type Props = {
  onClose?: () => void;
};

const GuardianSettings: FC<Props> = ({ onClose }) => {
  const { t } = useTranslation();
  const currentEndpoint = useCurrentGuardianEndpoint();
  const [submitSuccess, setSubmitSuccess] = useState(false);
  // Two-stage submit: first tap validates + enters confirming, second tap fires the tx.
  // switch_guardian requires the cold key (co-signed by the current guardian),
  // so the confirmation step mirrors the cold-signing acknowledgement pattern.
  const [pendingEndpoint, setPendingEndpoint] = useState<string | null>(null);
  // `confirming` is fully derived from `pendingEndpoint` — a pending endpoint IS
  // the confirming state — so the two can never drift out of sync.
  const confirming = pendingEndpoint !== null;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentAccount = useWalletStore(s => s.currentAccount);

  const runSwitch = useCallback(
    async (newEndpoint: string) => {
      if (!currentAccount) return;
      setSubmitting(true);
      setError(null);
      setSubmitSuccess(false);
      try {
        const txId = await initiateSwitchGuardianTransaction(
          currentAccount.publicKey,
          newEndpoint,
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

        setSubmitSuccess(true);
        setPendingEndpoint(null);
        // No manual refresh needed: completing the switch persists the new endpoint
        // and broadcasts `accountsUpdated`, so `useCurrentGuardianEndpoint` (a reactive
        // store selector) re-renders the "Current guardian" display on its own.
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
      setSubmitSuccess(false);

      if (guardianEndpoint === currentEndpoint) {
        setError(t('guardianEndpointUnchanged'));
        setPendingEndpoint(null);
        return;
      }

      setError(null);

      if (!confirming || pendingEndpoint !== guardianEndpoint) {
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
        allowCustomEndpoint
        submitLabel={submitting ? t('loading') : confirming ? t('confirmSwitchGuardian') : t('switchGuardian')}
      />

      {confirming && !submitting && !submitSuccess && (
        <div className="text-xs text-heading-gray mt-3 select-text">{t('switchGuardianConfirmation')}</div>
      )}

      {error && <div className="mt-3 text-red-500 text-xs select-text">{error}</div>}

      {submitSuccess && (
        <div className="mt-4 text-green-600 text-sm font-medium" onAnimationEnd={() => onClose?.()}>
          {t('guardianSwitched')}
        </div>
      )}

      <hr className="my-6" />

      <GuardianReplaceHotKey onClose={onClose} />
    </div>
  );
};

export default GuardianSettings;

// A wallet has a single Guardian account, so the current account's
// `guardianEndpoint` IS the wallet's guardian. Read it straight off the store as
// a reactive selector: when a switch persists the new endpoint and broadcasts
// `accountsUpdated`, this re-renders on its own — no manual storage read/refresh.
//
// For accounts created before the per-account field existed, mirror
// `resolveGuardianEndpoint`'s fallback to the legacy global
// `GUARDIAN_URL_STORAGE_KEY`, otherwise the "Current guardian" display (and the
// unchanged-endpoint guard) would misreport a legacy custom operator as the
// default one.
function useCurrentGuardianEndpoint(): string {
  const accountEndpoint = useWalletStore(s => s.currentAccount?.guardianEndpoint);
  const [legacyEndpoint, setLegacyEndpoint] = useState<string | null>(null);

  useEffect(() => {
    // The per-account field always wins; only consult the legacy global key when
    // the account predates it.
    if (accountEndpoint) {
      setLegacyEndpoint(null);
      return;
    }
    let active = true;
    fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)
      .then(stored => {
        if (active) setLegacyEndpoint(stored ?? null);
      })
      .catch(() => {
        if (active) setLegacyEndpoint(null);
      });
    // Extension builds get storage-change events for free; on mobile/desktop this
    // is a no-op cleanup.
    const unsubscribe = onStorageChanged<string>(GUARDIAN_URL_STORAGE_KEY, next => {
      setLegacyEndpoint(next ?? null);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountEndpoint]);

  return sanitizeGuardianUrl(accountEndpoint || legacyEndpoint || DEFAULT_GUARDIAN_ENDPOINT);
}
