import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';

import { Icon, IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';
import { ProgressIndicator } from 'components/ProgressIndicator';
import { isMobile } from 'lib/platform';

import { ConfirmationScreen } from './common/Confirmation';
import { CreatePasswordScreen } from './common/CreatePassword';
import { WelcomeScreen } from './common/Welcome';
import { BackUpSeedPhraseScreen } from './create-wallet-flow/BackUpSeedPhrase';
import { SelectTransactionTypeScreen } from './create-wallet-flow/SelectTransactionType';
import { VerifySeedPhraseScreen } from './create-wallet-flow/VerifySeedPhrase';
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
  onBiometricChange?: (value: boolean) => void;
  onAction?: (action: OnboardingAction) => void;
}

const Header: React.FC<{
  onBack: () => void;
  step: OnboardingStep;
  onboardingType?: 'import' | 'create' | null;
}> = ({ step, onBack }) => {
  // Hide header on full-screen steps
  if (step === OnboardingStep.Confirmation || step === OnboardingStep.SelectTransactionType) {
    return null;
  }

  const shouldRenderBackButton = step !== OnboardingStep.Welcome;
  let currentStep: number | null = step === OnboardingStep.Welcome ? null : 3;

  if (step === OnboardingStep.BackupSeedPhrase) {
    currentStep = 1;
  } else if (step === OnboardingStep.VerifySeedPhrase) {
    currentStep = 2;
  } else if (step === OnboardingStep.SelectImportType) {
    currentStep = 1;
  } else if (step === OnboardingStep.CreatePassword) {
    currentStep = 3;
  } else if (step === OnboardingStep.ImportFromSeed || step === OnboardingStep.ImportFromFile) {
    currentStep = 2;
  }

  return (
    <div className="flex justify-between items-center px-6 py-4 border-[0.5px] border-[#00000033] ">
      <CircleButton
        icon={IconName.ArrowLeft}
        onClick={onBack}
        className={shouldRenderBackButton ? '' : 'opacity-0 pointer-events-none'}
      />

      <div className="flex gap-1 items-center justify-center">
        <Icon name={IconName.OnboardingLogo} className=" w-7 h-6" />
        <p className="text-heading-gray text-[19px] font-semibold">Miden Wallet</p>
      </div>
      <ProgressIndicator currentStep={currentStep || 1} steps={3} className={currentStep ? '' : 'opacity-0'} />
    </div>
  );
};

export const OnboardingFlow: FC<OnboardingFlowProps> = ({
  wordslist,
  seedPhrase,
  onboardingType,
  step,
  password,
  isLoading,
  useBiometric = true,
  isHardwareSecurityAvailable = false,
  biometricAttempts = 0,
  biometricError = null,
  onBiometricChange,
  onAction
}) => {
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'backward'>('forward');

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
            id: 'create-wallet'
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

    const onSelectTransactionTypeSubmit = () =>
      onForwardAction?.({ id: 'select-transaction-type', payload: 'private' });

    const onConfirmSubmit = () => onForwardAction?.({ id: 'confirmation' });

    const onSwitchToPassword = () => onForwardAction?.({ id: 'switch-to-password' });

    const onImportSeedPhraseSubmit = (seedPhrase: string) =>
      onForwardAction?.({ id: 'import-seed-phrase-submit', payload: seedPhrase });

    const onImportFileSubmit = (seedPhrase: string) => {
      onForwardAction?.({ id: 'import-wallet-file-submit', payload: seedPhrase });
    };

    switch (step) {
      case OnboardingStep.Welcome:
        return <WelcomeScreen onSubmit={onWelcomeAction} />;
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
    biometricError
  ]);

  const onBack = () => {
    setNavigationDirection('backward');
    onAction?.({ id: 'back' });
  };

  const mobile = isMobile();

  return (
    <div
      className={classNames(
        'flex flex-col',
        'bg-white',
        'overflow-hidden',
        mobile ? 'w-full h-full' : 'w-full h-full mx-auto border border-gray-100 rounded-3xl'
      )}
    >
      <div className="flex flex-col">
        <AnimatePresence mode={'wait'} initial={false}>
          {step !== OnboardingStep.Confirmation &&
            step !== OnboardingStep.SelectTransactionType &&
            step !== OnboardingStep.Welcome && (
              <Header onBack={onBack} step={step} onboardingType={onboardingType} key={'header'} />
            )}
        </AnimatePresence>
        <AnimatePresence mode={'wait'} initial={false}>
          <motion.div
            className="flex flex-col"
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
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};
