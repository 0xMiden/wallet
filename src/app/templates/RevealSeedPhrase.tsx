import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { ProtectorProbeErrorNotice } from 'components/ProtectorProbeErrorNotice';
import { AnimatedCopyIcon } from 'components/ui/AnimatedCopyIcon';
import { CopyLabel } from 'components/ui/CopyLabel';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SeedPhraseGrid, SeedPhrasePlaceholder, SeedPhrasePrivacyHero } from 'components/ui/SeedPhraseGrid';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { useMidenContext, useSecretState } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';

import { SEED_STATE_NOTICE } from './seed-state-notice';

type FormData = {
  password: string;
};

// The page opens on the privacy warning; the auth gate and the words come only after View.
type Step = 'warning' | 'reveal';

// The protector probe reads platform storage, which can hang rather than fail. Past this bound the
// page says it is still checking and how to retry (leave and reopen); the probe itself stays in flight.
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
  const [secret, setSecret] = useSecretState();
  const { copy, copied } = useClipboardCopy(secret ?? '');
  const [step, setStep] = useState<Step>('warning');
  // Every exit from this page goes through `leave`, never `goBack()` directly: it
  // bumps the generation, resets the step and the drawer, then pops through this
  // hook. `history.go(-1)` settles on a later task, so two exits in one visit would
  // each pop a page (Settings too); the hook fires once per location as a safety
  // net, and routes to the Settings root when the page was opened cold.
  const popPage = useBackWithFallback('/settings');
  // Leaving must INVALIDATE an in-flight reveal, not merely navigate. Close and the
  // back arrow stay live while the biometric prompt is up, and `history.go(-1)`
  // settles on a later task, so a reveal that resolves in between would otherwise
  // store the mnemonic and swap the rendered branch to the word grid on a page the
  // user has already dismissed. Bumping the generation gives that in-flight promise
  // the same mismatch unmount already produces. Wrapped at the binding rather than
  // at each call site: there are many, and a list is one edit away from missing one.
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
  const [probeSlow, setProbeSlow] = useState(false);
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

  // Detect the auth type, so View knows which gate to open. `probeHardwareProtector` resolves a
  // failed read through the password protector instead of guessing; only a failure of both reads
  // reaches `probeError`.
  //
  // One probe per page at a time. Retry exists only once a probe has settled with both reads
  // rejected, so no second probe can start while one is in flight, and staying on the page adopts the
  // first read's answer however late. During a hang the only retry is leaving and reopening, which
  // ends this probe with the page: its late settle writes to an unmounted component, which React
  // ignores, and the new page's read answers if the first was lost rather than wedged.
  const runProbe = useCallback(() => {
    setProbing(true);
    let waited = false;
    probeTimer.current = setTimeout(() => {
      waited = true;
      console.warn(`[RevealSeedPhrase] protector probe still waiting after ${PROBE_TIMEOUT_MS}ms`);
      // The wait notice replaces an earlier failure's error: one message on screen at a time.
      setProbeError(null);
      setProbeSlow(true);
    }, PROBE_TIMEOUT_MS);

    probeHardwareProtector()
      .then(hasHw => {
        if (waited) console.warn('[RevealSeedPhrase] protector probe answered after the wait');
        setProbeError(null);
        setHasHardwareProtector(hasHw);
      })
      .catch(err => {
        console.warn(`[RevealSeedPhrase] protector probe failed: ${err instanceof Error ? err.message : String(err)}`);
        setProbeError('couldNotCheckUnlockMethod');
      })
      .finally(() => {
        clearTimeout(probeTimer.current);
        setProbeSlow(false);
        setProbing(false);
      });
  }, []);

  useEffect(() => {
    if (seedStatus && seedStatus !== 'stored') return;
    runProbe();
    return () => clearTimeout(probeTimer.current);
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
  // Drawer is inert, so no mount flag gates it.
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

  // Hardware back runs the header callback for the screen showing (#1042), so it also goes through
  // `leave` and abandons an in-flight reveal. A phrase is held only on the words screen.
  useMobileBackHandler(() => {
    (secret ? handleHide : leave)();
    return true;
  }, [secret, handleHide, leave]);

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

          {probeError ? (
            <ProtectorProbeErrorNotice onRetry={runProbe} retrying={probing} />
          ) : (
            probeSlow && (
              <Notice tone="neutral" role="status" data-testid="reveal-seed-probe-slow">
                {t('checkingUnlockMethodSlow')}
              </Notice>
            )
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
            <SeedPhraseGrid words={words} />

            {/* Copy is the shared Pill, drawn with the copy glyph and label over useClipboardCopy. */}
            <Pill
              className="self-start"
              icon={<AnimatedCopyIcon copied={copied} className="h-full w-full" />}
              onClick={() => void copy()}
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
