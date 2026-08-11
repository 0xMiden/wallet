import React, { FC, useCallback, useRef, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordsList from 'bip39/src/wordlists/english.json';

import { formatMnemonic } from 'app/defaults';
import { postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import type { GuardianDiscoveryResult } from 'lib/miden/guardian/discover';
import { GUARDIAN_PROBE_WAIT_DEADLINE_MS, useGuardianProbe } from 'lib/miden/guardian/use-guardian-probe';
import { clearClientStorage } from 'lib/miden/reset';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

const ForgotPassword: FC = () => {
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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

  const register = useCallback(async () => {
    if (password && seedPhrase) {
      clearClientStorage();
      // Resolve the probed guardian endpoint (import path only) and thread it
      // explicitly into registerWallet (stage 1 of #408) rather than writing the
      // global GUARDIAN_URL_STORAGE_KEY. The probe result is held in memory, so
      // clearClientStorage above cannot clobber it. When nothing was detected the
      // endpoint stays undefined and the backend falls back to the stored /
      // default endpoint.
      const guardianEndpoint = onboardingType === OnboardingType.Import ? await detectGuardianEndpoint() : undefined;

      const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
      try {
        await registerWallet(
          WalletType.Guardian,
          password,
          seedPhraseFormatted,
          onboardingType === OnboardingType.Import, // might be able to leverage ownMnemonic to determine whther to attempt imports in general
          guardianEndpoint
        );
      } catch (e) {
        console.error(e);
      }
    }
  }, [password, seedPhrase, registerWallet, onboardingType, detectGuardianEndpoint]);

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
          setStep(OnboardingStep.Confirmation);
          break;
        case 'setup-passcode-submit':
          // Passcode IS the vault password (mobile import path).
          setPassword(action.payload);
          setStep(OnboardingStep.Confirmation);
          break;
        case 'confirmation':
          setIsLoading(true);
          await register();
          setIsLoading(false);
          // Guardian recovery just completed — hand off to the side panel like
          // first-run onboarding rather than always entering in-tab (#428).
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
      onAction={onAction}
    />
  );
};

export default ForgotPassword;
