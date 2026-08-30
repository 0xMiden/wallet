import React, { FC, useCallback, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordsList from 'bip39/src/wordlists/english.json';

import { formatMnemonic } from 'app/defaults';
import { postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { useGuardianProbe } from 'lib/miden/guardian/use-guardian-probe';
import { clearClientStorage } from 'lib/miden/reset';
import { ENDPOINT_OVERRIDE_STORAGE_KEY } from 'lib/miden-chain/effective-endpoints';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

const ForgotPassword: FC = () => {
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  // `Vault.spawn` now scans BOTH public and guardian namespaces on every
  // import, so this no longer picks what gets recovered — it is only the
  // fresh-wallet fallback selector for a zero-found restore (guardian-backed
  // when an operator was chosen, public otherwise) and the create-path type
  // for the reset flow (Guardian, as before).
  const [walletType, setWalletType] = useState<WalletType>(WalletType.Guardian);
  /** Endpoint the user picked on the recovery-method step; overrides the probe. */
  const [selectedGuardianEndpoint, setSelectedGuardianEndpoint] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // Recovered-accounts overview state (post-registration import step).
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastScanFoundNone, setLastScanFoundNone] = useState(false);

  const { registerWallet, scanForAccounts } = useMidenContext();
  // Live list for the recovered-accounts overview — the store re-syncs after
  // every scan, so the screen updates itself as accounts are appended.
  const accounts = useWalletStore(s => s.accounts);
  // Guardian auto-detection (issue #418): starts at seed submit and prefills
  // the recovery-method screen's endpoint, which the user confirms (Continue)
  // or discards (skip). The submitted payload is the single source of truth —
  // there is no silent probe-result fallback anymore, because "skip" is an
  // explicit "I have no guardian".
  const guardianProbe = useGuardianProbe();
  const startGuardianProbe = guardianProbe.start;
  const resetGuardianProbe = guardianProbe.reset;

  /** The probe belongs to an entered import seed — drop it when leaving that path. */
  const discardGuardianProbe = useCallback(() => {
    resetGuardianProbe();
  }, [resetGuardianProbe]);

  // 'ok' registered | 'failed' registration threw AFTER the destructive reset |
  // 'skipped' preconditions absent so nothing ran and nothing was destroyed.
  const register = useCallback(async (): Promise<'ok' | 'failed' | 'skipped'> => {
    if (password && seedPhrase) {
      // `clearClientStorage()` is a blanket `localStorage.clear()`, and on
      // DESKTOP localStorage is also the platform key-value store
      // (`DesktopStorage`, prefix `miden_wallet_`) — so it takes the dev-settings
      // endpoint override with it, the one key a storage reset must survive
      // (`PRESERVED_STORAGE_KEYS` in lib/miden/reset). `Vault.spawn`'s own reset
      // snapshots that key AFTER this call, so it reads null and restores
      // nothing: the account is recovered on the custom network while the next
      // launch resolves the build-default endpoints, which is exactly the
      // account-here / client-there split the preserve list exists to prevent.
      // Snapshot and restore it around the wipe. On the extension and on mobile
      // the override lives in browser.storage.local / Capacitor Preferences,
      // which `localStorage.clear()` cannot reach, so the restore rewrites the
      // value it just read.
      const endpointOverrides = await fetchFromStorage(ENDPOINT_OVERRIDE_STORAGE_KEY);
      clearClientStorage();
      if (endpointOverrides != null) {
        await putToStorage(ENDPOINT_OVERRIDE_STORAGE_KEY, endpointOverrides);
      }
      // The endpoint the user confirmed on the recovery-method step (probe
      // prefills it there). Undefined = user skipped the guardian step; the
      // backend still runs a best-effort guardian scan against the stored /
      // default endpoint but won't fail the restore on it.
      const guardianEndpoint = onboardingType === OnboardingType.Import ? selectedGuardianEndpoint : undefined;

      const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
      try {
        await registerWallet(
          walletType,
          password,
          seedPhraseFormatted,
          onboardingType === OnboardingType.Import, // might be able to leverage ownMnemonic to determine whther to attempt imports in general
          guardianEndpoint
        );
        return 'ok';
      } catch (e) {
        // clearClientStorage() above has ALREADY wiped the local wallet, so a
        // failure here leaves the user with nothing. Swallowing it into
        // console.error (and then navigating away regardless) showed them an
        // empty wallet with no explanation — indistinguishable from data loss.
        // Surface it and stay put so Retry is reachable (#630).
        console.error(e);
        setRecoveryError(e instanceof Error ? e.message : String(e));
        return 'failed';
      }
    }
    return 'skipped';
  }, [password, seedPhrase, registerWallet, onboardingType, walletType, selectedGuardianEndpoint]);

  const onAction = useCallback(
    async (action: OnboardingAction) => {
      switch (action.id) {
        case 'create-wallet':
          discardGuardianProbe();
          setSeedPhrase(generateMnemonic(128).split(' '));
          setOnboardingType(OnboardingType.Create);
          setStep(OnboardingStep.BackupSeedPhrase);
          break;
        case 'select-import-type':
          // Recovery is seed-phrase only — jump straight to the seed entry screen.
          setOnboardingType(OnboardingType.Import);
          setStep(OnboardingStep.ImportFromSeed);
          break;
        case 'import-from-seed':
          setStep(OnboardingStep.ImportFromSeed);
          break;
        case 'import-seed-phrase-submit': {
          const words = action.payload.split(' ');
          setSeedPhrase(words);
          startGuardianProbe(words);
          // Mobile protection is a passcode; the full password is extension/desktop-only.
          setStep(isMobile() ? OnboardingStep.SetupPasscode : OnboardingStep.CreatePassword);
          break;
        }
        case 'backup-seed-phrase':
          discardGuardianProbe();
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
          // Recovery (import): ask which BIP-44 namespace the seed's accounts live
          // in instead of assuming Guardian — see `walletType` above. Reset
          // (create): a brand-new seed, so there is nothing to look up; keep going
          // straight to confirmation with the Guardian default.
          setStep(
            onboardingType === OnboardingType.Import
              ? OnboardingStep.ImportSelectRecoveryMethod
              : OnboardingStep.Confirmation
          );
          break;
        case 'import-select-recovery-method':
          // Fresh-wallet fallback selector only — the scan itself covers both
          // types (see the walletType comment above).
          setWalletType(action.payload.guardianEndpoint ? WalletType.Guardian : WalletType.OnChain);
          setSelectedGuardianEndpoint(action.payload.guardianEndpoint);
          setStep(OnboardingStep.Confirmation);
          break;
        case 'setup-passcode-submit':
          // Passcode IS the vault password (mobile import path).
          setPassword(action.payload);
          setStep(
            onboardingType === OnboardingType.Import
              ? OnboardingStep.ImportSelectRecoveryMethod
              : OnboardingStep.Confirmation
          );
          break;
        case 'confirmation': {
          setIsLoading(true);
          setRecoveryError(null);
          const outcome = await register();
          setIsLoading(false);
          // Block the exit ONLY on a real failure. 'skipped' means the guarded
          // branch never ran, so nothing was destroyed and the previous
          // navigate-home behaviour is still right; 'failed' means the reset
          // already happened, so leaving would strand the user on a wiped
          // wallet with no explanation (#630).
          if (outcome === 'failed') break;
          // Imports pause on the recovered-accounts overview before entering;
          // the reset flow hands off to the side panel like first-run
          // onboarding rather than always entering in-tab (#428).
          if (outcome === 'ok' && onboardingType === OnboardingType.Import) {
            setStep(OnboardingStep.RecoveredAccounts);
            break;
          }
          navigate(postOnboardingRoute());
          break;
        }
        case 'scan-more-accounts':
          setIsScanning(true);
          setScanError(null);
          setLastScanFoundNone(false);
          try {
            const found = await scanForAccounts(action.payload.count, selectedGuardianEndpoint);
            setLastScanFoundNone(found.length === 0);
          } catch (error) {
            setScanError(error instanceof Error ? error.message : String(error));
          } finally {
            setIsScanning(false);
          }
          break;
        case 'recovered-accounts-continue':
          navigate(postOnboardingRoute());
          break;
        case 'back':
          if (step === OnboardingStep.VerifySeedPhrase) {
            setStep(OnboardingStep.BackupSeedPhrase);
          } else if (step === OnboardingStep.BackupSeedPhrase) {
            setStep(OnboardingStep.Welcome);
          } else if (step === OnboardingStep.CreatePassword) {
            if (onboardingType === OnboardingType.Create) {
              setStep(OnboardingStep.VerifySeedPhrase);
            } else {
              setStep(OnboardingStep.ImportFromSeed);
            }
          } else if (step === OnboardingStep.ImportSelectRecoveryMethod) {
            setStep(isMobile() ? OnboardingStep.SetupPasscode : OnboardingStep.CreatePassword);
          } else if (step === OnboardingStep.SetupPasscode) {
            setStep(OnboardingStep.ImportFromSeed);
          } else if (step === OnboardingStep.ImportFromSeed) {
            setStep(OnboardingStep.Welcome);
          }
          break;
        default:
          break;
      }
    },
    [
      register,
      step,
      onboardingType,
      startGuardianProbe,
      discardGuardianProbe,
      scanForAccounts,
      selectedGuardianEndpoint
    ]
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
    // The overview is terminal — the wallet already exists; Continue is the
    // only way forward.
    if (step === OnboardingStep.RecoveredAccounts) {
      return true;
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
      recoveryError={recoveryError}
      guardianProbe={guardianProbe.state}
      recoveredAccounts={accounts}
      isScanning={isScanning}
      scanError={scanError}
      lastScanFoundNone={lastScanFoundNone}
      onAction={onAction}
    />
  );
};

export default ForgotPassword;
