import React, { FC, useCallback, useRef, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordsList from 'bip39/src/wordlists/english.json';

import { formatMnemonic } from 'app/defaults';
import { postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import type { GuardianDiscoveryResult } from 'lib/miden/guardian/discover';
import { GUARDIAN_PROBE_WAIT_DEADLINE_MS, useGuardianProbe } from 'lib/miden/guardian/use-guardian-probe';
import { clearClientStorage } from 'lib/miden/reset';
import { ENDPOINT_OVERRIDE_STORAGE_KEY } from 'lib/miden-chain/effective-endpoints';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

const ForgotPassword: FC = () => {
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  // Which BIP-44 namespace to recover into. `Vault.spawn` derives the account at
  // `m/44'/0'/<walletTypeIndex>'/0'` from this, and only runs the Guardian
  // lookup for `WalletType.Guardian`. It used to be hardcoded to Guardian, so a
  // user who onboarded with "no guardian" had their wallet wiped by
  // `clearClientStorage()` and then hit "No Guardian accounts found at this
  // guardian endpoint for this seed" — the OffChain account at
  // `m/44'/0'/1'/0'` was never derived or looked up. The recovery-method step
  // below now sets this the same way onboarding's
  // `import-select-recovery-method` does.
  const [walletType, setWalletType] = useState<WalletType>(WalletType.Guardian);
  /** Endpoint the user picked on the recovery-method step; overrides the probe. */
  const [selectedGuardianEndpoint, setSelectedGuardianEndpoint] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const { registerWallet } = useMidenContext();
  // Guardian auto-detection (issue #418). This flow has no recovery-method
  // screen, so the probe is invisible: it starts at seed submit and its winner
  // is written to the guardian-URL setting just before registering. When it
  // finds nothing (or is still running at the deadline) the previously stored
  // endpoint is used, exactly as before.
  const guardianProbe = useGuardianProbe();
  const startGuardianProbe = guardianProbe.start;
  const resetGuardianProbe = guardianProbe.reset;
  const probeResult = useRef<Promise<GuardianDiscoveryResult | undefined> | null>(null);

  /** The probe belongs to an entered import seed — drop it when leaving that path. */
  const discardGuardianProbe = useCallback(() => {
    probeResult.current = null;
    resetGuardianProbe();
  }, [resetGuardianProbe]);

  /**
   * Resolve the auto-detected guardian endpoint, waiting at most
   * {@link GUARDIAN_PROBE_WAIT_DEADLINE_MS} for a probe that is still running.
   * Returns undefined when nothing was detected (or the probe timed out); the
   * caller then threads no endpoint and the backend falls back to the legacy
   * stored endpoint / network default, exactly as before.
   */
  const detectGuardianEndpoint = useCallback(async (): Promise<string | undefined> => {
    const pending = probeResult.current;
    if (!pending) return undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<undefined>(resolve => {
        deadline = setTimeout(() => resolve(undefined), GUARDIAN_PROBE_WAIT_DEADLINE_MS);
      })
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    return result?.best?.endpoint;
  }, []);

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
      // Resolve the probed guardian endpoint (import path only) and thread it
      // explicitly into registerWallet (stage 1 of #408) rather than writing the
      // global GUARDIAN_URL_STORAGE_KEY. The probe result is held in memory, so
      // clearClientStorage above cannot clobber it. When nothing was detected the
      // endpoint stays undefined and the backend falls back to the stored /
      // default endpoint.
      // Endpoint only matters for a Guardian recovery; a non-guardian recovery
      // binds no endpoint (mirrors Welcome.tsx's `import-select-recovery-method`).
      const guardianEndpoint =
        onboardingType === OnboardingType.Import && walletType === WalletType.Guardian
          ? (selectedGuardianEndpoint ?? (await detectGuardianEndpoint()))
          : undefined;

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
  }, [
    password,
    seedPhrase,
    registerWallet,
    onboardingType,
    detectGuardianEndpoint,
    walletType,
    selectedGuardianEndpoint
  ]);

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
          probeResult.current = startGuardianProbe(words);
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
          setWalletType(action.payload.walletType);
          setSelectedGuardianEndpoint(
            action.payload.walletType === WalletType.Guardian ? action.payload.guardianEndpoint : undefined
          );
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
          // Guardian recovery just completed — hand off to the side panel like
          // first-run onboarding rather than always entering in-tab (#428).
          navigate(postOnboardingRoute());
          break;
        }
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
    [register, step, onboardingType, startGuardianProbe, discardGuardianProbe]
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
      recoveryError={recoveryError}
      guardianProbe={guardianProbe.state}
      onAction={onAction}
    />
  );
};

export default ForgotPassword;
