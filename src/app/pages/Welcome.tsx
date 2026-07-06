import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordslist from 'bip39/src/wordlists/english.json';

import AwaitFonts from 'app/a11y/AwaitFonts';
import { formatMnemonic } from 'app/defaults';
import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { canHandoffToSidePanel } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { putToStorage } from 'lib/miden/front/storage';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isDesktop, isMobile } from 'lib/platform';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { WalletStatus, WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { fetchStateFromBackend } from 'lib/store/hooks/useIntercomSync';
import { seedWalletPrompt, WalletPromptType } from 'lib/wallet-prompts';
import { navigate, useLocation } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { ImportType, OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

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
  const [walletType, setWalletType] = useState<WalletType>(WalletType.Guardian);
  const [importedWithFile, setImportedWithFile] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [useBiometric, setUseBiometric] = useState(true);
  const [isHardwareSecurityAvailable, setIsHardwareSecurityAvailable] = useState(false);
  const [biometricAttempts, setBiometricAttempts] = useState(0);
  const [biometricError, setBiometricError] = useState<string | null>(null);
  const [guardianLookupError, setGuardianLookupError] = useState(false);
  const [importedWalletAccounts, setImportedWalletAccounts] = useState<WalletAccount[]>([]);
  // Tracks which protection screen the user came through; needed so ChooseGuardian
  // back navigation and the create-password→confirmation routing pick the right
  // origin without colliding with the legacy create flow.
  const [protectionMethod, setProtectionMethod] = useState<'passcode' | 'biometric' | null>(null);
  const { registerWallet, importWalletFromClient } = useMidenContext();
  const { trackEvent } = useAnalytics();
  const syncFromBackend = useWalletStore(s => s.syncFromBackend);

  // Chrome side panel handoff: create the wallet while the confirmation screen
  // spins, then the final "Open wallet" click opens the side panel onto the
  // ready wallet (sidePanel.open() needs that click's live gesture). Disabled
  // under E2E and on non-Chrome — those keep the classic click-to-create flow.
  const sidePanelHandoff = useMemo(() => canHandoffToSidePanel(), []);
  const [confirmPhase, setConfirmPhase] = useState<'idle' | 'creating' | 'failed'>('idle');

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
    // E2E-only. Gate on the build flag (like __TEST_STORE__ / __TEST_INTERCOM__):
    // Vite replaces process.env.MIDEN_E2E_TEST with 'false' in every non-E2E
    // build, so this whole bypass — including the `seed` import path below —
    // becomes dead code and tree-shakes out of production. Without this guard a
    // crafted `fullpage.html?__test_skip_onboarding=1&seed=<words>` link could
    // silently provision an attacker-chosen wallet.
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    const params = new URLSearchParams(window.location.search);
    const skipViaParam = params.get('__test_skip_onboarding') === '1';
    const skipViaGlobal = (globalThis as any).__TEST_SKIP_ONBOARDING === true;
    if (!skipViaParam && !skipViaGlobal) return;

    // Wallet type for the bypass: explicit `walletType=guardian` creates a
    // Guardian (co-signed) account; anything else creates a fully-private
    // (OffChain) account. The default is intentionally NOT the component's
    // Guardian default — the bypass otherwise inherits it, which silently makes
    // every bypass-created wallet guardian-backed. Defaulting to OffChain
    // matches the Chrome E2E's private default and keeps non-guardian specs
    // independent of a guardian backend.
    const bypassWalletType = params.get('walletType') === 'guardian' ? WalletType.Guardian : WalletType.OffChain;
    // Optional `seed` param: a space- or comma-separated mnemonic. When present,
    // import that exact seed (onboardingType=Import drives registerWallet's
    // isImport=true) instead of generating a fresh mnemonic + Create. This lets
    // the harness restore a specific wallet through the bypass.
    const seedParam = params.get('seed');
    const importedSeed = seedParam
      ? seedParam
          .split(/[\s,]+/)
          .map(word => word.trim())
          .filter(Boolean)
      : null;
    const bypassOnboardingType = importedSeed ? OnboardingType.Import : OnboardingType.Create;
    console.log(
      `[Welcome] Test bypass: setting up seed + password, walletType=${bypassWalletType}, onboardingType=${bypassOnboardingType}`
    );
    const testSeed = importedSeed ?? generateMnemonic(128).split(' ');
    const testPassword = params.get('password') || 'password1';
    setWalletType(bypassWalletType);
    setSeedPhrase(testSeed);
    setPassword(testPassword);
    setOnboardingType(bypassOnboardingType);
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
      if (!importedWithFile) {
        await registerWallet(walletType, actualPassword, seedPhraseFormatted, onboardingType === OnboardingType.Import);
        if (onboardingType === OnboardingType.Create) {
          await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
        }
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
    registerWallet,
    onboardingType,
    importWalletFromClient,
    walletType,
    importedWalletAccounts
  ]);

  // Side panel handoff: kick off wallet creation as soon as the confirmation
  // screen is reached (the screen shows a spinner), so the wallet is Ready by
  // the time the user clicks "Open wallet". Scoped to the Create flow only:
  //   - the hardware/biometric path must prompt biometrics on an explicit tap,
  //     not on arrival;
  //   - import flows are excluded because importWalletFromClient can fail
  //     silently (register() resolves without a wallet), which would leave the
  //     handoff screen spinning — imports keep the classic in-tab flow.
  // The `confirmPhase !== 'idle'` guard makes this fire at most once even though
  // `register`/`trackEvent` are (correctly) in the dependency array.
  useEffect(() => {
    if (!sidePanelHandoff) return;
    if (step !== OnboardingStep.Confirmation) return;
    if (confirmPhase !== 'idle') return;
    if (onboardingType !== OnboardingType.Create) return;
    if (!password || !seedPhrase || password === '__HARDWARE_ONLY__') return;

    setConfirmPhase('creating');
    (async () => {
      try {
        await register();
        trackEvent('confirmation', AnalyticsEventCategory.FormSubmit, {});
        // Move to the dedicated handoff route, which survives the Ready
        // transition and shows the "Open wallet" button. Crucially we do NOT
        // waitForReadyState here — pushing Ready into the store first would
        // route this tab to the wallet home before we navigate.
        navigate('/finish-side-panel');
      } catch (error) {
        // Fall back to the classic click-to-create flow: the confirmation
        // button reverts to running register() in-tab on the next tap.
        console.error('[Welcome] Side panel handoff auto-create failed:', error);
        setConfirmPhase('failed');
      }
    })();
  }, [sidePanelHandoff, step, confirmPhase, onboardingType, password, seedPhrase, register, trackEvent]);

  const onAction = async (action: OnboardingAction) => {
    let eventCategory = AnalyticsEventCategory.ButtonPress;
    let eventProperties = {};

    switch (action.id) {
      case 'choose-protection':
        setOnboardingType(OnboardingType.Create);
        navigate('/#choose-protection');
        break;
      case 'setup-passcode':
        setOnboardingType(OnboardingType.Create);
        navigate('/#setup-passcode');
        break;
      case 'setup-biometric':
        setOnboardingType(OnboardingType.Create);
        navigate('/#setup-biometric');
        break;
      case 'setup-biometric-submit':
        // User finished the (fake) biometric prompt — generate the mnemonic
        // silently and route to guardian selection. The hardware/password
        // decision is deferred to after the guardian is chosen.
        setSeedPhrase(generateMnemonic(128).split(' '));
        setOnboardingType(OnboardingType.Create);
        setProtectionMethod('biometric');
        navigate('/#choose-guardian');
        break;
      case 'setup-passcode-submit':
        // Passcode IS the vault password. The 6 digits get stretched through
        // 20.31M PBKDF2 iterations (src/lib/miden/passworder.ts) before unwrapping
        // the random 256-bit vault key. Online brute-force is blocked by the
        // Unlock screen's escalating lockout (src/app/pages/Unlock.tsx).
        setSeedPhrase(generateMnemonic(128).split(' '));
        setOnboardingType(OnboardingType.Create);
        setPassword(action.payload);
        setProtectionMethod('passcode');
        navigate('/#choose-guardian');
        break;
      case 'choose-guardian-submit':
        await putToStorage(GUARDIAN_URL_STORAGE_KEY, action.payload.guardianEndpoint);
        setWalletType(WalletType.Guardian);
        if (password) {
          // Passcode flow already established a password — go straight to confirmation.
          navigate('/#confirmation');
        } else {
          // Biometric flow — defer the hardware vs password decision until now.
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (hardwareAvailable) {
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            navigate('/#create-password');
          }
        }
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
            // Hardware-only mode: skip password, go to recovery method selection
            setPassword('__HARDWARE_ONLY__');
            navigate('/#import-select-recovery-method');
          } else {
            navigate('/#create-password');
          }
        }
        break;
      case 'create-password-submit':
        setPassword(action.payload.password);
        eventCategory = AnalyticsEventCategory.FormSubmit;
        if (onboardingType === OnboardingType.Import && importType === ImportType.SeedPhrase) {
          navigate('/#import-select-recovery-method');
        } else {
          navigate('/#confirmation');
        }
        break;
      case 'import-select-recovery-method':
        setWalletType(action.payload.walletType);
        if (action.payload.walletType === WalletType.Guardian && action.payload.guardianEndpoint) {
          console.log('Putting guardian endpoint to storage:', action.payload.guardianEndpoint);
          await putToStorage(GUARDIAN_URL_STORAGE_KEY, action.payload.guardianEndpoint);
        }
        setGuardianLookupError(false);
        navigate('/#confirmation');
        break;
      case 'confirmation':
        // Side panel handoff (Chrome) creates the wallet in the auto-create
        // effect above and navigates to /finish-side-panel, so this click only
        // runs in the classic flow: non-Chrome, hardware/biometric, or a retry
        // after a failed auto-create. It creates the wallet then enters in-tab.
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
          if (onboardingType === OnboardingType.Import && walletType === WalletType.Guardian) {
            setGuardianLookupError(true);
            navigate('/#import-select-recovery-method');
          } else if (password === '__HARDWARE_ONLY__') {
            // Track biometric attempts for hardware-only mode
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
          step === OnboardingStep.ChooseProtection
        ) {
          navigate('/');
        } else if (step === OnboardingStep.SetupPasscode || step === OnboardingStep.SetupBiometric) {
          navigate('/#choose-protection');
        } else if (step === OnboardingStep.ChooseGuardian) {
          navigate(protectionMethod === 'biometric' ? '/#setup-biometric' : '/#setup-passcode');
        } else if (step === OnboardingStep.CreatePassword) {
          if (onboardingType === OnboardingType.Create) {
            // Biometric-without-hardware lands here from choose-guardian.
            navigate('/#choose-guardian');
          } else if (importType === ImportType.WalletFile) {
            navigate('/#import-from-file');
          } else {
            navigate('/#import-from-seed');
          }
        } else if (step === OnboardingStep.ImportSelectRecoveryMethod) {
          if (password === '__HARDWARE_ONLY__') {
            navigate('/#import-from-seed');
          } else {
            navigate('/#create-password');
          }
        } else if (step === OnboardingStep.ImportFromFile || step === OnboardingStep.ImportFromSeed) {
          navigate('/#select-import-type');
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
      case '#choose-protection':
        setOnboardingType(OnboardingType.Create);
        setStep(OnboardingStep.ChooseProtection);
        break;
      case '#setup-passcode':
        setOnboardingType(OnboardingType.Create);
        setStep(OnboardingStep.SetupPasscode);
        break;
      case '#setup-biometric':
        setOnboardingType(OnboardingType.Create);
        setStep(OnboardingStep.SetupBiometric);
        break;
      case '#choose-guardian':
        setOnboardingType(OnboardingType.Create);
        setStep(OnboardingStep.ChooseGuardian);
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
      case '#create-password':
        setStep(OnboardingStep.CreatePassword);
        break;
      case '#import-select-recovery-method':
        setStep(OnboardingStep.ImportSelectRecoveryMethod);
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
    <AwaitFonts name="Nunito" weights={[500, 600, 700]}>
      <div data-onboarding-root="true" className="h-full w-full bg-app-bg">
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
          guardianLookupError={guardianLookupError}
          confirmCreating={sidePanelHandoff && confirmPhase === 'creating'}
          onBiometricChange={setUseBiometric}
          onAction={onAction}
        />
      </div>
    </AwaitFonts>
  );
};

export default Welcome;
