import React, { FC, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { ReactComponent as GuardianRotationIllustration } from 'app/icons/guardian-rotation-illustration.svg';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button } from 'components/Button';
import { GuardianTransitionHero } from 'components/GuardianTransitionHero';
import { NavigationHeader } from 'components/NavigationHeader';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { checkBiometricAvailability, isBiometricEnabled } from 'lib/biometric';
import {
  getUncompletedTransactions,
  initiateSwitchGuardianTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled, isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';
import colors from 'utils/tailwind-colors';

const RotateGuardianReview: FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const currentAccount = useWalletStore(s => s.currentAccount);
  const { unlock, signTransaction } = useMidenContext();
  // The picker is this screen's only parent, and the screen rebuilds its whole
  // state from the query string, so a cold load belongs back at the picker rather
  // than dumped at the wallet home.
  const popBack = useBackWithFallback('/rotate-guardian');

  // Sanitized, because this screen takes its target from the query string rather
  // than from the picker's validated `onSubmit`, and `sanitizeGuardianUrl`'s
  // contract is to normalize "before persisting or comparing". Unsanitized, a
  // trailing slash or stray whitespace made a no-op switch look like a change to
  // both guards below and then persisted a second spelling of the same endpoint.
  const newEndpoint = useMemo(() => sanitizeGuardianUrl(new URLSearchParams(search).get('endpoint') ?? ''), [search]);
  // The picker refuses to rotate onto the active guardian, but this screen takes
  // its target from the query string, so backing into it after the rotation landed
  // would queue a second switch to the endpoint that is now already current.
  // Both sides sanitized: `currentEndpoint` comes from storage or a built-in
  // default, neither of which is guaranteed to be in the same spelling.
  const endpointUnchanged = newEndpoint === sanitizeGuardianUrl(currentEndpoint ?? '');
  // The picker validates a custom URL before handing it over (ChooseGuardian),
  // but nothing validates the query string, and a stale or hand-edited review URL
  // goes straight to `initiateSwitchGuardianTransaction`, which only checks the
  // account type before persisting whatever it is given. Refuse it here.
  const endpointInvalid = newEndpoint !== '' && !isValidGuardianUrl(newEndpoint);

  const [authStep, setAuthStep] = useState(false);
  const [password, setPassword] = useState('');
  // The credential step reads `newEndpoint` live from the query, so a navigation
  // that changed the query without remounting this route would have authenticated
  // for one endpoint and submitted another. Leaving the step is the safe response:
  // the user must re-read the target before authorizing it.
  useEffect(() => {
    setAuthStep(false);
    setPassword('');
  }, [newEndpoint]);
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionRef = useRef(false);

  // Set when the user backs out of a submission, so one that lands afterwards
  // does not yank them onto the progress page from wherever they went. That stray
  // redirect is the reason back was briefly gated on `submitting` instead — but
  // gating it removed the only exit this screen has (`hideToolbar`, so there is no
  // toolbar affordance behind the chevron), and `unlock` can hang forever rather
  // than reject: `request()` in lib/intercom/client.ts has no timeout, and its
  // `onDisconnect` reconnects the port without settling anything in flight, so an
  // MV3 worker recycle mid-unlock strands the promise and `submitting` never
  // clears. Suppress the redirect, keep the exit.
  //
  // "Abandoned", not "left": on the password path — the default everywhere except
  // a hardware protector — the hang happens ON the credential step, whose back
  // goes through `handleAuthBack` and returns to this screen rather than leaving
  // it. Gating only the chevron left that path trapped exactly as before.
  const abandoned = useRef(false);

  const handleBack = useCallback(() => {
    abandoned.current = true;
    popBack();
  }, [popBack]);

  useEffect(() => {
    let cancelled = false;
    Vault.hasHardwareProtector()
      .then(hasHardware => {
        if (!cancelled) setHasHardwareProtector(hasHardware);
      })
      .catch(() => {
        if (!cancelled) setError(t('guardianAuthenticationUnavailable'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // The hot key co-signs from the unlocked vault; surface how it's protected
  // on this device (biometric flavor or password) like the design's key rows.
  const [hotKeyLabel, setHotKeyLabel] = useState(() => t('password'));
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!(await isBiometricEnabled())) return;
        const availability = await checkBiometricAvailability();
        if (cancelled) return;
        if (availability.biometryType === 'face') setHotKeyLabel(t('faceId'));
        else if (availability.biometryType !== 'none') setHotKeyLabel(t('fingerprint'));
      } catch {
        // Keep the password fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const authenticateAndSwitch = useCallback(
    async (credential?: string) => {
      if (!currentAccount || !newEndpoint || submissionRef.current) return;
      // Last line of defence — `handleContinue` rejects this before asking for a
      // credential, but the password step submits straight through to here.
      if (endpointUnchanged) {
        setError(t('guardianEndpointUnchanged'));
        return;
      }
      if (endpointInvalid) {
        setError(t('invalidUrl'));
        return;
      }
      // Claimed synchronously, before the first `await` below. The queue read is
      // async, so latching after it would let two clicks in the same tick both get
      // past this guard — which is the double-submit the ref exists to stop.
      submissionRef.current = true;
      abandoned.current = false;
      setSubmitting(true);
      setError(null);
      try {
        // A switch already queued for this account, from a PREVIOUS mount. Backing
        // out of an in-flight submission and re-entering rebuilds this component,
        // so `submissionRef` — per-mount — cannot see the first attempt, and
        // `initiateSwitchGuardianTransaction` appends unconditionally: the FIFO
        // loop ended up with two switch-guardian rows for one account.
        // `endpointUnchanged` cannot cover it, because the first switch has not
        // landed and `currentEndpoint` is still the old one. Reading the queue
        // rather than holding a module-level latch keeps a retry available after a
        // hang, since a hung `unlock` never got as far as creating a row.
        const queued = await getUncompletedTransactions(currentAccount.publicKey);
        if (queued.some(tx => tx.type === 'switch-guardian')) {
          setError(t('guardianSwitchAlreadyInProgress'));
          return;
        }
        await unlock(credential);
        const txId = await initiateSwitchGuardianTransaction(
          currentAccount.publicKey,
          newEndpoint,
          isDelegateProofEnabled(),
          zustandProvider
        );
        if (isExtension()) requestSWTransactionProcessing();
        // Not if they have already backed out: the switch is queued either way and
        // shows up in Activity, so pulling them onto the progress page from
        // wherever they navigated to would be the app taking the wheel back.
        if (!abandoned.current) {
          navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
        } else if (!isExtension()) {
          // Someone has to drive the queue. On extension the service worker owns
          // the loop and the kick above is enough, but on mobile and desktop the
          // only driver from this flow is the progress page's interval — which the
          // line above just declined to open. The row would sit Queued forever, and
          // because the reapers that would clear it (`cancelStuckTransactions`,
          // `cancelStaleQueuedTransactions`) themselves only run inside the loop,
          // the duplicate guard would then refuse every future switch: a permanent
          // lockout, behind an error telling the user to wait for something that is
          // never going to finish. Same re-kick the native auto-consume manager
          // does, and safe for the same reason — concurrent passes serialize on
          // navigator.locks and self-terminate.
          startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        submissionRef.current = false;
        setSubmitting(false);
      }
    },
    [currentAccount, newEndpoint, endpointUnchanged, endpointInvalid, unlock, signTransaction, t]
  );

  const handleContinue = useCallback(() => {
    if (!currentAccount || !newEndpoint || submitting || hasHardwareProtector === null) return;
    // Say so here, on the review screen. Deferring this to `authenticateAndSwitch`
    // made the user authenticate first and then read "unchanged" as though it were
    // an auth failure, on a step that could never succeed.
    if (endpointUnchanged) {
      setError(t('guardianEndpointUnchanged'));
      return;
    }
    // Before the credential step, not after it: authenticating and only then
    // being told the target is malformed reads as an auth failure.
    if (endpointInvalid) {
      setError(t('invalidUrl'));
      return;
    }
    if (hasHardwareProtector) {
      void authenticateAndSwitch(undefined);
      return;
    }
    setPassword('');
    setError(null);
    setAuthStep(true);
  }, [
    authenticateAndSwitch,
    currentAccount,
    endpointUnchanged,
    endpointInvalid,
    hasHardwareProtector,
    newEndpoint,
    submitting,
    t
  ]);

  const handlePasswordSubmit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (!password || submitting) return;
      void authenticateAndSwitch(password);
    },
    [authenticateAndSwitch, password, submitting]
  );

  // No `submitting` gate here either. This is the step `unlock` is actually called
  // from on the password path, so a hung request left the user with nothing: this
  // handler returned early, and the step's on-screen chevron is PageLayout's
  // `onStepBack`, which routes straight back into it — and `navigationStyle="back"`
  // renders no close button beside it.
  const handleAuthBack = useCallback(() => {
    abandoned.current = true;
    setPassword('');
    setError(null);
    setAuthStep(false);
  }, []);

  // Hardware/swipe back has to follow the same route the on-screen chevron does.
  // This screen hides PageLayout's toolbar, which was the only thing registering
  // a back handler, so MobileBackBridge's catch-all took over and threw the user
  // out to the wallet home from the credential step and from a cold-opened
  // review alike.
  // No `submitting` gate, for the same reason the chevron lost it: returning true
  // without navigating swallows the press, and a hung `unlock` made that permanent
  // on a screen with no other way out. Both exits now behave the same.
  useMobileBackHandler(() => {
    if (authStep) {
      handleAuthBack();
      return true;
    }
    handleBack();
    return true;
  }, [authStep, handleAuthBack, handleBack]);

  if (authStep) {
    return (
      <PageLayout
        pageTitle={<>{t(isMobile() ? 'enterYourPasscode' : 'enterPassword')}</>}
        navigationStyle="back"
        step={1}
        setStep={handleAuthBack}
      >
        <div className="w-full max-w-sm mx-auto px-4 pb-8 flex flex-col flex-1 min-h-0">
          {/* `text-heading-gray` like the rest of this screen: `text-text-muted` is
              #ababab, 2.30:1 on the page in light mode. The sweep replaced this token
              across the flow and missed the one paragraph on the step where the user
              is being asked to type their password. */}
          <p className="pt-6 text-sm text-heading-gray">{t('guardianSwitchAuthenticationDescription')}</p>
          {isMobile() ? (
            <PasscodeEntry
              onSubmit={code => void authenticateAndSwitch(code)}
              onChange={() => setError(null)}
              error={error}
              isSubmitting={submitting}
              className="mt-auto pb-2"
            />
          ) : (
            <form className="flex flex-col flex-1 pt-6" onSubmit={handlePasswordSubmit}>
              <FormField
                id="rotate-guardian-password"
                type="password"
                name="password"
                label={t('password')}
                value={password}
                autoFocus
                placeholder="********"
                errorCaption={error}
                onChange={event => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
              <div className="mt-auto">
                <Button
                  data-testid="rotate-guardian-auth-submit"
                  title={t('continue')}
                  onClick={() => handlePasswordSubmit()}
                  disabled={!password || submitting}
                  isLoading={submitting}
                />
              </div>
            </form>
          )}
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout hideToolbar>
      <NavigationHeader title={t('reviewRotation')} onBack={handleBack} variant="prominent" titleAlign="left" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-4 pb-8 font-heading">
          <GuardianRotationIllustration className="mx-auto mb-4 mt-1 h-28 w-auto" aria-hidden="true" />

          <GuardianTransitionHero
            previousEndpoint={currentEndpoint}
            newEndpoint={newEndpoint}
            previousLabel={t('currentGuardianLabel')}
            newLabel={t('newGuardianLabel')}
            variant="review"
          />

          <div className="mt-4">
            {/* `text-heading-gray` throughout rather than `text-text-muted`: the
                muted token is #ababab, 2.3:1 on the app background in light mode.
                These are row labels, not decoration, and the DetailCard rows this
                block replaced carried the readable ink. */}
            <h3 className="text-sm font-semibold text-heading-gray">{t('details')}</h3>
            <div className="flex items-center justify-between border-b border-border-faint py-3 text-sm">
              <span className="font-medium text-heading-gray">{t('walletKeyHot')}</span>
              <span className="font-semibold text-heading-gray">{hotKeyLabel}</span>
            </div>
            <div className="flex items-center justify-between py-3 text-sm">
              <span className="font-medium text-heading-gray">{t('recoveryPhraseCold')}</span>
              <span className="font-semibold text-heading-gray">{t('required')}</span>
            </div>
          </div>

          {/* Alert's Warning fill, not `bg-gray-100`: that token is `--color-hover-bg`,
              the interaction tint every surface in the app uses, so a future change to
              hover silently restyled this panel — and it read as plain grey rather
              than cautionary while already borrowing the Alert's yellow glyph. */}
          <div className="mt-2 flex items-start gap-3 rounded-2xl bg-yellow-50 dark:bg-yellow-600/20 p-4">
            {/* The wallet's warning ink (`Alert`'s Warning variant uses the same
                token) rather than a one-off hex, which was a shade nothing else
                ships and was invisible to a theme switch. Decorative: the
                heading beside it already says this is a warning. */}
            {/* yellow-700, not yellow-500: the panel's fill is now yellow-50, and
                #FEA644 on #FFEFD2 is 1.72:1 — a caution mark that is effectively
                invisible in light mode, which defeats the point of moving the
                panel off grey. Exempt from 1.4.11 because it is aria-hidden, but
                it is the only cautionary signal the panel has. */}
            <Icon
              name={IconName.WarningFill}
              size="sm"
              className="mt-0.5 shrink-0"
              fill={colors.yellow[700]}
              aria-hidden="true"
            />
            <div className="text-sm">
              <p className="font-semibold text-heading-gray">{t('oldGuardianCantBlockTitle')}</p>
              <p className="mt-1 leading-5 text-heading-gray">{t('oldGuardianCantBlockBody')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Continue and its error sit OUTSIDE the scroll region, same shape as
          TransactionSuccessLayout (#463). The illustration and the prominent
          header together cost ~220px of the 600px popup, which pushed a CTA
          inside the scroller below the fold — the user had to scroll to find
          the only way forward, and a failure could render off-screen. */}
      <div className="shrink-0 px-4 pb-4 pt-2">
        {/* `role="alert"` because nothing else moves when a switch fails: focus
            stays on Continue, the button just stops spinning, and the reason
            appears above it silently. `max-h` + scroll so a long backend error
            cannot grow this fixed footer and push Continue back off-screen —
            the thing moving it out of the scroller was meant to prevent.

            `red-600` in light and `red-500` in dark: red-500 (#EF4444) is a fixed
            hex in both themes and only reaches 3.76:1 on the light page, short of
            4.5:1 for 12px, while red-600 is 4.83:1 light but 3.63:1 dark — neither
            works alone. A `dark:` variant is right here precisely because these are
            fixed-palette shades rather than auto-flipping vars. */}
        {error && (
          <div
            role="alert"
            className="mb-3 max-h-24 overflow-y-auto text-red-600 dark:text-red-500 text-xs select-text wrap-break-word"
          >
            {error}
          </div>
        )}
        <Button
          className="max-w-none"
          data-testid="rotate-guardian-confirm"
          title={t('continue')}
          onClick={handleContinue}
          disabled={submitting || hasHardwareProtector === null || !currentAccount || !newEndpoint}
          isLoading={submitting}
        />
      </div>
    </PageLayout>
  );
};

export default RotateGuardianReview;
