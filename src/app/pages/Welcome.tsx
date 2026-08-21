import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordslist from 'bip39/src/wordlists/english.json';

import AwaitFonts from 'app/a11y/AwaitFonts';
import { formatMnemonic } from 'app/defaults';
import { canHandoffToSidePanel, postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import { useMidenContext } from 'lib/miden/front';
import { useGuardianProbe } from 'lib/miden/guardian/use-guardian-probe';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isDesktop, isMobile } from 'lib/platform';
import { hasTelemetryChoice } from 'lib/settings/helpers';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { fetchStateFromBackend } from 'lib/store/hooks/useIntercomSync';
import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';
import { seedWalletPrompt, WalletPromptType } from 'lib/wallet-prompts';
import { navigate, useLocation } from 'lib/woozie';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import { OnboardingAction, OnboardingStep, OnboardingType, WalletType } from 'screens/onboarding/types';

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
 * Biometric / FaceID protection is only ever available on mobile (Capacitor).
 * On the browser extension and Tauri desktop there is no biometric API at all,
 * so the "choose how to protect your wallet" step collapses to a single real
 * option. When biometric can't work, onboarding skips that screen entirely and
 * goes straight to the full-password step (passcodes are mobile-only).
 */
function biometricProtectionSupported(): boolean {
  return isMobile();
}

/**
 * Where the create flow's protection step lives per platform: mobile offers the
 * biometric-vs-passcode choice; the extension and desktop keep the classic
 * full password (no passcode UI at all — passcodes are mobile-only).
 */
function protectionStepRoute(): string {
  return biometricProtectionSupported() ? '/#choose-protection' : '/#create-password';
}

/**
 * Where a finished onboarding goes next.
 *
 * The telemetry consent prompt is a one-time detour in front of `destination`,
 * taken only while the user has never answered it — asking is worth one screen,
 * re-asking someone who has already decided is not, which is what
 * `hasTelemetryChoice()` rules out. The prompt continues to `destination`'s own
 * route itself, so Chrome's chain stays create → consent → /finish-side-panel.
 *
 * Only ever called once the wallet exists: a user who has not got a wallet, or
 * whose creation failed, is not asked at all.
 */
