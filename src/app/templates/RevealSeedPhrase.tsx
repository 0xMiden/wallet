import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { AnimatedCopyIcon } from 'components/ui/AnimatedCopyIcon';
import { CopyLabel } from 'components/ui/CopyLabel';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SeedPhraseGrid, SeedPhrasePlaceholder, SeedPhrasePrivacyHero } from 'components/ui/SeedPhraseGrid';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { COPY_FEEDBACK_MS } from 'lib/animation/copy';
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
  const { fieldRef, copy, copied } = useCopyToClipboard(COPY_FEEDBACK_MS);
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
    // An exited instance must never rest on the empty auth branch (a reused layer
    // showed it until Back, #1122).
    setStep('warning');
    setShowPasswordDrawer(false);
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
    } catch (hardwareError) {
      try {
        return !(await Vault.hasPasswordProtector());
      } catch (passwordError) {
        // Carry both. The log is the only evidence for this state, and a bare rethrow
        // could only ever name the complement's failure.
        throw new Error('both protector reads failed', { cause: { hardwareError, passwordError } });
      }
    }
  }, []);

  // One runner for both entry points, with a monotonic token guarding every write.
  // The token is NOT redundant: the deadline below releases the button without settling
  // the read, so a user can start a second probe while the first is still outstanding -
  // an overlap that could not happen before that change. The token is what makes the
  // first probe's late settle a no-op instead of a write from a superseded run.
  const runProbe = useCallback(() => {
    const generation = (probeGeneration.current += 1);
    const isCurrent = () => generation === probeGeneration.current;
    // At most one line per run. The deadline and a rejection can both land for the same
    // run - a read that outlives the bound and then fails - and two lines for one banner
    // would over-count probes in a report.
    let logged = false;
    const raiseBanner = (message: string) => {
      if (!isCurrent()) return;
      if (!logged) {
        logged = true;
        console.warn(`[RevealSeedPhrase] ${message}`);
      }
      setProbeError('couldNotCheckUnlockMethod');
      setProbing(false);
    };

    setProbing(true);
    clearTimeout(probeTimer.current);
    // Held in a LOCAL as well as the ref, and the local is what `.finally` clears. The
    // ref alone was wrong: a superseded probe settles late by design here, and its
    // `.finally` would then clear whatever handle the ref holds - which after a Retry is
    // the LIVE probe's deadline. That left the second probe unbounded and put the page
    // back in the dead end this whole mechanism exists to prevent. The ref stays for the
    // unmount cleanup and the pre-arm clear, both of which do want the newest handle.
    // A WAIT, not a failure. This fires on any read slower than the bound, and such a
    // read is adopted below - so calling it a failure made the common mobile case, a slow
    // bridge read that succeeds, report an error that never happened.
    const timer = setTimeout(
      () => raiseBanner(`protector probe still waiting after ${PROBE_TIMEOUT_MS}ms`),
      PROBE_TIMEOUT_MS
    );
    probeTimer.current = timer;

    probe()
      .then(hasHw => {
        if (!isCurrent()) return;
        // Withdraw the wait, so "slow then answered" is separable from "never answered".
        if (logged) console.warn('[RevealSeedPhrase] protector probe answered after the wait');
        setProbeError(null);
        setHasHardwareProtector(hasHw);
      })
      .catch(err => raiseBanner(`protector probe failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        clearTimeout(timer);
        if (isCurrent()) setProbing(false);
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
      const generation = secretGeneration.current;
      try {
        const mnemonic = await revealMnemonic(data.password);
        if (generation !== secretGeneration.current) return;
        setSecret(mnemonic);
        setShowPasswordDrawer(false);
      } catch (err: any) {
        await new Promise(res => setTimeout(res, 300));
        // Checked after the delay, as RevealSecret does: leave() bumps the generation, and
        // the user can leave while this await runs, so a guard above it protects nothing.
        if (generation !== secretGeneration.current) return;
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

  // Passcode / password drawer (for non-hardware wallets). Mobile vaults are protected
  // by the 6-digit onboarding passcode, so they get the numpad; extension/desktop use a
  // typed password.
  const usePasscodeEntry = isMobile();

  // A sibling of the 'warning' and 'auth' branches below, not a child of either: closing
  // the drawer (X, scrim, Escape, drag-release) runs leave(), which resets step to
  // 'warning' in the same batch (#1122). Nested inside the 'auth' branch, that reset
  // unmounted the Drawer before vaul's close animation could run. Kept at the same keyed
  // slot in both branches, it survives the step change and closes through `open`; a closed
  // Drawer is inert, so it is rendered unconditionally.
  const passwordDrawer = (
    <Drawer
      key="password-drawer"
      open={showPasswordDrawer}
      onOpenChange={open => !open && leave()}
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
            <TextField
              {...register('password', { required: t('required') })}
              label={t('password')}
              id="reveal-seed-password"
              type="password"
              placeholder="********"
              error={errors.password?.message}
              errorTestId="error-caption"
              containerClassName="mb-4"
              onChange={e => {
                register('password').onChange(e);
                clearErrors();
              }}
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
  );

  if (seedStatus && seedStatus !== 'stored')
    return (
      // The same page the verify flow draws for this state, on the same frame.
      <SubPageLayout
        title={t('recoveryPhrase')}
        onBack={leave}
        data-testid="reveal-seed-state"
        footer={<Button className="flex-1 max-w-none" title={t('close')} onClick={leave} />}
      >
        {/* Three distinct states, not two: a removal still to finish, one that
            finished, and a wallet imported from a key that never had a phrase
            here at all. Telling that last user their seed was removed is false.
            VerifySeedPhraseFlow carries the identical mapping. */}
        <SubPageSection description={<p role="status">{t(SEED_STATE_NOTICE[seedStatus])}</p>} />
      </SubPageLayout>
    );

  // Each branch keys its own frame so React remounts its header at a step change rather than
  // reconciling one instance in place - PageHeader focuses the title from a mount
  // effect, so without a remount the announcement never fires and the h1 keeps no
  // tabIndex. Keyed per BRANCH, not on `step`: three of the four run with
  // step === 'reveal'. The auth branch passes no `focusTitleOnMount` of its own, but gets
  // it anyway - Settings (Settings.tsx:516,527) provides `true` for this route via
  // SubPageHeaderProvider, and SubPageLayout falls back to that context value when a page
  // doesn't set the prop itself. A pending or failed submit stays on this branch (#1122);
  // a successful one leaves it for the words branch.
  if (step === 'warning') {
    return (
      <>
        <SubPageLayout
          key="warning"
          title={t('recoveryPhrase')}
          onBack={leave}
          focusTitleOnMount
          data-testid="reveal-seed-warning"
          footer={
            <>
              <Button
                className="flex-1 max-w-none"
                variant={ButtonVariant.Secondary}
                title={t('close')}
                onClick={leave}
              />
              <Button
                className="flex-1 max-w-none"
                variant={ButtonVariant.Primary}
                title={t('view')}
                onClick={handleView}
                disabled={hasHardwareProtector === null || isSubmitting}
                isLoading={isSubmitting}
              />
            </>
          }
        >
          <SubPageSection footnote={t('pleaseWriteDownRecoveryPhrase')}>
            <SeedPhrasePlaceholder />
          </SubPageSection>

          {probeError && (
            <div>
              <Notice tone="negative" role="alert" title={t('error')} data-testid="reveal-seed-probe-error">
                {t(probeError)}
              </Notice>
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

          <SeedPhrasePrivacyHero className="mt-auto pt-4" />
        </SubPageLayout>
        {passwordDrawer}
      </>
    );
  }

  // Revealed view
  if (secret && words.length > 0) {
    return (
      <SubPageLayout
        key="words"
        title={t('recoveryPhrase')}
        onBack={handleHide}
        focusTitleOnMount
        data-testid="reveal-seed-review"
        footer={
          <Button
            className="flex-1 max-w-none"
            variant={ButtonVariant.Primary}
            title={t('hideRecoveryPhrase')}
            onClick={handleHide}
          />
        }
      >
        {isGuardReady && (
          <SubPageSection className="gap-3">
            {/* Hidden field for copy */}
            <input ref={fieldRef} value={secret || ''} readOnly className="sr-only" tabIndex={-1} />

            <SeedPhraseGrid words={words} />

            {/* Copy is the shared Pill, like every other copy action in the wallet. */}
            <Pill
              className="self-start"
              icon={<AnimatedCopyIcon copied={copied} className="h-full w-full" />}
              onClick={copy}
              data-testid="reveal-seed-copy"
            >
              <CopyLabel copied={copied} copiedLabel={t('copied')}>
                {t('copyToClipboard')}
              </CopyLabel>
            </Pill>
          </SubPageSection>
        )}
      </SubPageLayout>
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
      <SubPageLayout
        key="error"
        title={t('recoveryPhrase')}
        onBack={leave}
        focusTitleOnMount
        data-testid="reveal-seed-error"
        footer={
          <>
            <Button
              className="flex-1 max-w-none"
              variant={ButtonVariant.Secondary}
              title={t('close')}
              onClick={leave}
            />
            <Button
              className="flex-1 max-w-none"
              variant={ButtonVariant.Primary}
              title={t('retry')}
              onClick={handleView}
              disabled={isSubmitting}
              isLoading={isSubmitting}
            />
          </>
        }
      >
        <Notice tone="negative" role="alert" title={t('error')}>
          {authError}
        </Notice>
      </SubPageLayout>
    );
  }

  return (
    <>
      <SubPageLayout key="auth" title={t('recoveryPhrase')} onBack={leave} data-testid="reveal-seed-auth" />
      {passwordDrawer}
    </>
  );
};

export default RevealSeedPhrase;
