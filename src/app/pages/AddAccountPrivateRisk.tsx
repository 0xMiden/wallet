import React, { FC, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { NavigationHeader } from 'components/NavigationHeader';
import { useMidenContext } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

interface RiskStep {
  icon: IconName;
  titleKey: string;
  bodyKey: string;
}

const RISK_STEPS: RiskStep[] = [
  { icon: IconName.Warning, titleKey: 'localRiskStep1Title', bodyKey: 'localRiskStep1Body' },
  { icon: IconName.Key, titleKey: 'localRiskStep2Title', bodyKey: 'localRiskStep2Body' },
  { icon: IconName.EyeOff, titleKey: 'localRiskStep3Title', bodyKey: 'localRiskStep3Body' }
];

/**
 * Risk acknowledgment for creating a fully local private account
 * (AddAccountDrawer → Private → Fully local). Three sequential screens, each
 * stating one consequence of having no guardian; every screen offers a
 * "Use a Guardian instead" escape hatch into /add-account/guardian. The final
 * "I understand" creates the WalletType.OffChain account (auto-named
 * "Account N"), switches to it, and returns home.
 */
const AddAccountPrivateRisk: FC = () => {
  const { t } = useTranslation();
  const { createAccount, updateCurrentAccount } = useMidenContext();
  const [stepIndex, setStepIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exitFlow = useBackWithFallback('/');

  const isLastStep = stepIndex === RISK_STEPS.length - 1;
  const step = RISK_STEPS[stepIndex]!;

  const goBack = () => {
    if (isCreating) return;
    if (stepIndex > 0) {
      setStepIndex(stepIndex - 1);
      return;
    }
    exitFlow();
  };

  useMobileBackHandler(() => {
    goBack();
    return true;
  }, [stepIndex, isCreating]);

  const createLocalAccount = async () => {
    setError(null);
    setIsCreating(true);
    const prevKeys = new Set(useWalletStore.getState().accounts.map(a => a.publicKey));
    try {
      // No name: the vault auto-names it "Account N".
      await createAccount(WalletType.OffChain);
      const created = useWalletStore.getState().accounts.find(a => !prevKeys.has(a.publicKey));
      if (created) {
        await updateCurrentAccount(created.publicKey);
      }
      navigate('/');
    } catch (err) {
      console.error('[AddAccountPrivateRisk] create account failed', err);
      setError(err instanceof Error ? err.message : t('smthWentWrong'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleUnderstand = () => {
    if (isCreating) return;
    hapticLight();
    if (isLastStep) {
      createLocalAccount();
      return;
    }
    setError(null);
    setStepIndex(stepIndex + 1);
  };

  const handleUseGuardian = () => {
    if (isCreating) return;
    hapticLight();
    navigate('/add-account/guardian');
  };

  return (
    <PageLayout hideToolbar>
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <NavigationHeader title={t('fullyPrivateRecovery')} onBack={goBack} />

        <div className="flex-1 flex flex-col px-6 pb-6">
          <p className="mt-4 text-sm font-medium text-text-tertiary-token">
            {t('localRiskStepCounter', { current: String(stepIndex + 1), total: String(RISK_STEPS.length) })}
          </p>

          <div className="mt-6 flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-50 dark:bg-red-500/15">
              <Icon name={step.icon} className="w-7! h-7! text-red-700 dark:text-red-300" fill="currentColor" />
            </div>
            <h1 className="mt-6 text-2xl font-semibold font-heading text-heading-gray leading-tight">
              {t(step.titleKey)}
            </h1>
            <p className="mt-3 text-base font-medium text-heading-gray leading-[130%]">{t(step.bodyKey)}</p>
          </div>

          <div className="mt-auto flex flex-col gap-4 pt-6">
            {error && (
              <p className="text-red-500 text-xs text-center select-text break-words" role="alert">
                {error}
              </p>
            )}
            <div className="flex w-full gap-4">
              <Button
                className="flex-1 justify-center"
                variant={ButtonVariant.Secondary}
                title={t('useGuardianInstead')}
                onClick={handleUseGuardian}
                disabled={isCreating}
                data-testid="local-risk-use-guardian"
              />
              <Button
                className="flex-1 justify-center"
                variant={ButtonVariant.Primary}
                title={isLastStep ? t('createAccount') : t('iUnderstand')}
                onClick={handleUnderstand}
                isLoading={isCreating}
                disabled={isCreating}
                data-testid="local-risk-continue"
              />
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default AddAccountPrivateRisk;
