import React, { FC, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { ProgressIndicator } from 'components/ProgressIndicator';
import { isMobile } from 'lib/platform';
import type { WalletAccount } from 'lib/shared/types';

import { ChooseGuardianScreen } from './common/ChooseGuardian';
import { ChooseProtectionScreen } from './common/ChooseProtection';
import { ConfirmationScreen } from './common/Confirmation';
import { CreatePasswordScreen } from './common/CreatePassword';
import { SetupBiometricScreen } from './common/SetupBiometric';
import { SetupPasscodeScreen } from './common/SetupPasscode';
import { WelcomeScreen } from './common/Welcome';
import { BackUpSeedPhraseScreen } from './create-wallet-flow/BackUpSeedPhrase';
import { SelectRecoveryMethodScreen } from './create-wallet-flow/SelectRecoveryMethod';
import { SelectTransactionTypeScreen } from './create-wallet-flow/SelectTransactionType';
import { VerifySeedPhraseScreen } from './create-wallet-flow/VerifySeedPhrase';
import { ImportRecoveryMethodScreen } from './import-wallet-flow/ImportRecoveryMethod';
import { ImportSeedPhraseScreen } from './import-wallet-flow/ImportSeedPhrase';
import { ImportWalletFileScreen } from './import-wallet-flow/ImportWalletFile';
import { SelectImportTypeScreen } from './import-wallet-flow/SelectImportType';
import { ImportType, OnboardingAction, OnboardingStep, OnboardingType, WalletType } from './types';

export interface OnboardingFlowProps {
  wordslist: string[];
  seedPhrase: string[] | null;
  onboardingType: OnboardingType | null;
  step: OnboardingStep;
  password?: string | null;
  isLoading?: boolean;
  useBiometric?: boolean;
  isHardwareSecurityAvailable?: boolean;
  biometricAttempts?: number;
  biometricError?: string | null;
  guardianLookupError?: boolean;
  onBiometricChange?: (value: boolean) => void;
  onAction?: (action: OnboardingAction) => void;
}

const STEP_TO_PROGRESS: Partial<Record<OnboardingStep, number>> = {
  [OnboardingStep.ChooseProtection]: 1,
  [OnboardingStep.SetupPasscode]: 2,
  [OnboardingStep.SetupBiometric]: 2,
  [OnboardingStep.ChooseGuardian]: 3,
  [OnboardingStep.SelectImportType]: 1,
  [OnboardingStep.ImportFromSeed]: 2,
  [OnboardingStep.ImportFromFile]: 2,
  [OnboardingStep.BackupSeedPhrase]: 1,
  [OnboardingStep.VerifySeedPhrase]: 2,
  [OnboardingStep.CreatePassword]: 3,
  [OnboardingStep.SelectRecoveryMethod]: 4,
  [OnboardingStep.ImportSelectRecoveryMethod]: 4,
  [OnboardingStep.Confirmation]: 4
};

const Header: React.FC<{
  onBack: () => void;
  currentStep: number | null;
  onboardingType?: 'import' | 'create' | null;
}> = ({ currentStep }) => {
  return (
    <div className="w-full flex items-center px-4 pt-4">
      <div className="flex-1 flex justify-center">
        <ProgressIndicator currentStep={currentStep ?? 1} steps={4} className={currentStep ? '' : 'opacity-0'} />
      </div>
    </div>
  );
};

export const OnboardingFlow: FC<OnboardingFlowProps> = ({
  wordslist,
  seedPhrase,
  onboardingType,
  step,
  isLoading,
  useBiometric = true,
  isHardwareSecurityAvailable = false,
  biometricAttempts = 0,
  biometricError = null,
  guardianLookupError = false,
  onBiometricChange,
  onAction
}) => {
  const { t } = useTranslation();
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'backward'>('forward');

  // Override for screens that have internal sub-steps (e.g. SetupPasscode's
  // enter → confirm phase). Reset whenever the top-level step changes so the
  // bump doesn't leak across navigation.
  const [progressOverride, setProgressOverride] = useState<number | null>(null);
  useEffect(() => {
    setProgressOverride(null);
  }, [step]);
  const baseStep = STEP_TO_PROGRESS[step] ?? null;
  const currentProgress = progressOverride ?? baseStep;

  const onForwardAction = useCallback(
    (onboardingAction: OnboardingAction) => {
      setNavigationDirection('forward');
      onAction?.(onboardingAction);
    },
    [onAction]
  );

  const renderStep = useCallback(() => {
    const onWelcomeAction = (action: 'select-wallet-type' | 'select-import-type') => {
      switch (action) {
        case 'select-wallet-type':
          onForwardAction?.({
            id: 'choose-protection'
          });
          break;
        case 'select-import-type':
          onForwardAction?.({
            id: 'select-import-type'
          });
          break;
        default:
          break;
      }
    };

    const onSelectImportTypeSubmit = (payload: ImportType) => {
      switch (payload) {
        case ImportType.SeedPhrase:
          onForwardAction?.({
            id: 'import-from-seed'
          });
          break;
        case ImportType.WalletFile:
          onForwardAction?.({
            id: 'import-from-file'
          });
          break;
        default:
          break;
      }
    };

    const onBackupSeedPhraseSubmit = () =>
      onForwardAction?.({
        id: 'verify-seed-phrase'
      });

    const onVerifySeedPhraseSubmit = () =>
      onForwardAction?.({
        id: 'create-password',
        payload: WalletType.OnChain
      });

    const onCreatePasswordSubmit = (password: string) =>
      onForwardAction?.({ id: 'create-password-submit', payload: { password, enableBiometric: false } });

    const onSelectRecoveryMethodSubmit = (walletType: WalletType) =>
      onForwardAction?.({ id: 'select-recovery-method', payload: walletType });

    const onSelectTransactionTypeSubmit = () =>
      onForwardAction?.({ id: 'select-transaction-type', payload: 'private' });

    const onConfirmSubmit = () => onForwardAction?.({ id: 'confirmation' });

    const onSwitchToPassword = () => onForwardAction?.({ id: 'switch-to-password' });

    const onImportSeedPhraseSubmit = (seedPhrase: string) =>
      onForwardAction?.({ id: 'import-seed-phrase-submit', payload: seedPhrase });

    const onImportFileSubmit = (seedPhrase: string, walletAccounts: WalletAccount[]) => {
      onForwardAction?.({ id: 'import-wallet-file-submit', payload: seedPhrase, walletAccounts });
    };

    const onSelectBiometric = () => onForwardAction?.({ id: 'setup-biometric' });
    const onSelectPasscode = () => onForwardAction?.({ id: 'setup-passcode' });
    const onSetupPasscodeSubmit = (code: string) => onForwardAction?.({ id: 'setup-passcode-submit', payload: code });
    const onSetupBiometricSubmit = () => onForwardAction?.({ id: 'setup-biometric-submit' });
    const onBiometricSwitchToPasscode = () => onForwardAction?.({ id: 'setup-passcode' });
    const onChooseGuardianSubmit = (payload: { guardianId: string; guardianEndpoint: string }) =>
      onForwardAction?.({ id: 'choose-guardian-submit', payload });

    switch (step) {
      case OnboardingStep.Welcome:
        return <WelcomeScreen onSubmit={onWelcomeAction} />;
      case OnboardingStep.ChooseProtection:
        return (
          <ChooseProtectionScreen onSelectBiometric={onSelectBiometric} onSelectPasscode={onSelectPasscode} />
        );
      case OnboardingStep.SetupPasscode:
        return (
          <SetupPasscodeScreen
            onSubmit={onSetupPasscodeSubmit}
            onPhaseChange={phase => setProgressOverride(phase === 'enter' ? 2 : 3)}
          />
        );
      case OnboardingStep.SetupBiometric:
        return (
          <SetupBiometricScreen
            onContinue={onSetupBiometricSubmit}
            onSwitchToPasscode={onBiometricSwitchToPasscode}
          />
        );
      case OnboardingStep.ChooseGuardian:
        return <ChooseGuardianScreen onSubmit={onChooseGuardianSubmit} />;
      case OnboardingStep.BackupSeedPhrase:
        return <BackUpSeedPhraseScreen seedPhrase={seedPhrase || []} onSubmit={onBackupSeedPhraseSubmit} />;
      case OnboardingStep.VerifySeedPhrase:
        return (
          <VerifySeedPhraseScreen
            seedPhrase={seedPhrase || []}
            useBiometric={useBiometric}
            isHardwareSecurityAvailable={isHardwareSecurityAvailable}
            onBiometricChange={onBiometricChange}
            onSubmit={onVerifySeedPhraseSubmit}
          />
        );
      case OnboardingStep.SelectImportType:
        return <SelectImportTypeScreen onSubmit={onSelectImportTypeSubmit} />;
      case OnboardingStep.ImportFromSeed:
        return <ImportSeedPhraseScreen wordslist={wordslist} onSubmit={onImportSeedPhraseSubmit} />;
      case OnboardingStep.ImportFromFile:
        return <ImportWalletFileScreen onSubmit={onImportFileSubmit} />;
      case OnboardingStep.CreatePassword:
        return <CreatePasswordScreen onSubmit={onCreatePasswordSubmit} />;
      case OnboardingStep.SelectRecoveryMethod:
        return <SelectRecoveryMethodScreen onSubmit={onSelectRecoveryMethodSubmit} />;
      case OnboardingStep.ImportSelectRecoveryMethod:
        return (
          <ImportRecoveryMethodScreen
            isError={guardianLookupError}
            onSubmit={payload => onForwardAction?.({ id: 'import-select-recovery-method', payload })}
          />
        );
      case OnboardingStep.SelectTransactionType:
        return <SelectTransactionTypeScreen onSubmit={onSelectTransactionTypeSubmit} />;
      case OnboardingStep.Confirmation:
        return (
          <ConfirmationScreen
            isLoading={isLoading}
            biometricAttempts={biometricAttempts}
            biometricError={biometricError}
            onSubmit={onConfirmSubmit}
            onSwitchToPassword={onSwitchToPassword}
          />
        );

      default:
        return <></>;
    }
  }, [
    step,
    isLoading,
    onForwardAction,
    seedPhrase,
    wordslist,
    useBiometric,
    isHardwareSecurityAvailable,
    onBiometricChange,
    biometricAttempts,
    biometricError,
    guardianLookupError
  ]);

  const onBack = () => {
    setNavigationDirection('backward');
    onAction?.({ id: 'back' });
  };

  return (
    <div
      className={classNames('flex flex-col', 'bg-app-bg', 'overflow-hidden', 'w-full h-full mx-auto')}
      style={{ maxWidth: 420 }}
    >
      <div className="flex flex-col flex-1 min-h-0">
        <AnimatePresence mode={'wait'} initial={false}>
          {step !== OnboardingStep.Welcome && (
            <Header onBack={onBack} currentStep={currentProgress} onboardingType={onboardingType} key={'header'} />
          )}
        </AnimatePresence>
        <AnimatePresence mode={'wait'} initial={false}>
          <motion.div
            className="flex flex-col flex-1 min-h-0"
            key={step}
            initial="initialState"
            animate="animateState"
            exit="exitState"
            transition={{
              type: 'tween',
              // Only animate on mobile (disable for Chrome extension)
              duration: isMobile() ? 0.2 : 0
            }}
            variants={{
              initialState: {
                x: navigationDirection === 'forward' ? '1vw' : '-1vw',
                opacity: 0
              },
              animateState: {
                x: 0,
                opacity: 1
              },
              exitState: {
                x: navigationDirection === 'forward' ? '-1vw' : '1vw',
                opacity: 0
              }
            }}
          >
            {renderStep()}
            {step !== OnboardingStep.Welcome &&
              step !== OnboardingStep.ChooseProtection &&
              step !== OnboardingStep.SetupPasscode &&
              step !== OnboardingStep.SetupBiometric &&
              step !== OnboardingStep.ChooseGuardian &&
              step !== OnboardingStep.Confirmation && (
                <div className="px-4 pt-2 pb-4">
                  <Button title={t('back')} variant={ButtonVariant.Secondary} onClick={onBack} className="w-full" />
                </div>
              )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};
