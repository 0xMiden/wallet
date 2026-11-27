import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { englishWordlist as wordsList, generateMnemonic } from '@miden/hd-key';
import { formatMnemonic } from 'app/defaults';
import { markOnboardingFinishing, navigateOnFromOnboarding } from 'app/onboarding-finish';
import { postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import { useMidenContext, request } from 'lib/miden/front';
import { fetchFromStorage } from 'lib/miden/front/storage';
import type { GuardianDiscoveryResult } from 'lib/miden/guardian/discover';
import { GUARDIAN_PROBE_WAIT_DEADLINE_MS, useGuardianProbe } from 'lib/miden/guardian/use-guardian-probe';
import { prepareMainnet } from 'lib/miden/prepare-mainnet';
import { clearClientStorageAfterRestore } from 'lib/miden/reset';
import {
  applyEndpointOverride,
  clearEndpointOverride,
  ENDPOINT_OVERRIDE_STORAGE_KEY,
  EndpointOverride,
  getEffectiveNetworkName,
  hasDeveloperNetworkChoice
} from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension, isMobile } from 'lib/platform';
import { followEffectiveNetwork } from 'lib/remote-config/runtime';
import { isInviteOnlyRequired, useMainnetLaunched } from 'lib/remote-config/use-mainnet-launch';
import { WalletMessageType } from 'lib/shared/types';
import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';
import { isUserErrorId, UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { navigate } from 'lib/woozie';
import { errorToMessage } from 'screens/onboarding/error-message';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

async function refreshRealmEndpointOverrides(): Promise<void> {
  if (isExtension()) {
    await request({ type: WalletMessageType.ReloadEndpointOverridesRequest });
  } else {
    await followEffectiveNetwork();
  }
}

const ForgotPassword: FC = () => {
  const { t } = useTranslation();
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [keyPairPayload, setKeyPairPayload] = useState<string | null>(null);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  // Which BIP-44 namespace to recover into. `Vault.spawn` derives the account at
  // index 0 of this wallet type's `getMainDerivationPath` namespace, and only
  // runs the Guardian lookup for `WalletType.Guardian`. The recovery-method
  // step sets this the same way onboarding's `import-select-recovery-method` does.
  const [walletType, setWalletType] = useState<WalletType>(WalletType.Guardian);
  /** Endpoint the user picked on the recovery-method step; overrides the probe. */
  const [selectedGuardianEndpoint, setSelectedGuardianEndpoint] = useState<string | undefined>(undefined);
  const [password, setPassword] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryErrorId, setRecoveryErrorId] = useState<UserErrorId | undefined>(undefined);
  // A new wallet on an invite-only network (mainnet, or any network once mainnet has launched) needs a
  // code, which this page does not take: its Welcome offers recovery only.
  const launched = useMainnetLaunched();
  const liveRecoverOnly = isInviteOnlyRequired(launched, getEffectiveNetworkName(), hasDeveloperNetworkChoice());
  // Fixed when the user leaves Welcome: a document that changes mid-reset must not move a recovery, or a fresh
  // wallet, made for the network it started on.
  const [startedRecoverOnly, setStartedRecoverOnly] = useState<boolean | null>(null);
  useEffect(() => {
    if (step === OnboardingStep.Welcome) setStartedRecoverOnly(null);
    else setStartedRecoverOnly(started => started ?? liveRecoverOnly);
  }, [step, liveRecoverOnly]);
  const recoverOnly = step === OnboardingStep.Welcome ? liveRecoverOnly : (startedRecoverOnly ?? liveRecoverOnly);
  // A recover-only reset restores into mainnet but switches there only at Confirm, so until then the wallet is still
  // on its old network: the probe and the recovery-method step are told which network the recovery restores into.
  const recoveryNetwork = recoverOnly ? MIDEN_NETWORK_NAME.MAINNET : undefined;

  const { registerWallet, registerWalletFromHotKey } = useMidenContext();
  // Guardian auto-detection (issue #418). The probe runs unseen from seed or hot-key
  // submit; its winner is passed to registration unless the user picked an endpoint on
  // the recovery-method step.
  const guardianProbe = useGuardianProbe(recoveryNetwork);
  const startGuardianProbe = guardianProbe.start;
  const startGuardianProbeWithKey = guardianProbe.startWithKey;
  const resetGuardianProbe = guardianProbe.reset;
  const probeResult = useRef<Promise<GuardianDiscoveryResult | undefined> | null>(null);

  // Telemetry for the `recover` flow — regaining access to an EXISTING wallet
  // from its seed phrase or hot key. The other half of this screen (wipe and create a
  // fresh wallet) is not a recovery, so it never opens a flow and every
  // settle below is a no-op for it.
  const flowRef = useRef<FlowHandle | null>(null);

  // The handle is idempotent, but clearing the ref keeps a later settle from
  // being attributed to a flow that has already ended.
  const settleRecoverFlow = useCallback((settle: (handle: FlowHandle) => void) => {
    const handle = flowRef.current;
    if (!handle) return;
    flowRef.current = null;
    settle(handle);
  }, []);

  // An unmount with the flow still open is an abandonment we can see, so record
  // it as cancelled rather than leaving an unmatched `started`.
  useEffect(
    () => () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    },
    []
  );

  /**
   * The probe belongs to an entered import seed or hot key: drop it when leaving
   * that path. Leaving also abandons the recovery itself, so the `recover` flow is
   * cancelled here rather than at each individual exit.
   */
  const discardGuardianProbe = useCallback(() => {
    probeResult.current = null;
    resetGuardianProbe();
    settleRecoverFlow(handle => handle.cancel());
  }, [resetGuardianProbe, settleRecoverFlow]);

  const handleCancel = useCallback(() => {
    discardGuardianProbe();
    navigate('/unlock');
  }, [discardGuardianProbe]);

  /**
   * Resolve the auto-detected guardian endpoint, waiting at most
   * {@link GUARDIAN_PROBE_WAIT_DEADLINE_MS} for a probe that is still running.
   * Returns undefined when nothing was detected (or the probe timed out); the
   * caller then threads no endpoint and the backend falls back to the network
   * default, exactly as before.
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

  // 'ok' registered | 'failed' registration or switch threw (with no prior wipe on
  // pre-commit failure) | 'skipped' preconditions absent so nothing ran.
  const register = useCallback(async (): Promise<'ok' | 'failed' | 'skipped'> => {
    if (password && (seedPhrase || keyPairPayload)) {
      let switchedMainnet = false;
      let registrationCommitted = false;
      let previousOverride: EndpointOverride | null = null;
      try {
        // An invite-only config recovers on mainnet: snapshot any current endpoint
        // override and switch right before registration; roll back on pre-commit failure.
        if (recoverOnly) {
          const switchingFromOtherNetwork = getEffectiveNetworkName() !== MIDEN_NETWORK_NAME.MAINNET;
          if (switchingFromOtherNetwork) {
            previousOverride = await fetchFromStorage<EndpointOverride | null>(ENDPOINT_OVERRIDE_STORAGE_KEY);
          }
          await prepareMainnet();
          switchedMainnet = switchingFromOtherNetwork;
        }
        const guardianEndpoint =
          onboardingType === OnboardingType.Import && walletType === WalletType.Guardian
            ? (selectedGuardianEndpoint ?? (await detectGuardianEndpoint()))
            : undefined;

        if (keyPairPayload) {
          await registerWalletFromHotKey(password, keyPairPayload, guardianEndpoint);
        } else {
          const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
          await registerWallet(
            walletType,
            password,
            seedPhraseFormatted,
            onboardingType === OnboardingType.Import,
            guardianEndpoint
          );
        }
        registrationCommitted = true;
        await clearClientStorageAfterRestore();
        return 'ok';
      } catch (e) {
        if (switchedMainnet && !registrationCommitted) {
          try {
            if (previousOverride) {
              await applyEndpointOverride(previousOverride);
            } else {
              await clearEndpointOverride();
            }
            await refreshRealmEndpointOverrides();
          } catch (rollbackError) {
            console.error('Failed to revert mainnet endpoint switch:', rollbackError);
          }
        }
        console.error(e);
        const ownMessage = errorToMessage(e);
        const errorCode = e && typeof e === 'object' && 'code' in e ? (e as { code?: unknown }).code : undefined;
        setRecoveryError(ownMessage ?? t('smthWentWrong'));
        setRecoveryErrorId(
          ownMessage ? (isUserErrorId(errorCode) ? errorCode : 'raw_onboarding_recovery_failed') : 'smthWentWrong'
        );
        settleRecoverFlow(handle => handle.fail(classifyError(e)));
        return 'failed';
      }
    }
    return 'skipped';
  }, [
    password,
    seedPhrase,
    keyPairPayload,
    recoverOnly,
    registerWallet,
    registerWalletFromHotKey,
    onboardingType,
    detectGuardianEndpoint,
    settleRecoverFlow,
    walletType,
    selectedGuardianEndpoint,
    t
  ]);

  const onAction = useCallback(
    async (action: OnboardingAction) => {
      switch (action.id) {
        // The Welcome step's Get started emits choose-protection; this page has no protection picker.
        case 'choose-protection':
        case 'create-wallet':
          discardGuardianProbe();
          setKeyPairPayload(null);
          setSeedPhrase(generateMnemonic().split(' '));
          setOnboardingType(OnboardingType.Create);
          setStep(OnboardingStep.BackupSeedPhrase);
          break;
        case 'select-import-type':
          // Entering seed recovery: begin `recover` telemetry flow and jump straight to seed entry.
          flowRef.current?.cancel();
          flowRef.current = beginFlow('recover');
          setKeyPairPayload(null);
          setOnboardingType(OnboardingType.Import);
          setStep(OnboardingStep.ImportFromSeed);
          break;
        case 'import-from-seed':
          setKeyPairPayload(null);
          setStep(OnboardingStep.ImportFromSeed);
          break;
        case 'import-with-key':
          flowRef.current?.cancel();
          flowRef.current = beginFlow('recover');
          setSeedPhrase([]);
          setKeyPairPayload(null);
          setOnboardingType(OnboardingType.Import);
          setStep(OnboardingStep.ImportFromKey);
          break;
        case 'import-seed-phrase-submit': {
          const words = action.payload.split(' ');
          setKeyPairPayload(null);
          setSeedPhrase(words);
          probeResult.current = startGuardianProbe(words);
          // Mobile protection is a passcode; the full password is extension/desktop-only.
          setStep(isMobile() ? OnboardingStep.SetupPasscode : OnboardingStep.CreatePassword);
          break;
        }
        case 'import-hot-key-submit':
          setSeedPhrase([]);
          setKeyPairPayload(action.payload);
          probeResult.current = startGuardianProbeWithKey(action.payload);
          setStep(isMobile() ? OnboardingStep.SetupPasscode : OnboardingStep.CreatePassword);
          break;
        case 'retry-guardian-probe':
          setRecoveryError(null);
          setRecoveryErrorId(undefined);
          if (keyPairPayload) {
            probeResult.current = startGuardianProbeWithKey(keyPairPayload);
          } else if (seedPhrase.length > 0) {
            probeResult.current = startGuardianProbe(seedPhrase);
          }
          break;
        case 'backup-seed-phrase':
          discardGuardianProbe();
          setKeyPairPayload(null);
          setSeedPhrase(generateMnemonic().split(' '));
          setStep(OnboardingStep.BackupSeedPhrase);
          break;
        case 'verify-seed-phrase':
          setStep(OnboardingStep.VerifySeedPhrase);
          break;
        case 'create-password':
          setStep(isMobile() ? OnboardingStep.SetupPasscode : OnboardingStep.CreatePassword);
          break;
        case 'create-password-submit':
          setPassword(action.payload.password);
          // Recovery (import): ask which BIP-44 namespace / Guardian endpoint to use.
          // Reset (create): fresh seed goes straight to Confirmation with Guardian default.
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
          // Passcode IS the vault password (mobile create and import paths).
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
          setRecoveryErrorId(undefined);
          // A Ready broadcast can land while register() finishes; the mark keeps Home off screen until we navigate on.
          const finishMark = markOnboardingFinishing();
          try {
            const outcome = await register();
            finishMark.arm();
            // Block exit on failure so the user sees why restoration did not finish (#630).
            if (outcome === 'failed') break;
            if (outcome === 'ok') settleRecoverFlow(handle => handle.complete());
            // Guardian recovery just completed — hand off to the side panel like
            // first-run onboarding rather than always entering in-tab (#428).
            navigateOnFromOnboarding(postOnboardingRoute());
          } finally {
            setIsLoading(false);
            finishMark.release();
          }
          break;
        }
        case 'back':
          if (step === OnboardingStep.VerifySeedPhrase) {
            setStep(OnboardingStep.BackupSeedPhrase);
          } else if (step === OnboardingStep.BackupSeedPhrase) {
            setStep(OnboardingStep.Welcome);
          } else if (step === OnboardingStep.CreatePassword) {
            setStep(
              onboardingType === OnboardingType.Create
                ? OnboardingStep.VerifySeedPhrase
                : keyPairPayload
                  ? OnboardingStep.ImportFromKey
                  : OnboardingStep.ImportFromSeed
            );
          } else if (step === OnboardingStep.ImportSelectRecoveryMethod) {
            setStep(isMobile() ? OnboardingStep.SetupPasscode : OnboardingStep.CreatePassword);
          } else if (step === OnboardingStep.SetupPasscode) {
            setStep(
              onboardingType === OnboardingType.Create
                ? OnboardingStep.VerifySeedPhrase
                : keyPairPayload
                  ? OnboardingStep.ImportFromKey
                  : OnboardingStep.ImportFromSeed
            );
          } else if (step === OnboardingStep.Confirmation) {
            setRecoveryError(null);
            setRecoveryErrorId(undefined);
            setStep(
              onboardingType === OnboardingType.Import
                ? OnboardingStep.ImportSelectRecoveryMethod
                : isMobile()
                  ? OnboardingStep.SetupPasscode
                  : OnboardingStep.CreatePassword
            );
          } else if (step === OnboardingStep.ImportFromSeed || step === OnboardingStep.ImportFromKey) {
            // Back to the reset screen's own welcome step — out of the recovery.
            setKeyPairPayload(null);
            discardGuardianProbe();
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
      seedPhrase,
      keyPairPayload,
      startGuardianProbe,
      startGuardianProbeWithKey,
      discardGuardianProbe,
      settleRecoverFlow
    ]
  );

  // Handle mobile back button/gesture in forgot password flow
  useMobileBackHandler(() => {
    // On welcome screen, go back to unlock page
    if (step === OnboardingStep.Welcome) {
      navigate('/');
      return true;
    }
    // On confirmation while loading, don't allow back
    if (step === OnboardingStep.Confirmation && isLoading) {
      return true; // Consume but don't navigate
    }
    // Trigger the back action
    onAction({ id: 'back' });
    return true;
  }, [step, isLoading, onAction]);

  return (
    <OnboardingFlow
      recoverOnly={recoverOnly}
      wordslist={wordsList}
      seedPhrase={seedPhrase}
      onboardingType={onboardingType}
      step={step}
      isLoading={isLoading}
      recoveryError={recoveryError}
      recoveryErrorId={recoveryErrorId}
      guardianProbe={guardianProbe.state}
      guardianNetwork={recoveryNetwork}
      importViaKey={Boolean(keyPairPayload)}
      canCreateWithPhrase={!recoverOnly && seedPhrase.length > 0 && !keyPairPayload}
      replacesExistingWallet
      canGoBack={!isLoading}
      onAction={onAction}
      onCancel={handleCancel}
    />
  );
};

export default ForgotPassword;
