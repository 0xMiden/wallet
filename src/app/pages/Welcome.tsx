import React, { FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { generateMnemonic } from 'bip39';
import wordslist from 'bip39/src/wordlists/english.json';
import { useTranslation } from 'react-i18next';

import AwaitFonts from 'app/a11y/AwaitFonts';
import { formatMnemonic } from 'app/defaults';
import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { canHandoffToSidePanel, postOnboardingRoute } from 'lib/extension/side-panel-handoff';
import type { DecryptedWalletFile } from 'lib/miden/backup-file';
import { useMidenContext } from 'lib/miden/front';
import { parsePrivateKeyPair } from 'lib/miden/guardian/private-key-pair';
import { useGuardianProbe } from 'lib/miden/guardian/use-guardian-probe';
import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isDesktop, isMobile } from 'lib/platform';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { fetchStateFromBackend } from 'lib/store/hooks/useIntercomSync';
import { seedWalletPrompt, WalletPromptType } from 'lib/wallet-prompts';
import { listen, navigate, useLocation } from 'lib/woozie';
import { errorToMessage } from 'screens/onboarding/error-message';
import { OnboardingFlow } from 'screens/onboarding/navigator';
import {
  ImportType,
  NO_GUARDIAN_ID,
  OnboardingAction,
  OnboardingStep,
  OnboardingType,
  WalletType
} from 'screens/onboarding/types';

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

const READY_WAIT_BUDGET_MS = 5_000;
const READY_POLL_INTERVAL_MS = 100;

/**
 * Wait for the wallet state to become Ready after registration.
 * This ensures the state is fully synced before navigation.
 */
async function waitForReadyState(syncFromBackend: (state: any) => void): Promise<boolean> {
  // On the monotonic clock, so a wall-clock correction neither ends the wait early nor stretches it.
  const deadline = monotonicNowMs() + READY_WAIT_BUDGET_MS;
  let attempt = 0;
  console.log('[waitForReadyState] Starting, budgetMs:', READY_WAIT_BUDGET_MS);
  while (monotonicNowMs() < deadline) {
    attempt += 1;
    try {
      console.log('[waitForReadyState] Attempt', attempt);
      // Enforce the deadline here rather than through the read's abort signal: the mobile and
      // desktop intercom adapters ignore that signal, so a wedged read would hold the screen.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      const budgetSpent = new Promise<null>(resolve => {
        budgetTimer = setTimeout(() => resolve(null), deadline - monotonicNowMs());
      });
      const state = await Promise.race([fetchStateFromBackend(), budgetSpent]).finally(() => clearTimeout(budgetTimer));
      if (!state) break;
      console.log('[waitForReadyState] Got state:', { status: state.status, hasAccounts: !!state.accounts?.length });
      syncFromBackend(state);
      if (state.status === WalletStatus.Ready) {
        console.log('[waitForReadyState] State is Ready, done');
        return true;
      }
    } catch (error) {
      console.warn('[waitForReadyState] Failed to fetch state, retrying...', error);
    }
    const remainingMs = deadline - monotonicNowMs();
    if (remainingMs > 0) {
      await new Promise(r => setTimeout(r, Math.min(READY_POLL_INTERVAL_MS, remainingMs)));
    }
  }
  console.warn('[waitForReadyState] Time budget reached, state still not Ready');
  return false;
}

// The registration key must tell two backups apart without ever carrying a
// secret, so it keeps the payload as it is and drops only secretKeyHex; a field
// added to either record later stays in the key by construction.
const fileRegistrationBinding = (payload: DecryptedWalletFile) => ({
  formatVersion: payload.formatVersion ?? null,
  accounts: payload.accounts,
  importedAccounts:
    payload.formatVersion === 2 ? payload.importedAccounts.map(({ secretKeyHex: _secretKeyHex, ...rest }) => rest) : []
});

