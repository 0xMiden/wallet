import React, { FC, useCallback, useEffect, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordslist from 'bip39/src/wordlists/english.json';

import { formatMnemonic } from 'app/defaults';
import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { persistGoogleRefreshToken } from 'lib/miden/backup/google-drive-auth';
import { useMidenContext } from 'lib/miden/front';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isDesktop, isMobile } from 'lib/platform';
import { CloudBackupCredentials, WalletAccount, WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { fetchStateFromBackend } from 'lib/store/hooks/useIntercomSync';
import { navigate, useLocation } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { ImportType, OnboardingAction, OnboardingStep, OnboardingType } from 'screens/onboarding/types';

/**
 * Check if hardware security is available for vault key protection.
 * On desktop/mobile, this checks for Secure Enclave/TPM/TEE availability.
 */
async function checkHardwareSecurityAvailable(): Promise<boolean> {
  if (!isDesktop() && !isMobile()) {
    return false;
  }

  try {
    if (isDesktop()) {
      const ss = await import('lib/desktop/secure-storage');
      return await ss.isHardwareSecurityAvailable();
    }
    if (isMobile()) {
      const hs = await import('lib/biometric');
      return await hs.isHardwareSecurityAvailable();
    }
  } catch (error) {
    console.log('[Welcome] Hardware security check failed:', error);
    return false;
  }
  return false;
}

/**
 * Wait for the wallet state to become Ready after registration.
 * This ensures the state is fully synced before navigation.
 */
async function waitForReadyState(syncFromBackend: (state: any) => void, maxAttempts = 10): Promise<void> {
  console.log('[waitForReadyState] Starting, maxAttempts:', maxAttempts);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      console.log('[waitForReadyState] Attempt', i + 1);
      const state = await fetchStateFromBackend();
      console.log('[waitForReadyState] Got state:', { status: state.status, hasAccounts: !!state.accounts?.length });
      syncFromBackend(state);
      if (state.status === WalletStatus.Ready) {
        console.log('[waitForReadyState] State is Ready, done');
        return;
      }
    } catch (error) {
      console.warn('[waitForReadyState] Failed to fetch state, retrying...', error);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.warn('[waitForReadyState] Max attempts reached, state still not Ready');
}

const Welcome: FC = () => {
  const { hash } = useLocation();
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[] | null>(null);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  const [importType, setImportType] = useState<ImportType | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [importedWithFile, setImportedWithFile] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [useBiometric, setUseBiometric] = useState(true);
  const [isHardwareSecurityAvailable, setIsHardwareSecurityAvailable] = useState(false);
  const [biometricAttempts, setBiometricAttempts] = useState(0);
  const [biometricError, setBiometricError] = useState<string | null>(null);
  const [importedWalletAccounts, setImportedWalletAccounts] = useState<WalletAccount[]>([]);
  const { registerWallet, importWalletFromClient, registerFromCloudBackup, setAutoBackupEnabled } = useMidenContext();
  const [cloudBackupData, setCloudBackupData] = useState<CloudBackupCredentials | null>(null);
  const { trackEvent } = useAnalytics();
  const syncFromBackend = useWalletStore(s => s.syncFromBackend);

  // Check hardware security availability on mount
  useEffect(() => {
    checkHardwareSecurityAvailable().then(available => {
      setIsHardwareSecurityAvailable(available);
    });
  }, []);

  // Test bypass: skip onboarding via URL param or CDP global (mobile testing only)
  // Usage from CDP: node /tmp/cdp-eval 'window.__TEST_SKIP_ONBOARDING = true; window.location.hash = ""'
  // Or navigate to /?__test_skip_onboarding=1
  const [testBypassTriggered, setTestBypassTriggered] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const skipViaParam = params.get('__test_skip_onboarding') === '1';
    const skipViaGlobal = (globalThis as any).__TEST_SKIP_ONBOARDING === true;
    if (!skipViaParam && !skipViaGlobal) return;

    console.log('[Welcome] Test bypass: setting up seed + password');
    const testSeed = generateMnemonic(128).split(' ');
    const testPassword = params.get('password') || 'password1';
    setSeedPhrase(testSeed);
    setPassword(testPassword);
    setOnboardingType(OnboardingType.Create);
    setTestBypassTriggered(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigate to confirmation AFTER password state is committed
  useEffect(() => {
    if (testBypassTriggered && password) {
      console.log('[Welcome] Test bypass: password set, navigating to confirmation');
      navigate('/#confirmation');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testBypassTriggered, password]);

  const register = useCallback(async () => {
    if (password && seedPhrase) {
      const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
      // For hardware-only wallets, pass undefined as password
      const actualPassword = password === '__HARDWARE_ONLY__' ? undefined : password;
      if (cloudBackupData) {
        await registerFromCloudBackup(
          actualPassword,
          seedPhraseFormatted,
          cloudBackupData.walletAccounts,
          cloudBackupData.walletSettings
        );
        // clearStorage wiped the refresh token — re-persist it, then enable auto-backup
        await persistGoogleRefreshToken(cloudBackupData.refreshToken);
        await setAutoBackupEnabled(
          true,
          cloudBackupData.accessToken,
          cloudBackupData.expiresAt,
          cloudBackupData.encryption,
          true
        );
      } else if (!importedWithFile) {
        await registerWallet(actualPassword, seedPhraseFormatted, onboardingType === OnboardingType.Import);
      } else {
        try {
          console.log('importing wallet from client');
          await importWalletFromClient(actualPassword, seedPhraseFormatted, importedWalletAccounts);
        } catch (e) {
          console.error(e);
        }
      }
    } else {
      throw new Error('Missing password or seed phrase');
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

  const onAction = async (action: OnboardingAction) => {
    let eventCategory = AnalyticsEventCategory.ButtonPress;
    let eventProperties = {};

    switch (action.id) {
      case 'create-wallet':
        setSeedPhrase(generateMnemonic(128).split(' '));
        setOnboardingType(OnboardingType.Create);
        navigate('/#backup-seed-phrase');
        break;
      case 'select-import-type':
        setOnboardingType(OnboardingType.Import);
        navigate('/#select-import-type');
        break;
      case 'import-from-file':
        setImportType(ImportType.WalletFile);
        navigate('/#import-from-file');
        break;
      case 'import-wallet-file-submit':
        const seedPhrase = action.payload.split(' ');
        setSeedPhrase(seedPhrase);
        setImportedWalletAccounts(action.walletAccounts);
        setImportedWithFile(true);
        // Check if hardware security is available - if so, skip password step
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (hardwareAvailable) {
            // Hardware-only mode: skip password, go directly to confirmation
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            navigate('/#create-password');
          }
        }
        break;
      case 'import-from-cloud':
        setImportType(ImportType.CloudBackup);
        navigate('/#import-from-cloud');
        break;
      case 'import-from-cloud-submit':
        setCloudBackupData(action.payload);
        navigate('/#import-from-seed');
        break;
      case 'import-from-seed':
        setImportType(ImportType.SeedPhrase);
        navigate('/#import-from-seed');
        break;
      case 'import-seed-phrase-submit':
        setSeedPhrase(action.payload.split(' '));
        // Check if hardware security is available - if so, skip password step
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (hardwareAvailable) {
            // Hardware-only mode: skip password, go directly to confirmation
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            navigate('/#create-password');
          }
        }
        break;
      case 'backup-seed-phrase':
        setSeedPhrase(generateMnemonic(128).split(' '));
        navigate('/#backup-seed-phrase');
        break;
      case 'verify-seed-phrase':
        navigate('/#verify-seed-phrase');
        break;
      case 'create-password':
        // Check if user wants biometric AND hardware security is available
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (useBiometric && hardwareAvailable) {
            // Hardware-only mode: skip password, go directly to confirmation
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            // User opted out of biometrics or hardware not available - show password screen
            navigate('/#create-password');
          }
        }
        break;
      case 'create-password-submit':
        setPassword(action.payload.password);
        eventCategory = AnalyticsEventCategory.FormSubmit;
        // Hardware protection is automatically set up in Vault.spawn() when available
        navigate('/#confirmation');
        break;
      case 'confirmation':
        try {
          setIsLoading(true);
          setBiometricError(null);
          await register();
          // Wait for state to be synced before navigating
          // This fixes a race condition where navigation happens before state is Ready
          await waitForReadyState(syncFromBackend);
          setIsLoading(false);
          eventCategory = AnalyticsEventCategory.FormSubmit;
          navigate('/');
        } catch (error) {
          console.error('[Welcome] Confirmation flow failed:', error);
          setIsLoading(false);
          // Track biometric attempts for hardware-only mode
          if (password === '__HARDWARE_ONLY__') {
            const newAttempts = biometricAttempts + 1;
            setBiometricAttempts(newAttempts);
            setBiometricError(error instanceof Error ? error.message : 'Biometric authentication failed');
          }
        }
        break;
      case 'switch-to-password':
        // User chose to use password after biometric failures
        setUseBiometric(false);
        setPassword(null);
        setBiometricAttempts(0);
        setBiometricError(null);
        navigate('/#create-password');
        break;
      case 'back':
        if (
          step === OnboardingStep.SelectImportType ||
          step === OnboardingStep.SelectWalletType ||
          step === OnboardingStep.BackupSeedPhrase
        ) {
          navigate('/');
        } else if (step === OnboardingStep.VerifySeedPhrase) {
          navigate('/#backup-seed-phrase');
        } else if (step === OnboardingStep.CreatePassword) {
          if (onboardingType === OnboardingType.Create) {
            navigate('/#verify-seed-phrase');
          } else {
            if (importType === ImportType.WalletFile) {
              navigate('/#import-from-file');
            } else {
              navigate('/#import-from-seed');
            }
          }
        } else if (step === OnboardingStep.ImportFromCloud) {
          navigate('/#select-import-type');
        } else if (step === OnboardingStep.ImportFromFile || step === OnboardingStep.ImportFromSeed) {
          if (importType === ImportType.CloudBackup) {
            navigate('/#import-from-cloud');
          } else {
            navigate('/#select-import-type');
          }
        }
        break;
      default:
        break;
    }

    trackEvent(action.id, eventCategory, eventProperties);
  };

  useEffect(() => {
    switch (hash) {
      case '':
        setStep(OnboardingStep.Welcome);
        break;
      case '#select-wallet-type':
        setOnboardingType(OnboardingType.Create);
        setStep(OnboardingStep.SelectWalletType);
        break;
      case '#select-import-type':
        setStep(OnboardingStep.SelectImportType);
        setOnboardingType(OnboardingType.Import);
        break;
      case '#import-from-seed':
        setStep(OnboardingStep.ImportFromSeed);
        break;
      case '#import-from-file':
        setStep(OnboardingStep.ImportFromFile);
        break;
      case '#import-from-cloud':
        setStep(OnboardingStep.ImportFromCloud);
        break;
      case '#backup-seed-phrase':
        setOnboardingType(OnboardingType.Create);
        setStep(OnboardingStep.BackupSeedPhrase);
        break;
      case '#verify-seed-phrase':
        setStep(OnboardingStep.VerifySeedPhrase);
        break;
      case '#create-password':
        setStep(OnboardingStep.CreatePassword);
        break;
      case '#confirmation':
        if (!password) {
          navigate('/');
        } else {
          setStep(OnboardingStep.Confirmation);
        }
        break;
      default:
        break;
    }
  }, [hash, password]);

  // Handle mobile back button/gesture in onboarding flow
  useMobileBackHandler(() => {
    // On welcome screen, let system handle (minimize on Android)
    if (step === OnboardingStep.Welcome) {
      return false;
    }
    // On confirmation/loading screen, don't allow back
    if (step === OnboardingStep.Confirmation && isLoading) {
      return true; // Consume but don't navigate
    }
    // Trigger the onboarding back action
    onAction({ id: 'back' });
    return true;
  }, [step, isLoading, onAction]);

  return (
    <OnboardingFlow
      wordslist={wordslist}
      seedPhrase={seedPhrase}
      onboardingType={onboardingType}
      step={step}
      password={password}
      isLoading={isLoading}
      useBiometric={useBiometric}
      isHardwareSecurityAvailable={isHardwareSecurityAvailable}
      biometricAttempts={biometricAttempts}
      biometricError={biometricError}
      onBiometricChange={setUseBiometric}
      onAction={onAction}
    />
  );
};

export default Welcome;
