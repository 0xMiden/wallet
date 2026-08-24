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
import { initiateSwitchGuardianTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
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
  const { unlock } = useMidenContext();
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

  // Inert while a switch is in flight, matching the hardware/swipe handler below.
  // Only that one was gated, so on the hardware-protector path — where the user
  // stays on this screen through `unlock` and `initiate` — the chevron could
  // navigate away mid-flight while the in-flight promise went on to redirect to
  // the progress page, or the user could re-enter and queue a second switch.
  const handleBack = useCallback(() => {
    if (submitting) return;
    popBack();
  }, [submitting, popBack]);

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
      submissionRef.current = true;
      setSubmitting(true);
      setError(null);
      try {
        await unlock(credential);
        const txId = await initiateSwitchGuardianTransaction(
          currentAccount.publicKey,
          newEndpoint,
          isDelegateProofEnabled(),
          zustandProvider
        );
        if (isExtension()) requestSWTransactionProcessing();
        navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        submissionRef.current = false;
        setSubmitting(false);
      }
    },
    [currentAccount, newEndpoint, endpointUnchanged, endpointInvalid, unlock, t]
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

  const handleAuthBack = useCallback(() => {
    if (submitting) return;
    setPassword('');
    setError(null);
    setAuthStep(false);
  }, [submitting]);

  // Hardware/swipe back has to follow the same route the on-screen chevron does.
  // This screen hides PageLayout's toolbar, which was the only thing registering
  // a back handler, so MobileBackBridge's catch-all took over and threw the user
  // out to the wallet home from the credential step and from a cold-opened
  // review alike.
  useMobileBackHandler(() => {
    if (submitting) return true;
    if (authStep) {
      handleAuthBack();
      return true;
    }
    handleBack();
    return true;
  }, [authStep, handleAuthBack, handleBack, submitting]);

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
            <Icon
              name={IconName.WarningFill}
              size="sm"
              className="mt-0.5 shrink-0"
              fill={colors.yellow[500]}
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