const Welcome: FC = () => {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const [step, setStep] = useState(OnboardingStep.Welcome);
  const [seedPhrase, setSeedPhrase] = useState<string[] | null>(null);
  // Seed-less Guardian import: the normalized hot:EVM pair. Mutually
  // exclusive with `seedPhrase` — each submit clears the other, so register()
  // and back-navigation can branch on which credential is live.
  const [keyPairPayload, setKeyPairPayload] = useState<string | null>(null);
  const [onboardingType, setOnboardingType] = useState<OnboardingType | null>(null);
  const [importType, setImportType] = useState<ImportType | null>(null);
  const [walletFilePayload, setWalletFilePayload] = useState<DecryptedWalletFile | null>(null);
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
  /**
   * A registration failure to show on the confirmation screen.
   *
   * The same defect #630 fixed for password recovery was never applied to
   * onboarding: every failure that is not Import+Guardian or hardware-only was
   * console.error'd and nothing else, so the screen looked idle and the button
   * looked dead. A wallet that cannot reach a compatible node fails here, and
   * "nothing happened" is indistinguishable from "still working".
   */
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  // Whether a registration has landed for this attempt. Distinct from `registrationError`,
  // which both outcomes set: the throw and the resolved-but-never-Ready path. Only this tells
  // them apart, and only this can say whether a wallet may already exist.
  const [registrationCommitted, setRegistrationCommitted] = useState(false);
  // The registration the backend is building or holds, keyed by the inputs that made it.
  // NewWalletRequest wipes storage before it creates anything, so the same inputs never register
  // twice (a retry joins it), and a failed registration is forgotten because it may already have
  // wiped the wallet.
  const registrationRef = useRef<{ inputs: string; done: Promise<void> } | null>(null);
  // A confirmation attempt (a tap, or the side-panel auto-create) is in flight from its start to its outcome:
  // registration, prompt setup and readiness. While it runs, onboarding stays on Confirmation and ignores actions,
  // as mobile back already does: another attempt could wipe the wallet this one commits, and a committed wallet
  // takes the tab into the app (resolveRootView) whatever the screens show, so nothing may change its inputs.
  const attemptInFlightRef = useRef(false);
  // Advanced by every action onboarding accepts, by every history change the router reports and when this page
  // unmounts. An action that awaits the hardware-security check acts on its answer only while nothing newer happened:
  // otherwise the user has moved on, and may have confirmed inputs the stale answer would overwrite.
  const transitionGenerationRef = useRef(0);
  // Tracks which protection screen the user came through; needed so ChooseGuardian
  // back navigation and the create-password→confirmation routing pick the right
  // origin without colliding with the legacy create flow.
  const [protectionMethod, setProtectionMethod] = useState<'passcode' | 'biometric' | 'password' | null>(null);
  const { importWalletFromClient, registerWallet, registerWalletFromHotKey } = useMidenContext();
  const { trackEvent } = useAnalytics();
  // Guardian auto-detection (issue #418): kicked off in the background the
  // moment a seed phrase is submitted, so it is usually already resolved by the
  // time the user gets through the password/passcode step to the
  // recovery-method screen.
  const guardianProbe = useGuardianProbe();
  const resetGuardianProbe = guardianProbe.reset;
  // Without a credential in memory (e.g. the popup was reopened directly on the
  // recovery-method screen) there is nothing to detect — leave the probe prop
  // undefined so that screen renders its classic manual picker rather than an
  // endless spinner.
  const guardianProbeState = seedPhrase || keyPairPayload ? guardianProbe.state : undefined;
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
      void guardianProbe.start(words).then(result => {
        if (!result) return;
        // Deliberately no endpoint / account id — only shape, so we can tell
        // how often detection actually helps.
        trackEvent('guardian-probe', AnalyticsEventCategory.General, {
          detected: Boolean(result.best),
          matchCount: result.matches.length,
          failureCount: result.failures.length
        });
      });
    },
    [guardianProbe, trackEvent]
  );

  // Same fire-and-forget shape for the seed-less import: probe the operators by
  // the pasted hot key's commitment.
  const startGuardianProbeWithKey = useCallback(
    (payload: string) => {
      const pair = parsePrivateKeyPair(payload);
      if (!pair) return;
      guardianProbe.startWithKey(pair.hotPrivateKey).then(result => {
        if (!result) return;
        trackEvent('guardian-probe', AnalyticsEventCategory.General, {
          method: 'hot-key',
          detected: Boolean(result.best),
          matchCount: result.matches.length,
          failureCount: result.failures.length
        });
      });
    },
    [guardianProbe, trackEvent]
  );

  const register = useCallback(async () => {
    if (password && keyPairPayload) {
      // The pair stays in this onboarding component, never in wallet state.
      const actualPassword = password === '__HARDWARE_ONLY__' ? undefined : password;
      await registerWalletFromHotKey(actualPassword, keyPairPayload, guardianEndpoint);
      return;
    }
    if (password && seedPhrase) {
      const seedPhraseFormatted = formatMnemonic(seedPhrase.join(' '));
      // For hardware-only wallets, pass undefined as password
      const actualPassword = password === '__HARDWARE_ONLY__' ? undefined : password;
      const isImport = onboardingType === OnboardingType.Import;
      const inputs = walletFilePayload
        ? JSON.stringify([actualPassword, seedPhraseFormatted, fileRegistrationBinding(walletFilePayload)])
        : JSON.stringify([walletType, actualPassword, seedPhraseFormatted, isImport, guardianEndpoint]);
      let registration = registrationRef.current;
      if (!registration || registration.inputs !== inputs) {
        const next = {
          inputs,
          done: (async () => {
            if (walletFilePayload) {
              await importWalletFromClient(
                actualPassword,
                seedPhraseFormatted,
                walletFilePayload.accounts,
                walletFilePayload.formatVersion,
                walletFilePayload.formatVersion === 2 ? walletFilePayload.importedAccounts : undefined
              );
            } else {
              await registerWallet(walletType, actualPassword, seedPhraseFormatted, isImport, guardianEndpoint);
            }
          })()
        };
        next.done.catch(() => {
          if (registrationRef.current === next) registrationRef.current = null;
        });
        registrationRef.current = next;
        registration = next;
      }
      await registration.done;
      // From here a wallet may exist, whatever happens next: the escape back to the file picker is
      // withdrawn, because it would show an empty picker implying the restore was abandoned while
      // the databases are written and the registration has landed.
      setRegistrationCommitted(true);
      if (!walletFilePayload && onboardingType === OnboardingType.Create) {
        // Idempotent and intentionally retried separately from wallet creation.
        await seedWalletPrompt(WalletPromptType.VerifySeedPhrase);
      }
    } else {
      throw new Error('Missing password or seed phrase');
    }
  }, [
    password,
    seedPhrase,
    walletFilePayload,
    keyPairPayload,
    registerWallet,
    importWalletFromClient,
    registerWalletFromHotKey,
    onboardingType,
    walletType,
    guardianEndpoint
  ]);

  // Side panel handoff: kick off wallet creation as soon as the confirmation
  // screen is reached (the screen shows a spinner), so the wallet is Ready by
  // the time the user clicks "Open wallet". Scoped to the Create flow only:
  //   - the hardware/biometric path must prompt biometrics on an explicit tap,
  //     not on arrival;
  //   - import flows are excluded because guardian lookup can fail and needs
  //     the in-tab retry UI — imports keep the classic in-tab flow.
  // The `confirmPhase !== 'idle'` guard makes this fire at most once even though
  // `register`/`trackEvent` are (correctly) in the dependency array.
  useEffect(() => {
    if (!sidePanelHandoff) return;
    if (step !== OnboardingStep.Confirmation) return;
    if (confirmPhase !== 'idle') return;
    if (onboardingType !== OnboardingType.Create) return;
    if (!password || !seedPhrase || password === '__HARDWARE_ONLY__') return;
    // A tap can start an attempt between this screen's commit and this effect: leave the visit to that attempt,
    // which is the classic tap flow, rather than start a second one.
    if (attemptInFlightRef.current) {
      setConfirmPhase('failed');
      return;
    }

    setConfirmPhase('creating');
    attemptInFlightRef.current = true;
    setIsLoading(true);
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
        // button reverts to running register() in-tab on the next tap. Say so —
        // the spinner stops either way, and without this the screen goes quiet
        // and the user has no reason to believe a second tap would help.
        console.error('[Welcome] Side panel handoff auto-create failed:', error);
        setRegistrationError(errorToMessage(error) ?? t('smthWentWrong'));
        setConfirmPhase('failed');
      } finally {
        attemptInFlightRef.current = false;
        setIsLoading(false);
      }
    })();
  }, [sidePanelHandoff, step, confirmPhase, onboardingType, password, seedPhrase, register, trackEvent, t]);

  const onAction = async (action: OnboardingAction) => {
    // A running confirmation attempt holds onboarding where it is (see attemptInFlightRef).
    if (attemptInFlightRef.current) return;
    transitionGenerationRef.current += 1;
    const generation = transitionGenerationRef.current;
    let eventCategory = AnalyticsEventCategory.ButtonPress;
    let eventProperties = {};

    const startCreateFlow = () => {
      setImportType(null);
      setWalletFilePayload(null);
      setOnboardingType(OnboardingType.Create);
      // Biometric is unavailable on the extension/desktop, so the
      // choose-protection screen has only one real option — skip it and go
      // straight to the full-password step.
      navigate(protectionStepRoute());
    };
    const startImportFlow = () => {
      setOnboardingType(OnboardingType.Import);
      navigate('/#select-import-type');
    };

    switch (action.id) {
      case 'network-notice-acknowledge':
        if (onboardingType === OnboardingType.Import) {
          startImportFlow();
        } else {
          startCreateFlow();
        }
        break;
      case 'choose-protection':
        // On a test network the chosen flow waits behind the network notice
        // (#875); acknowledging the notice starts it.
        if (getTestNetworkNameKey()) {
          setOnboardingType(OnboardingType.Create);
          navigate('/#network-notice');
        } else {
          startCreateFlow();
        }
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
          // The passcode protects the restored vault; the backup or seed remains unchanged.
          setPassword(action.payload);
          setProtectionMethod('passcode');
          navigate(importType === ImportType.WalletFile ? '/#confirmation' : '/#import-select-recovery-method');
          break;
        }
        setSeedPhrase(generateMnemonic(128).split(' '));
        setOnboardingType(OnboardingType.Create);
        setPassword(action.payload);
        setProtectionMethod('passcode');
        navigate('/#choose-guardian');
        break;
      case 'choose-guardian-submit':
        if (action.payload.guardianId === NO_GUARDIAN_ID) {
          // No guardian: private single-key (OffChain) account. Leave the
          // endpoint unbound so register() threads undefined; the non-guardian
          // spawn branch ignores it anyway.
          setGuardianEndpoint(undefined);
          setWalletType(WalletType.OffChain);
        } else {
          setGuardianEndpoint(action.payload.guardianEndpoint);
          setWalletType(WalletType.Guardian);
        }
        if (password) {
          // Passcode flow already established a password — go straight to confirmation.
          navigate('/#confirmation');
        } else {
          // Biometric flow — defer the hardware vs password decision until now.
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (transitionGenerationRef.current !== generation) break;
          if (hardwareAvailable) {
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            navigate('/#create-password');
          }
        }
        break;
      case 'select-import-type':
        setImportType(null);
        setWalletFilePayload(null);
        if (getTestNetworkNameKey()) {
          setOnboardingType(OnboardingType.Import);
          navigate('/#network-notice');
        } else {
          startImportFlow();
        }
        break;
      case 'import-from-seed':
        setImportType(ImportType.SeedPhrase);
        setWalletFilePayload(null);
        navigate('/#import-from-seed');
        break;
      case 'import-with-key':
        navigate('/#import-from-key');
        break;
      case 'import-hot-key-submit':
        setKeyPairPayload(action.payload);
        // Mutually exclusive with the seed credential (see the state comment).
        setSeedPhrase(null);
        startGuardianProbeWithKey(action.payload);
        // Same hardware/password branch as import-seed-phrase-submit.
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (hardwareAvailable) {
            setPassword('__HARDWARE_ONLY__');
            navigate('/#import-select-recovery-method');
          } else {
            navigate(isMobile() ? '/#setup-passcode' : '/#create-password');
          }
        }
        break;
      case 'import-from-file':
        setImportType(ImportType.WalletFile);
        navigate('/#import-from-file');
        break;
      case 'import-wallet-file-submit':
        setGuardianLookupError(false);
        setOnboardingType(OnboardingType.Import);
        setImportType(ImportType.WalletFile);
        setWalletFilePayload(action.payload);
        setSeedPhrase(action.payload.seedPhrase.split(' '));
        setKeyPairPayload(null);
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (transitionGenerationRef.current !== generation) break;
          if (hardwareAvailable) {
            setPassword('__HARDWARE_ONLY__');
            navigate('/#confirmation');
          } else {
            navigate(isMobile() ? '/#setup-passcode' : '/#create-password');
          }
        }
        break;
      case 'import-seed-phrase-submit':
        // A new seed retires a Guardian lookup failure raised for the previous one.
        setGuardianLookupError(false);
        setImportType(ImportType.SeedPhrase);
        setWalletFilePayload(null);
        setSeedPhrase(action.payload.split(' '));
        setKeyPairPayload(null);
        // Start guardian auto-detection here rather than on the recovery-method
        // screen: it then runs behind the password/passcode step and is usually
        // already resolved when that screen mounts.
        startGuardianProbe(action.payload.split(' '));
        // Check if hardware security is available - if so, skip password step
        {
          const hardwareAvailable = await checkHardwareSecurityAvailable();
          if (transitionGenerationRef.current !== generation) break;
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
        eventCategory = AnalyticsEventCategory.FormSubmit;
        if (onboardingType === OnboardingType.Create && !isMobile()) {
          // Extension/desktop create flow: the password screen replaces
          // passcode setup and runs before guardian selection — generate the
          // mnemonic here, exactly like setup-passcode-submit does.
          setSeedPhrase(generateMnemonic(128).split(' '));
          setProtectionMethod('password');
          navigate('/#choose-guardian');
        } else if (onboardingType === OnboardingType.Import) {
          navigate(importType === ImportType.WalletFile ? '/#confirmation' : '/#import-select-recovery-method');
        } else {
          navigate('/#confirmation');
        }
        break;
      case 'retry-guardian-probe':
        if (keyPairPayload) startGuardianProbeWithKey(keyPairPayload);
        else if (seedPhrase) startGuardianProbe(seedPhrase);
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
        attemptInFlightRef.current = true;
        setIsLoading(true);
        try {
          setBiometricError(null);
          setRegistrationError(null);
          await register();
          // Wait for state to be synced before navigating
          // This fixes a race condition where navigation happens before state is Ready
          const becameReady = await waitForReadyState(syncFromBackend);
          if (!becameReady) {
            // Registration resolved but the wallet never reported Ready. Do NOT
            // navigate: `resolveRootView` sends a not-ready root back to
            // Welcome, so the user lands at the start of onboarding with no
            // idea their wallet may already exist. Stay put and say so.
            setRegistrationError(t('walletSetupDidNotComplete'));
            break;
          }
          eventCategory = AnalyticsEventCategory.FormSubmit;
          // Recovery/import completes in this classic handler (the Create flow
          // takes the auto-create effect above). Hand off to the side panel just
          // like Create does, instead of always entering in-tab (#428).
          navigate(postOnboardingRoute());
        } catch (error) {
          console.error('[Welcome] Confirmation flow failed:', error);
          // Surface it for every path; most used to show nothing. The Guardian import
          // branch below hands off to the recovery-method screen, which retires this
          // message on arrival, and the hardware-only branch adds its attempt count.
          setRegistrationError(errorToMessage(error) ?? t('smthWentWrong'));
          if (
            onboardingType === OnboardingType.Import &&
            importType !== ImportType.WalletFile &&
            walletType === WalletType.Guardian
          ) {
            setGuardianLookupError(true);
            navigate('/#import-select-recovery-method');
          } else if (password === '__HARDWARE_ONLY__') {
            // Track biometric attempts for hardware-only mode
            const newAttempts = biometricAttempts + 1;
            setBiometricAttempts(newAttempts);
            setBiometricError(error instanceof Error ? error.message : 'Biometric authentication failed');
          }
        } finally {
          attemptInFlightRef.current = false;
          setIsLoading(false);
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
          step === OnboardingStep.NetworkNotice ||
          step === OnboardingStep.SelectImportType ||
          step === OnboardingStep.SelectWalletType ||
          step === OnboardingStep.ChooseProtection
        ) {
          navigate('/');
        } else if (step === OnboardingStep.SetupPasscode || step === OnboardingStep.SetupBiometric) {
          if (onboardingType === OnboardingType.Import) {
            navigate(
              importType === ImportType.WalletFile
                ? '/#import-from-file'
                : keyPairPayload
                  ? '/#import-from-key'
                  : '/#import-from-seed'
            );
          } else {
            // The choose-protection screen is skipped when biometric is
            // unavailable, so backing out of passcode setup returns to Welcome.
            navigate(biometricProtectionSupported() ? '/#choose-protection' : '/');
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
            navigate(isMobile() ? '/#choose-guardian' : '/');
          } else {
            navigate(
              importType === ImportType.WalletFile
                ? '/#import-from-file'
                : keyPairPayload
                  ? '/#import-from-key'
                  : '/#import-from-seed'
            );
          }
        } else if (step === OnboardingStep.ImportSelectRecoveryMethod) {
          if (password === '__HARDWARE_ONLY__') {
            navigate(keyPairPayload ? '/#import-from-key' : '/#import-from-seed');
          } else {
            navigate(isMobile() ? '/#setup-passcode' : '/#create-password');
          }
        } else if (step === OnboardingStep.ImportFromKey) {
          // Key paste is reached FROM seed entry, so back returns there.
          navigate('/#import-from-seed');
        } else if (step === OnboardingStep.ImportFromSeed || step === OnboardingStep.ImportFromFile) {
          // The import-type choice now precedes both, so back goes there rather
          // than out of onboarding entirely.
          navigate('/#select-import-type');
        } else if (step === OnboardingStep.Confirmation && importType === ImportType.WalletFile) {
          // Confirmation is where a rejected file restore lands. Retrying in
          // place is already possible; this is the way out when the file itself
          // is the problem, since the file, not the password, is what the user
          // would change.
          navigate('/#import-from-file');
        }
        break;
      default:
        break;
    }

    trackEvent(action.id, eventCategory, eventProperties);
  };

  // The router reports each history change here as the location changes, before React renders it, so a move
  // supersedes a pending hardware-security check even when it unmounts this page. A layout effect, so that unmounting
  // supersedes it too inside the commit that removes the page, not a scheduler task later.
  useLayoutEffect(() => {
    const transitions = transitionGenerationRef;
    const unlisten = listen(() => {
      transitions.current += 1;
    });
    return () => {
      unlisten();
      transitions.current += 1;
    };
  }, []);

  useEffect(() => {
    // While a confirmation attempt runs, any other hash (browser back or forward, an edited URL) is sent back to
    // Confirmation. The attempt's own navigation is not: its finally ends the attempt before React commits the
    // location that navigation sets, and this effect runs only after a commit.
    if (attemptInFlightRef.current) {
      if (hash !== '#confirmation') navigate('/#confirmation');
      return;
    }
    switch (hash) {
      case '':
        setStep(OnboardingStep.Welcome);
        break;
      case '#network-notice':
        // The chosen flow is in-memory only, so a reload here has nothing to
        // continue with; mainnet has no notice. Either way, restart from Welcome.
        if (onboardingType === null || !getTestNetworkNameKey()) {
          navigate('/');
          break;
        }
        setStep(OnboardingStep.NetworkNotice);
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
      case '#select-import-type':
        setOnboardingType(OnboardingType.Import);
        setImportType(null);
        setWalletFilePayload(null);
        setStep(OnboardingStep.SelectImportType);
        break;
      case '#import-from-seed':
        setOnboardingType(OnboardingType.Import);
        setImportType(ImportType.SeedPhrase);
        setWalletFilePayload(null);
        setStep(OnboardingStep.ImportFromSeed);
        // A pasted key must not survive a switch back to seed entry — the two
        // credentials are mutually exclusive.
        setKeyPairPayload(null);
        // Backing out to seed entry invalidates any detection for the previous
        // phrase — abort it so a stale result can't be shown for a new seed.
        resetGuardianProbe();
        break;
      case '#import-from-key':
        setOnboardingType(OnboardingType.Import);
        setStep(OnboardingStep.ImportFromKey);
        // Same invalidation as seed entry: a detection for the previous
        // credential must not outlive it.
        resetGuardianProbe();
        break;
      case '#import-from-file':
        setOnboardingType(OnboardingType.Import);
        setImportType(ImportType.WalletFile);
        setStep(OnboardingStep.ImportFromFile);
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

  // Leaving the step (the Guardian lookup hand-off, switch-to-password, browser back) retires a failure message,
  // so it cannot greet a later visit.
  useEffect(() => {
    if (step !== OnboardingStep.Confirmation) {
      setRegistrationError(null);
      setRegistrationCommitted(false);
    }
  }, [step]);

  // Confirmation creates the wallet, so there is nothing to step back to, except a file restore the
  // user might want to retry with a different file - and only while no registration has landed. The
  // chevron and the hardware back read the SAME predicate: the hardware path used to consult only
  // `isLoading`, so it stayed open exactly where the chevron was being closed.
  const canLeaveConfirmation =
    step !== OnboardingStep.Confirmation ||
    (importType === ImportType.WalletFile && !isLoading && !registrationCommitted);

  // Handle mobile back button/gesture in onboarding flow
  useMobileBackHandler(() => {
    // On welcome screen, let system handle (minimize on Android)
    if (step === OnboardingStep.Welcome) {
      return false;
    }
    if (!canLeaveConfirmation) {
      return true; // Consume but don't navigate
    }
    // Trigger the onboarding back action
    onAction({ id: 'back' });
    return true;
  }, [step, canLeaveConfirmation, onAction]);

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
          recoveryError={registrationError}
          guardianProbe={guardianProbeState}
          confirmCreating={sidePanelHandoff && confirmPhase === 'creating'}
          importViaKey={Boolean(keyPairPayload)}
          // Confirmation creates the wallet, so there is nothing to step back to, except when a file
          // restore was rejected: back returns to the file choice (see the 'back' action), and never
          // while an attempt is running.
          canGoBack={canLeaveConfirmation}
          onBiometricChange={setUseBiometric}
          onAction={onAction}
        />
      </div>
    </AwaitFonts>
  );
};

export default Welcome;
