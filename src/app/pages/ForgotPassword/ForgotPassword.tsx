import React, { FC, useCallback, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordsList from 'bip39/src/wordlists/english.json';

import { formatMnemonic } from 'app/defaults';
import { persistGoogleRefreshToken } from 'lib/miden/backup/google-drive-auth';
import { useMidenContext } from 'lib/miden/front';
import { clearClientStorage } from 'lib/miden/reset';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import type { CloudBackupCredentials, WalletAccount } from 'lib/shared/types';
import { navigate } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { ImportType, OnboardingAction, OnboardingStep, OnboardingType } from 'screens/onboarding/types';

const ForgotPassword: FC = () => {
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [importType, setImportType] = useState<ImportType | null>(null);
  const [importedWithFile, setImportedWithFile] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [importedWalletAccounts, setImportedWalletAccounts] = useState<WalletAccount[]>([]);

  const { registerWallet, importWalletFromClient, registerFromCloudBackup, setAutoBackupEnabled } = useMidenContext();
  const [cloudBackupData, setCloudBackupData] = useState<CloudBackupCredentials | null>(null);

  const register = useCallback(async () => {
    if (password && seedPhrase) {
      clearClientStorage();

      const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
      if (cloudBackupData) {
        try {
          await registerFromCloudBackup(
            password,
            seedPhraseFormatted,
            cloudBackupData.walletAccounts,
            cloudBackupData.walletSettings
          );
          await persistGoogleRefreshToken(cloudBackupData.refreshToken);
          await setAutoBackupEnabled(
            true,
            cloudBackupData.accessToken,
            cloudBackupData.expiresAt,
            cloudBackupData.encryption,
            true
          );
        } catch (e) {
          console.error(e);
        }
      } else if (!importedWithFile) {
        try {
          await registerWallet(password, seedPhraseFormatted, onboardingType === OnboardingType.Import);
        } catch (e) {
          console.error(e);
        }
      } else {
        try {
          await importWalletFromClient(password, seedPhraseFormatted, importedWalletAccounts);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, [
    password,
    seedPhrase,
    importedWithFile,
    cloudBackupData,
    registerWallet,
    registerFromCloudBackup,
    setAutoBackupEnabled,
    onboardingType,
    importWalletFromClient,
    importedWalletAccounts
  ]);

  const onAction = useCallback(
    async (action: OnboardingAction) => {
      switch (action.id) {
        case 'create-wallet':
          setSeedPhrase(generateMnemonic(128).split(' '));
          setOnboardingType(OnboardingType.Create);
          setStep(OnboardingStep.BackupSeedPhrase);
          break;
        case 'select-import-type':
          setOnboardingType(OnboardingType.Import);
          setStep(OnboardingStep.SelectImportType);
          break;
        case 'import-from-file':
          setStep(OnboardingStep.ImportFromFile);
          break;
        case 'import-from-cloud':
          setImportType(ImportType.CloudBackup);
          setStep(OnboardingStep.ImportFromCloud);
          break;
        case 'import-from-cloud-submit':
          setCloudBackupData(action.payload);
          setStep(OnboardingStep.ImportFromSeed);
          break;
        case 'import-wallet-file-submit':
          const seedPhrase = action.payload.split(' ');
          setSeedPhrase(seedPhrase);
          setImportedWalletAccounts(action.walletAccounts);
          setImportedWithFile(true);
          setStep(OnboardingStep.CreatePassword);
          break;
        case 'import-from-seed':
          setStep(OnboardingStep.ImportFromSeed);
          break;
        case 'import-seed-phrase-submit':
          setSeedPhrase(action.payload.split(' '));
          setStep(OnboardingStep.CreatePassword);
          break;
        case 'backup-seed-phrase':
          setSeedPhrase(generateMnemonic(128).split(' '));
          setStep(OnboardingStep.BackupSeedPhrase);
          break;
        case 'verify-seed-phrase':
          setStep(OnboardingStep.VerifySeedPhrase);
          break;
        case 'create-password':
          setStep(OnboardingStep.CreatePassword);
          break;
        case 'create-password-submit':
          setPassword(action.payload.password);
          setStep(OnboardingStep.Confirmation);
          break;
        case 'confirmation':
          setIsLoading(true);
          await register();
          setIsLoading(false);
          navigate('/');
          break;
        case 'back':
          if (step === OnboardingStep.SelectImportType) {
            setStep(OnboardingStep.Welcome);
          } else if (step === OnboardingStep.VerifySeedPhrase) {
            setStep(OnboardingStep.BackupSeedPhrase);
          } else if (step === OnboardingStep.BackupSeedPhrase) {
            setStep(OnboardingStep.Welcome);
          } else if (step === OnboardingStep.CreatePassword) {
            if (onboardingType === OnboardingType.Create) {
              setStep(OnboardingStep.VerifySeedPhrase);
            } else {
              setStep(OnboardingStep.ImportFromSeed);
            }
          } else if (step === OnboardingStep.ImportFromCloud) {
            setStep(OnboardingStep.SelectImportType);
          } else if (step === OnboardingStep.ImportFromFile || step === OnboardingStep.ImportFromSeed) {
            if (importType === ImportType.CloudBackup) {
              setStep(OnboardingStep.ImportFromCloud);
            } else {
              setStep(OnboardingStep.SelectImportType);
            }
          }
          break;
        default:
          break;
      }
    },
    [register, step, onboardingType, importType]
  );

  // Handle mobile back button/gesture in forgot password flow
  useMobileBackHandler(() => {
    // On welcome screen, go back to unlock page
    if (step === OnboardingStep.Welcome) {
      navigate('/');
      return true;
    }
    // On confirmation/loading screen, don't allow back
    if (step === OnboardingStep.Confirmation && isLoading) {
      return true; // Consume but don't navigate
    }
    // Trigger the back action
    onAction({ id: 'back' });
    return true;
  }, [step, isLoading, onAction]);

  return (
    <OnboardingFlow
      wordslist={wordsList}
      seedPhrase={seedPhrase}
      onboardingType={onboardingType}
      step={step}
      isLoading={isLoading}
      onAction={onAction}
    />
  );
};

export default ForgotPassword;
