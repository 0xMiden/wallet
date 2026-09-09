import React, { FC, useCallback, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import PageLayout from 'app/layouts/PageLayout';
import { NavigationHeader } from 'components/NavigationHeader';
import { useMidenContext } from 'lib/miden/front';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { ChooseGuardianScreen } from 'screens/onboarding/common/ChooseGuardian';
import { WalletType } from 'screens/onboarding/types';

/**
 * Guardian-operator picker for the add-account flow (BalanceCard "+" →
 * "Guardian-backed"). On submit it creates the new Guardian account bound to
 * the chosen endpoint (auto-named "Account N"), switches to it, and returns
 * home.
 */
const AddAccountGuardian: FC = () => {
  const { t } = useTranslation();
  const { createAccount, updateCurrentAccount } = useMidenContext();
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const creatingRef = useRef(false);
  const handleBack = useBackWithFallback('/');

  useMobileBackHandler(() => {
    handleBack();
    return true;
  }, [handleBack]);

  const handleSubmit = useCallback(
    async ({ guardianEndpoint }: { guardianId: string; guardianEndpoint: string }) => {
      // Account creation does seconds of WASM + network work; ignore re-taps
      // of Continue while the first one is in flight.
      if (creatingRef.current) return;
      creatingRef.current = true;
      setIsCreating(true);
      setError(null);
      const prevKeys = new Set(useWalletStore.getState().accounts.map(a => a.publicKey));
      try {
        // No name: the vault auto-names it "Account N".
        await createAccount(WalletType.Guardian, undefined, guardianEndpoint);
        const created = useWalletStore.getState().accounts.find(a => !prevKeys.has(a.publicKey));
        if (created) {
          await updateCurrentAccount(created.publicKey);
        }
        navigate('/');
      } catch (err) {
        console.error('[AddAccountGuardian] create account failed', err);
        setError(err instanceof Error ? err.message : t('smthWentWrong'));
      } finally {
        creatingRef.current = false;
        setIsCreating(false);
      }
    },
    [createAccount, updateCurrentAccount, t]
  );

  return (
    <PageLayout hideToolbar>
      {/* No title: ChooseGuardianScreen renders its own h1 plus the description
          and the "What is a Guardian?" link (same framing as RotateGuardian). */}
      <NavigationHeader onBack={handleBack} variant="prominent" titleAlign="left" />
      <ChooseGuardianScreen onSubmit={handleSubmit} allowCustomEndpoint error={error} submitLoading={isCreating} />
    </PageLayout>
  );
};

export default AddAccountGuardian;
