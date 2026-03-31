import React, { FC, useCallback, useMemo, useState } from 'react';

import { WalletAccount, WalletSettings } from 'lib/shared/types';

import { ConfirmationScreen } from './common/Confirmation';
import { CreatePasswordScreen } from './common/CreatePassword';
import OnboardingHeader from './common/OnboardingHeader';
import OnboardingView from './common/OnboardingView';
import { WelcomeScreen } from './common/Welcome';
import { BackUpSeedPhraseScreen } from './create-wallet-flow/BackUpSeedPhrase';
import { SelectTransactionTypeScreen } from './create-wallet-flow/SelectTransactionType';
import { VerifySeedPhraseScreen } from './create-wallet-flow/VerifySeedPhrase';
import { ImportFromCloudScreen } from './import-wallet-flow/ImportFromCloud';
import { ImportSeedPhraseScreen } from './import-wallet-flow/ImportSeedPhrase';
import { ImportWalletFileScreen } from './import-wallet-flow/ImportWalletFile';
import { SelectImportTypeScreen } from './import-wallet-flow/SelectImportType';
import { ForgotPasswordAction, ForgotPasswordStep, ImportType, OnboardingType, WalletType } from './types';

const TOTAL_STEPS = 3;

export interface ForgotPasswordFlowProps {
  step: ForgotPasswordStep;
  wordsList: string[];
  seedPhrase: string[] | null;
  isLoading?: boolean;
  onAction: (action: ForgotPasswordAction) => void;
  onboardingType: OnboardingType | null;
}

export const ForgotPasswordFlow: FC<ForgotPasswordFlowProps> = ({
  step,
  seedPhrase,
  wordsList,
  isLoading,
  onAction,
  onboardingType
}) => {
  const [navigationDirection, setNavigationDirection] = useState<'forward' | 'backward'>('forward');

  const showHeader = useMemo(() => step !== ForgotPasswordStep.Confirmation, [step]);
  const showBackButton = step !== ForgotPasswordStep.Welcome;
  const showProgressIndicator = step !== ForgotPasswordStep.Welcome;
  const currentStep = useMemo(() => {
    if (onboardingType === OnboardingType.Create) {
      if (step === ForgotPasswordStep.BackupSeedPhrase) {
        return 1;
      } else if (step === ForgotPasswordStep.VerifySeedPhrase) {
        return 2;
      } else if (step === ForgotPasswordStep.CreatePassword) {
        return 3;
      }
    } else {
      if (step === ForgotPasswordStep.SelectImportType) {
        return 1;
      } else if (
        step === ForgotPasswordStep.ImportFromSeed ||
        step === ForgotPasswordStep.ImportFromFile ||
        step === ForgotPasswordStep.ImportFromCloud
      ) {
        return 2;
      } else if (step === ForgotPasswordStep.CreatePassword) {
        return 3;
      }
    }

    return 0;
  }, [onboardingType, step]);

  const onForwardAction = useCallback(
    (forgotPasswordAction: ForgotPasswordAction) => {
      setNavigationDirection('forward');
      onAction(forgotPasswordAction);
    },
    [onAction]
  );

  const onBack = useCallback(() => {
    setNavigationDirection('backward');
    onAction({ id: 'back' });
  }, [onAction]);

  const renderHeader = useCallback(() => {
    return showHeader ? (
      <OnboardingHeader
        onBack={onBack}
        currentStep={currentStep}
        showBackButton={showBackButton}
        showProgressIndicator={showProgressIndicator}
        steps={TOTAL_STEPS}
      />
    ) : (
      <></>
    );
  }, [currentStep, onBack, showBackButton, showHeader, showProgressIndicator]);

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
        case ImportType.CloudBackup:
          onForwardAction?.({
            id: 'import-from-cloud'
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

    const onImportSeedPhraseSubmit = (seedPhrase: string) =>
      onForwardAction({ id: 'import-seed-phrase-submit', payload: seedPhrase });

    const onCreatePasswordSubmit = (password: string) =>
      onForwardAction({ id: 'create-password-submit', payload: { password, enableBiometric: false } });

    // const onCreateWalletSubmit = () => onForwardAction({ id: 'create-wallet' });

    const onConfirmSubmit = () => {
      onForwardAction?.({ id: 'confirmation' });
    };

    const onImportFileSubmit = (seedPhrase: string) => {
      onForwardAction?.({ id: 'import-wallet-file-submit', payload: seedPhrase });
    };

    const onImportFromCloudSubmit = (payload: { walletAccounts: WalletAccount[]; walletSettings: WalletSettings }) => {
      onForwardAction?.({ id: 'import-from-cloud-submit', payload });
    };

    const onSelectTransactionTypeSubmit = () =>
      onForwardAction?.({ id: 'select-transaction-type', payload: 'private' });

    switch (step) {
      case ForgotPasswordStep.Welcome:
        return <WelcomeScreen onSubmit={onWelcomeAction} />;
      case ForgotPasswordStep.BackupSeedPhrase:
        return <BackUpSeedPhraseScreen seedPhrase={seedPhrase || []} onSubmit={onBackupSeedPhraseSubmit} />;
      case ForgotPasswordStep.VerifySeedPhrase:
        return <VerifySeedPhraseScreen seedPhrase={seedPhrase || []} onSubmit={onVerifySeedPhraseSubmit} />;
      case ForgotPasswordStep.SelectImportType:
        return <SelectImportTypeScreen onSubmit={onSelectImportTypeSubmit} />;
      case ForgotPasswordStep.ImportFromSeed:
        return <ImportSeedPhraseScreen wordslist={wordsList} onSubmit={onImportSeedPhraseSubmit} />;
      case ForgotPasswordStep.ImportFromFile:
        return <ImportWalletFileScreen onSubmit={onImportFileSubmit} />;
      case ForgotPasswordStep.ImportFromCloud:
        return <ImportFromCloudScreen onSubmit={onImportFromCloudSubmit} />;
      case ForgotPasswordStep.CreatePassword:
        return <CreatePasswordScreen onSubmit={onCreatePasswordSubmit} />;
      case ForgotPasswordStep.SelectTransactionType:
        return <SelectTransactionTypeScreen onSubmit={onSelectTransactionTypeSubmit} />;
      case ForgotPasswordStep.Confirmation:
        return <ConfirmationScreen isLoading={isLoading} onSubmit={onConfirmSubmit} />;
      default:
        return <></>;
    }
  }, [isLoading, onForwardAction, seedPhrase, step, wordsList]);

  return (
    <OnboardingView
      renderHeader={renderHeader}
      renderStep={renderStep}
      step={step}
      navigationDirection={navigationDirection}
    />
  );
};
