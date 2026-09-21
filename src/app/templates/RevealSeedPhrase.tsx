import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext, useSecretState } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

import { SEED_STATE_NOTICE } from './seed-state-notice';

type FormData = {
  password: string;
};

// The page opens on the privacy warning; the auth gate and the words come only after View.
type Step = 'warning' | 'reveal';

// The protector probe reads platform storage, which can hang rather than fail. The
// bound only has to be shorter than a user's patience: its whole job is to convert a
// hang into the retryable error path.
const PROBE_TIMEOUT_MS = 5_000;

const RevealSeedPhrase: FC = () => {
  const { t } = useTranslation();
  const { revealMnemonic } = useMidenContext();
  const secretGeneration = useRef(0);
  const seedStatus = useWalletStore(s => s.seedPhraseStatus);
  useEffect(
    () => () => {
      secretGeneration.current += 1;
    },
    [seedStatus]
  );
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const [secret, setSecret] = useSecretState();
  const [step, setStep] = useState<Step>('warning');
  // Every exit from this page goes through `leave`, never `goBack()` directly.
  // Several paths want out at once — a failed biometric reveal's catch, then the
  // auto-close effect once `finally` clears isSubmitting; Hide and the drawer's
  // close, which also trip that effect — and `history.go(-1)` settles on a later
  // task, so each call popped another page (Settings too). The hook fires once
  // per location, and routes to the Settings root when opened cold.
  const popPage = useBackWithFallback('/settings');
  // Leaving must INVALIDATE an in-flight reveal, not merely navigate. Close and the
  // back arrow stay live while the biometric prompt is up, and `history.go(-1)`
  // settles on a later task, so a reveal that resolves in between would otherwise
  // store the mnemonic and swap the rendered branch to the word grid on a page the
  // user has already dismissed. Bumping the generation gives that in-flight promise
  // the same mismatch unmount already produces. Wrapped at the binding rather than
  // at each call site: there are seven, and a list is one edit away from being six.
  const leave = useCallback(() => {
    secretGeneration.current += 1;
    setSecret(null);
    popPage();
  }, [popPage, setSecret]);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [showPasswordDrawer, setShowPasswordDrawer] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // Set only when BOTH protector reads fail, which means storage itself is
  // unavailable rather than that the wallet has no credential - a wallet with no
  // credential resolves both reads to false and never lands here. It therefore has
  // its own surface on the warning step with a Retry, because the failure is
  // transient and the mount probe runs once.
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const probeGeneration = useRef(0);
  const probeTimer = useRef<ReturnType<typeof setTimeout>>();

  // Block screenshots/recordings while the phrase is revealed (#417). The
  // phrase is only rendered once the guard reports the screen is protected.
  const isGuardReady = useScreenshotGuard(secret !== null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setError,
    clearErrors
  } = useForm<FormData>();

  const passwordValue = watch('password');

  useEffect(() => {
    if (seedStatus && seedStatus !== 'stored') setSecret(null);
  }, [seedStatus, setSecret]);

  // Detect the auth type, so View knows which gate to open.
  //
  // A REJECTION MUST NOT BE READ AS "no hardware". Both protectors are a `getPlain`
  // read of their own key, so a failure of the hardware read says nothing about the
  // password one - and answering `false` sends a hardware-only wallet into
  // `unlockWithPassword`, which finds no stored password key and throws a fixed
  // English string telling the user to use the biometrics this page has just stopped
  // offering. So resolve the unknown with the complement instead of guessing it:
  // a password credential means the password gate is genuinely right, and its absence
  // means hardware, which then either works or fails loudly and correctly.
  // Only a failure of BOTH reads is unresolvable, and that is storage being
  // unavailable - see `probeError`. Off desktop and mobile `hasHardwareProtector`
  // returns false without touching storage, so none of this runs there.
  const probe = useCallback(async () => {
    try {
      return await Vault.hasHardwareProtector();
    } catch {
      return !(await Vault.hasPasswordProtector());
    }
  }, []);

  // One runner for both entry points. The token is defence in depth, not the active
  // guard: what actually stops two probes overlapping today is the Retry being
  // `disabled` while `probing` (and View likewise until the first settles), so the
  // out-of-order case is unreachable through the UI and has no test. It stays because
  // the invariant should not depend on a button's disabled prop - drop that and a
  // stale rejection would set the banner back over an already-enabled View. The
  // reveal path guards its own settles the same way with `secretGeneration`.
  //
  // The error is cleared when a probe SETTLES, never when one starts. Clearing at the
  // start unmounted the very block the Retry button lives in, so the affordance
  // deleted itself on click - and if the read hangs rather than rejects, nothing
  // would bring it back.
  // Stores the message KEY, not the message: `t` is a fresh identity on every render
  // under the app's i18n provider, so depending on it here churns this callback and
  // the effect below re-runs forever. Translated at the render site instead.
  // The deadline SURFACES a retryable banner; it does not abandon the read. Truncating
  // would be worse than the hang it guards: these reads are a Capacitor bridge round
  // trip on mobile, delivered into a WebView the OS suspends while backgrounded - and
  // this page's whole message is "view this somewhere private", which invites the user
  // to walk off and come back. An answer that arrives late is still the answer, so a
  // settle that is still current adopts it and clears the banner. The token is what
  // makes that safe; it is also why a stray timer firing after unmount is a no-op.
  const runProbe = useCallback(() => {
    const generation = (probeGeneration.current += 1);
    setProbing(true);
    clearTimeout(probeTimer.current);
    probeTimer.current = setTimeout(() => {
      if (generation !== probeGeneration.current) return;
      setProbeError('couldNotCheckUnlockMethod');
      setProbing(false);
    }, PROBE_TIMEOUT_MS);
    probe()
      .then(hasHw => {
        if (generation !== probeGeneration.current) return;
        setProbeError(null);
        setHasHardwareProtector(hasHw);
      })
      .catch(err => {
        if (generation !== probeGeneration.current) return;
        // Logged, not swallowed: three causes reach this banner - the hardware read
        // failing, the complement failing, and the deadline - and the user-facing
        // recovery is identical, so only a log can tell them apart in a report.
        console.warn('[RevealSeedPhrase] protector probe failed:', err);
        setProbeError('couldNotCheckUnlockMethod');
      })
      .finally(() => {
        clearTimeout(probeTimer.current);
        if (generation === probeGeneration.current) setProbing(false);
      });
  }, [probe]);

  useEffect(() => {
    if (seedStatus && seedStatus !== 'stored') return;
    runProbe();
    // Bump on the way out, the same way `secretGeneration` is: round 2 replaced this
    // effect's `cancelled` flag with the token and then never invalidated on unmount,
    // so an in-flight probe could still write. Harmless under React 18, but the
    // asymmetry with its sibling is the kind that bites later.
    return () => {
      probeGeneration.current += 1;
      // The generation bump invalidates the WRITE; this invalidates the TIMER. Round 3
      // added the first and not the second, which left a live handle behind on exactly
      // the hanging read the bound exists for.
      clearTimeout(probeTimer.current);
    };
  }, [runProbe]); // eslint-disable-line react-hooks/exhaustive-deps

  // No haptic here: Button fires one on every click.
  const handleView = useCallback(() => {
    if (hasHardwareProtector === null || isSubmitting) return;
    if (!hasHardwareProtector) {
      // Password-backed: the page moves on to the password drawer.
      setStep('reveal');
      setShowPasswordDrawer(true);
      return;
    }
    // Hardware-backed: the biometric prompt runs over the warning, which stays
    // on screen (View spinning) until the words or the error are ready.
    const generation = secretGeneration.current;
    setIsSubmitting(true);
    revealMnemonic(undefined)
      .then(mnemonic => {
        if (generation !== secretGeneration.current) return;
        // Clear on success, not on Retry: a retry that leaves this set would be
        // caught by the auto-close gate below after the 20s auto-hide and drop the
        // user back onto a stale error instead of letting the page close.
        setAuthError(null);
        setSecret(mnemonic);
        setStep('reveal');
      })
      .catch((err: unknown) => {
        // Same generation guard the success branch and the password path
        // (below) already take: a rejection from a superseded request must
        // not navigate away from the view that replaced it.
        if (generation !== secretGeneration.current) return;
        setAuthError(err instanceof Error ? err.message : String(err));
        setStep('reveal');
      })
      .finally(() => setIsSubmitting(false));
  }, [hasHardwareProtector, isSubmitting, revealMnemonic, setSecret]);

  useEffect(() => {
    return () => setSecret(null);
  }, [setSecret]);

  // When secret is cleared (auto-hide after 20s), go back. Not on the warning,
  // where no secret has been asked for yet.
  useEffect(() => {
    // `authError === null` is load-bearing, not defensive: the catch above leaves
    // exactly this state once `finally` clears isSubmitting, so without it this
    // effect simply becomes the caller that navigates away from the error view and
    // the user is bounced with no explanation - the same outcome by another route.
    if (
      step === 'reveal' &&
      authError === null &&
      secret === null &&
      hasHardwareProtector !== null &&
      !isSubmitting &&
      !showPasswordDrawer
    ) {
      leave();
    }
  }, [step, authError, secret, hasHardwareProtector, isSubmitting, showPasswordDrawer, leave]);

  const words = secret ? secret.split(' ') : [];

  const onPasswordSubmit = useCallback(
    async (data: FormData) => {
      if (isSubmitting) return;
      setIsSubmitting(true);
      clearErrors();
      setAuthError(null);
      try {
        const generation = secretGeneration.current;
        const mnemonic = await revealMnemonic(data.password);
        if (generation !== secretGeneration.current) return;
        setSecret(mnemonic);
        setShowPasswordDrawer(false);
      } catch (err: any) {
        await new Promise(res => setTimeout(res, 300));
        setError('password', { type: 'submit-error', message: err.message });
      } finally {
        setIsSubmitting(false);
      }
    },
    [isSubmitting, clearErrors, revealMnemonic, setSecret, setError]
  );

  const handleHide = useCallback(() => {
    hapticLight();
    setSecret(null);
    leave();
  }, [setSecret, leave]);

  const handlePasswordDrawerClose = useCallback(() => {
    setShowPasswordDrawer(false);
    leave();
  }, [leave]);

  if (seedStatus && seedStatus !== 'stored')
    return (
      <p role="status" className="p-4">
        {/* Three distinct states, not two: a removal still to finish, one that
            finished, and a wallet imported from a key that never had a phrase
            here at all. Telling that last user their seed was removed is false.
            VerifySeedPhraseFlow carries the identical mapping. */}
        {t(SEED_STATE_NOTICE[seedStatus])}
      </p>
    );

  // Each branch keys its own header so React remounts it at a step change rather than
  // reconciling one instance in place - PageHeader focuses the title from a mount
  // effect, so without a remount the announcement never fires and the h1 keeps no
  // tabIndex. Keyed per BRANCH, not on `step`: three of the four run with
  // step === 'reveal'. The drawer branch is deliberately not focused - its sheet is a
  // portal that owns focus, and that branch remounts on every failed submit.
  if (step === 'warning') {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <PageHeader key="warning" className="px-4" title={t('recoveryPhrase')} onBack={leave} focusTitleOnMount />

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col px-4 pt-2">
          {/* A blurred stand-in for the word grid: the shape of the phrase, none of its words. */}
          <div aria-hidden="true" className="bg-fill rounded-2xl px-6 py-8">
            <div className="grid grid-cols-2 gap-x-6 gap-y-5">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="h-1.5 w-full rounded-full bg-fill-pressed" />
              ))}
            </div>
          </div>

          <p className="mt-4 text-center font-sans text-base text-muted">{t('pleaseWriteDownRecoveryPhrase')}</p>

          <div className="mt-auto flex flex-col items-center pt-8 text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-accent-primary">
              <Icon name={IconName.EyeOff} size="md" fill="white" />
            </div>
            <h2 className="mb-1 font-heading text-xl font-extrabold text-ink">{t('viewThisInPrivatePlace')}</h2>
            <p className="font-sans text-base text-muted">{t('anyoneWithRecoveryPhrase')}</p>
          </div>
        </div>

        {probeError && (
          <div className="px-4 pt-4">
            <Alert type="error" title={t('error')} description={t(probeError)} className="rounded-lg text-ink" />
            <Button
              className="mt-3"
              variant={ButtonVariant.Secondary}
              title={t('retry')}
              onClick={runProbe}
              disabled={probing}
              isLoading={probing}
            />
          </div>
        )}

        <div className="flex shrink-0 gap-2.5 px-4 pt-6 pb-4">
          <Button className="flex-1" variant={ButtonVariant.Secondary} title={t('close')} onClick={leave} />
          <Button
            className="flex-1"
            variant={ButtonVariant.Primary}
            title={t('view')}
            onClick={handleView}
            disabled={hasHardwareProtector === null || isSubmitting}
            isLoading={isSubmitting}
          />
        </div>
      </div>
    );
  }

  // The error view is exempt: a Retry sets isSubmitting again, and blanking here
  // would take the Alert and the Retry button off screen for the whole prompt.
  if (!authError && (hasHardwareProtector === null || (!secret && isSubmitting))) {
    return null;
  }

  // Revealed view
  if (secret && words.length > 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg text-ink">
        <PageHeader key="words" className="px-4" title={t('recoveryPhrase')} onBack={handleHide} focusTitleOnMount />

        <div className="flex-1 flex flex-col px-4 pt-4">
          {isGuardReady && (
            <>
              {/* Hidden field for copy */}
              <input ref={fieldRef} value={secret || ''} readOnly className="sr-only" tabIndex={-1} />

              {/* Copy button */}
              <div className="flex justify-center mb-4">
                <button
                  type="button"
                  onClick={() => {
                    hapticLight();
                    copy();
                  }}
                  className={classNames(
                    'flex items-center gap-1.5 px-4 py-1.5',
                    'border border-border-card rounded-2xl',
                    'text-sm font-medium text-ink',
                    'hover:opacity-80 cursor-pointer'
                  )}
                >
                  <Icon name={copied ? IconName.CheckboxCircleFill : IconName.FileCopy} size="xs" />
                  {t(copied ? 'copied' : 'copyToClipboard')}
                </button>
              </div>

              {/* Word grid */}
              <div className="p-6 bg-white rounded-10">
                <div className="grid grid-cols-4 gap-x-4 gap-y-6">
                  {words.map((word, idx) => (
                    <span key={idx} className="text-base font-medium text-ink text-center">
                      {word.charAt(0).toUpperCase() + word.slice(1)}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Hide button */}
        <div className="px-4 pb-8 pt-4 mt-auto">
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Primary}
            title={t('hideRecoveryPhrase')}
            onClick={handleHide}
          />
        </div>
      </div>
    );
  }

  // Auth error fallback. It has to offer a way out AND a way on, because nothing else
  // leaves this branch any more: the catch no longer navigates, and the auto-close
  // effect above is gated on `authError === null`. The back arrow does work - an
  // earlier note here claimed it was spent by the latch, which cannot happen, since
  // any `leave()` bumps the generation and the catch then returns before setting
  // `authError` at all, so reaching this view proves no `leave()` has run.
  if (authError) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
        <PageHeader key="error" className="px-4" title={t('recoveryPhrase')} onBack={leave} focusTitleOnMount />
        <div className="px-4 pt-4">
          <Alert type="error" title={t('error')} description={authError} className="rounded-lg text-ink" />
        </div>

        <div className="mt-auto flex shrink-0 gap-2.5 px-4 pt-6 pb-4">
          <Button className="flex-1" variant={ButtonVariant.Secondary} title={t('close')} onClick={leave} />
          <Button
            className="flex-1"
            variant={ButtonVariant.Primary}
            title={t('retry')}
            onClick={handleView}
            disabled={isSubmitting}
            isLoading={isSubmitting}
          />
        </div>
      </div>
    );
  }

  // Passcode / password drawer (for non-hardware wallets, shown on mount).
  // Mobile vaults are protected by the 6-digit onboarding passcode, so they
  // get the numpad; extension/desktop use a typed password.
  const usePasscodeEntry = isMobile();

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-app-bg">
      <PageHeader key="auth" className="px-4" title={t('recoveryPhrase')} onBack={leave} />

      <Drawer
        open={showPasswordDrawer}
        onOpenChange={open => !open && handlePasswordDrawerClose()}
        screenKey="reveal-seed"
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t(usePasscodeEntry ? 'enterYourPasscode' : 'password')}</DrawerTitle>
          </DrawerHeader>
          {usePasscodeEntry ? (
            <div className="px-4 pb-6">
              <PasscodeEntry
                onSubmit={code => onPasswordSubmit({ password: code })}
                onChange={() => clearErrors()}
                error={errors.password?.message ?? null}
                isSubmitting={isSubmitting}
              />
            </div>
          ) : (
            <form className="px-4 pb-6" onSubmit={handleSubmit(onPasswordSubmit)}>
              <FormField
                {...register('password', { required: t('required') })}
                label={t('password')}
                id="reveal-seed-password"
                type="password"
                name="password"
                placeholder="********"
                errorCaption={errors.password?.message}
                containerClassName="mb-4"
                onChange={e => {
                  register('password').onChange(e);
                  clearErrors();
                }}
                labelClassName="text-ink"
              />
              <Button
                className="w-full justify-center"
                variant={ButtonVariant.Primary}
                title={t('continue')}
                disabled={isSubmitting || !passwordValue}
                isLoading={isSubmitting}
                onClick={handleSubmit(onPasswordSubmit)}
              />
            </form>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
};

export default RevealSeedPhrase;