function postCreationRoute(destination: string): string {
  return hasTelemetryChoice() ? destination : '/help-improve-wallet';
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
  const [password, setPassword] = useState<string | null>(null);
  const [walletType, setWalletType] = useState<WalletType>(WalletType.Guardian);
  // The guardian operator endpoint the user picked (choose-guardian) or that the
  // import recovery-method screen resolved. Threaded explicitly into
  // registerWallet (stage 1 of #408) so a new Guardian account binds to it,
  // replacing the former write to the global GUARDIAN_URL_STORAGE_KEY. Undefined
  // for non-guardian (public) wallets.
  const [guardianEndpoint, setGuardianEndpoint] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [useBiometric, setUseBiometric] = useState(true);
  const [isHardwareSecurityAvailable, setIsHardwareSecurityAvailable] = useState(false);
  const [biometricAttempts, setBiometricAttempts] = useState(0);
  const [biometricError, setBiometricError] = useState<string | null>(null);
  const [guardianLookupError, setGuardianLookupError] = useState(false);
  // Tracks which protection screen the user came through; needed so ChooseGuardian
  // back navigation and the create-password→confirmation routing pick the right
  // origin without colliding with the legacy create flow.
  const [protectionMethod, setProtectionMethod] = useState<'passcode' | 'biometric' | 'password' | null>(null);
  const { registerWallet } = useMidenContext();
  // Guardian auto-detection (issue #418): kicked off in the background the
  // moment a seed phrase is submitted, so it is usually already resolved by the
  // time the user gets through the password/passcode step to the
  // recovery-method screen.
  const guardianProbe = useGuardianProbe();
  const resetGuardianProbe = guardianProbe.reset;
  // Without a seed phrase in memory (e.g. the popup was reopened directly on the
  // recovery-method screen) there is nothing to detect — leave the probe prop
  // undefined so that screen renders its classic manual picker rather than an
  // endless spinner.
  const guardianProbeState = seedPhrase ? guardianProbe.state : undefined;
  const syncFromBackend = useWalletStore(s => s.syncFromBackend);

  // Chrome side panel handoff: create the wallet while the confirmation screen
  // spins, then the final "Open wallet" click opens the side panel onto the
  // ready wallet (sidePanel.open() needs that click's live gesture). Disabled
  // under E2E and on non-Chrome — those keep the classic click-to-create flow.
  const sidePanelHandoff = useMemo(() => canHandoffToSidePanel(), []);
  const [confirmPhase, setConfirmPhase] = useState<'idle' | 'creating' | 'failed'>('idle');

  // Telemetry for the onboarding flow the user is currently walking through.
  // Held in a ref rather than state because settling it must never re-render.
  const flowRef = useRef<FlowHandle | null>(null);

  // Entering a path starts a flow. Re-entering after backing out cancels the
  // abandoned one first, so a single mount can never leave two flows open.
  const beginOnboardingFlow = useCallback((flow: 'create' | 'import') => {
    flowRef.current?.cancel();
    flowRef.current = beginFlow(flow);
  }, []);

  // The handle is idempotent, but clearing the ref keeps a later settle from
  // being attributed to a flow that has already ended.
  const settleOnboardingFlow = useCallback((settle: (handle: FlowHandle) => void) => {
    const handle = flowRef.current;
    if (!handle) return;
    flowRef.current = null;
    settle(handle);
  }, []);

  // Back navigation only abandons the flow when it leaves onboarding for the
  // welcome screen; every other `back` target is a step *within* the flow.
  const cancelOnLeavingOnboarding = useCallback(
    (target: string) => {
      if (target !== '/') return;
      settleOnboardingFlow(handle => handle.cancel());
    },
    [settleOnboardingFlow]
  );

  // An unmount with the flow still open is an abandonment we can actually see,
  // so record it as cancelled rather than leaving an unmatched `started`. A
  // flow already settled above is unaffected — the ref is null by then.
  useEffect(
    () => () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    },
    []
  );

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
    // Guardian endpoint override for the bypass. Production sets this via the
    // ChooseGuardian / ImportRecoveryMethod screens, which the bypass skips — so
    // thread it from the `guardianUrl` param the E2E helper passes. register()
    // forwards it as the guardianEndpoint override, exactly like the real picker,
    // so createGuardianAccount (create) and Vault.spawn's recovery scan (import)
    // bind to it rather than the retired global GUARDIAN_URL_STORAGE_KEY read
    // (#408 stage 3). Only meaningful for a Guardian wallet.
    const bypassGuardianUrl = params.get('guardianUrl') || undefined;
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
    // E2E-only: surface the mnemonic actually used for this bypass run
    // (freshly generated for Create, or the caller's own for Import) so the
    // harness can recover the just-created wallet from a SEPARATE profile
    // (see ChromeWalletPage.createGuardianWallet's return value in
    // playwright/e2e/helpers/wallet-page.ts). Without this, a bypass-created
    // wallet's random mnemonic only ever lives in this component's React
    // state -- the UI never renders it (the bypass skips BackUpSeedPhrase),
    // so nothing outside this closure could otherwise read it back. Zero
    // production impact: this whole effect is gated on MIDEN_E2E_TEST above,
    // same as __TEST_STORE__ / __TEST_INTERCOM__ (src/lib/store/index.ts).
    (globalThis as { __TEST_LAST_GENERATED_SEED__?: string }).__TEST_LAST_GENERATED_SEED__ = testSeed.join(' ');
    const testPassword = params.get('password') || 'password1';
    setWalletType(bypassWalletType);
    if (bypassWalletType === WalletType.Guardian && bypassGuardianUrl) {
      setGuardianEndpoint(bypassGuardianUrl);
    }
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

  // Fire-and-forget: navigation must not wait on the network. The result lands
  // in `guardianProbe.state`, which the recovery-method screen renders.
  const startGuardianProbe = useCallback(
    (words: string[]) => {
      void guardianProbe.start(words);
    },
    [guardianProbe]
  );

  const register = useCallback(async () => {
    if (password && seedPhrase) {
      const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
      // For hardware-only wallets, pass undefined as password
      const actualPassword = password === '__HARDWARE_ONLY__' ? undefined : password;
      await registerWallet(
        walletType,
        actualPassword,
        seedPhraseFormatted,
        onboardingType === OnboardingType.Import,
        guardianEndpoint
      );
      if (onboardingType === OnboardingType.Create) {
        await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
      }
    } else {
      throw new Error('Missing password or seed phrase');
    }
  }, [password, seedPhrase, registerWallet, onboardingType, walletType, guardianEndpoint]);

  // Side panel handoff: kick off wallet creation as soon as the confirmation
  // screen is reached (the screen shows a spinner), so the wallet is Ready by
  // the time the user clicks "Open wallet". Scoped to the Create flow only:
  //   - the hardware/biometric path must prompt biometrics on an explicit tap,
  //     not on arrival;
  //   - import flows are excluded because guardian lookup can fail and needs
  //     the in-tab retry UI — imports keep the classic in-tab flow.
  // The `confirmPhase !== 'idle'` guard makes this fire at most once even though
  // `register` is (correctly) in the dependency array.
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
        settleOnboardingFlow(handle => handle.complete());
        // Move to the dedicated handoff route, which survives the Ready
        // transition and shows the "Open wallet" button. Crucially we do NOT
        // waitForReadyState here — pushing Ready into the store first would
        // route this tab to the wallet home before we navigate.
        navigate(postCreationRoute('/finish-side-panel'));
      } catch (error) {
        // Fall back to the classic click-to-create flow: the confirmation
        // button reverts to running register() in-tab on the next tap.
        console.error('[Welcome] Side panel handoff auto-create failed:', error);
        settleOnboardingFlow(handle => handle.fail(classifyError(error)));
        setConfirmPhase('failed');
      }
    })();
  }, [sidePanelHandoff, step, confirmPhase, onboardingType, password, seedPhrase, register, settleOnboardingFlow]);

  const onAction = async (action: OnboardingAction) => {
    switch (action.id) {
      case 'choose-protection':
        beginOnboardingFlow('create');
        setOnboardingType(OnboardingType.Create);
        // Biometric is unavailable on the extension/desktop, so the
        // choose-protection screen has only one real option — skip it and go
        // straight to the full-password step.
        navigate(protectionStepRoute());
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
        if (onboardingType === OnboardingType.Import) {
          // Import flow (mobile, no hardware security): keep the imported seed —
          // the passcode only protects the vault.
          setPassword(action.payload);
          setProtectionMethod('passcode');
          navigate('/#import-select-recovery-method');
          break;
        }
        setSeedPhrase(generateMnemonic(128).split(' '));
        setOnboardingType(OnboardingType.Create);
        setPassword(action.payload);
        setProtectionMethod('passcode');
        navigate('/#choose-guardian');
        break;
      case 'choose-guardian-submit':
        setGuardianEndpoint(action.payload.guardianEndpoint);
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
        beginOnboardingFlow('import');
        // Recovery is seed-phrase only — jump straight to the seed entry screen.
        setOnboardingType(OnboardingType.Import);
        navigate('/#import-from-seed');
        break;
      case 'import-from-seed':
        navigate('/#import-from-seed');
        break;
      case 'import-seed-phrase-submit':
        setSeedPhrase(action.payload.split(' '));
        // Start guardian auto-detection here rather than on the recovery-method
        // screen: it then runs behind the password/passcode step and is usually
        // already resolved when that screen mounts.
        startGuardianProbe(action.payload.split(' '));
        // Check if hardware security is available - if so, skip password step
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (hardwareAvailable) {
            // Hardware-only mode: skip password, go to recovery method selection
            setPassword('__HARDWARE_ONLY__');
            navigate('/#import-select-recovery-method');
          } else {
            // Mobile protection is a passcode; the full password is extension/desktop-only.
            navigate(isMobile() ? '/#setup-passcode' : '/#create-password');
          }
        }
        break;
      case 'create-password-submit':
        setPassword(action.payload.password);
        if (onboardingType === OnboardingType.Create && !isMobile()) {
          // Extension/desktop create flow: the password screen replaces
          // passcode setup and runs before guardian selection — generate the
          // mnemonic here, exactly like setup-passcode-submit does.
          setSeedPhrase(generateMnemonic(128).split(' '));
          setProtectionMethod('password');
          navigate('/#choose-guardian');
        } else if (onboardingType === OnboardingType.Import) {
          navigate('/#import-select-recovery-method');
        } else {
          navigate('/#confirmation');
        }
        break;
      case 'retry-guardian-probe':
        if (seedPhrase) startGuardianProbe(seedPhrase);
        break;
      case 'import-select-recovery-method':
        setWalletType(action.payload.walletType);
        // Capture the resolved endpoint for a Guardian import so register() can
        // thread it explicitly; leave it undefined for a public (non-guardian)
        // recovery so no endpoint is bound.
        setGuardianEndpoint(
          action.payload.walletType === WalletType.Guardian ? action.payload.guardianEndpoint : undefined
        );
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
          settleOnboardingFlow(handle => handle.complete());
          // Recovery/import completes in this classic handler (the Create flow
          // takes the auto-create effect above). Hand off to the side panel just
          // like Create does, instead of always entering in-tab (#428).
          navigate(postCreationRoute(postOnboardingRoute()));
        } catch (error) {
          console.error('[Welcome] Confirmation flow failed:', error);
          setIsLoading(false);
          settleOnboardingFlow(handle => handle.fail(classifyError(error)));
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
        if (step === OnboardingStep.SelectWalletType || step === OnboardingStep.ChooseProtection) {
          cancelOnLeavingOnboarding('/');
          navigate('/');
        } else if (step === OnboardingStep.SetupPasscode || step === OnboardingStep.SetupBiometric) {
          if (onboardingType === OnboardingType.Import) {
            navigate('/#import-from-seed');
          } else {
            // The choose-protection screen is skipped when biometric is
            // unavailable, so backing out of passcode setup returns to Welcome.
            const target = biometricProtectionSupported() ? '/#choose-protection' : '/';
            cancelOnLeavingOnboarding(target);
            navigate(target);
          }
        } else if (step === OnboardingStep.ChooseGuardian) {
          if (protectionMethod === 'biometric') {
            navigate('/#setup-biometric');
          } else if (protectionMethod === 'password') {
            navigate('/#create-password');
          } else {
            navigate('/#setup-passcode');
          }
        } else if (step === OnboardingStep.CreatePassword) {
          if (onboardingType === OnboardingType.Create) {
            // Extension/desktop: the password screen is the first protection
            // step, so back returns to Welcome. On mobile the
            // biometric-without-hardware path lands here from choose-guardian.
            const target = isMobile() ? '/#choose-guardian' : '/';
            cancelOnLeavingOnboarding(target);
            navigate(target);
          } else {
            navigate('/#import-from-seed');
          }
        } else if (step === OnboardingStep.ImportSelectRecoveryMethod) {
          if (password === '__HARDWARE_ONLY__') {
            navigate('/#import-from-seed');
          } else {
            navigate(isMobile() ? '/#setup-passcode' : '/#create-password');
          }
        } else if (step === OnboardingStep.ImportFromSeed) {
          cancelOnLeavingOnboarding('/');
          navigate('/');
        }
        break;
      default:
        break;
    }
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
        // Never render the choose-protection screen where biometric can't work
        // (guards direct hash navigation / reload); redirect to the platform's
        // protection step instead.
        if (!biometricProtectionSupported()) {
          navigate(protectionStepRoute());
          break;
        }
        setStep(OnboardingStep.ChooseProtection);
        break;
      case '#setup-passcode':
        // The import flow also lands here on mobile — don't clobber its type.
        setOnboardingType(prev => prev ?? OnboardingType.Create);
        // Passcodes are mobile-only — the extension/desktop create flow uses
        // the full password screen (guards direct hash navigation / reload).
        if (!isMobile()) {
          navigate('/#create-password');
          break;
        }
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
      case '#import-from-seed':
        setOnboardingType(OnboardingType.Import);
        setStep(OnboardingStep.ImportFromSeed);
        // Backing out to seed entry invalidates any detection for the previous
        // phrase — abort it so a stale result can't be shown for a new seed.
        resetGuardianProbe();
        break;
      case '#create-password':
        // Onboarding state is in-memory only; reloading on this screen loses
        // onboardingType (and the generated/imported seed phrase), so a
        // create-password submit would dead-end at Confirmation with no seed.
        // Restart from Welcome instead of entering that broken flow.
        if (onboardingType === null) {
          navigate('/');
          break;
        }
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
  }, [hash, password, onboardingType, resetGuardianProbe]);

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
          guardianProbe={guardianProbeState}
          confirmCreating={sidePanelHandoff && confirmPhase === 'creating'}
          onBiometricChange={setUseBiometric}
          onAction={onAction}
        />
      </div>
    </AwaitFonts>
  );
};

export default Welcome;
