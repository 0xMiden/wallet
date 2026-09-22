import React, { FC, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import { ReactComponent as GuardianRotationIllustration } from 'app/icons/guardian-rotation-illustration.svg';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button } from 'components/Button';
import { GuardianTransitionHero } from 'components/GuardianTransitionHero';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
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
import { isGuardianRotationInProgress } from 'lib/miden/guardian/rotation-in-progress';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled, isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { enterRouteFlow, reportRouteFlowStep, settleRouteFlow } from 'lib/telemetry/route-flow';
import { navigate, useLocation } from 'lib/woozie';

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

  // Rotating the guardian is a security-critical flow the user can be walked
  // into from settings or from a recovery prompt, and it ends in a password /
  // passkey challenge — a plausible place to give up, and previously invisible.
  useEffect(() => {
    enterRouteFlow('guardian_rotate');
    reportRouteFlowStep('guardian_rotate', 'review');
    return () => settleRouteFlow('guardian_rotate', flow => flow.cancel());
  }, []);

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
      reportRouteFlowStep('guardian_rotate', 'submitting');
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
        // Settled here rather than after the branch below, because one arm of it
        // navigates away and that unmounts this page. A no-op if they already
        // backed out — the unmount cleanup settled it as cancelled then, which is
        // the honest verdict for someone who left before the switch landed.
        settleRouteFlow('guardian_rotate', flow => flow.complete());
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
        // Not settled: a wrong password leaves the user on this screen and able
        // to try again, so the flow is still open. `submitting` already records
        // that they got this far if they then give up.
        // The pre-check above reads the queue BEFORE `unlock`, so a row created
        // during that window (a second mount, a second review URL) gets past it
        // and is caught here instead. Same condition, so same localized copy —
        // the error's own message is developer-facing English and must not reach
        // the user.
        //
        // Matched on SHAPE, not `instanceof`: the class is the contract but the
        // identity check is not survivable. This error is thrown across a module
        // boundary that the intercom adapters may serialize, which drops the
        // prototype and leaves a plain object carrying `name` — and an
        // `instanceof` against a mocked or duplicated module binding throws
        // "Right-hand side of 'instanceof' is not an object" from inside the very
        // catch that exists to render an error. Note that gating the name check
        // on `err instanceof Error` reintroduces exactly the failure the name
        // check exists to avoid, which is why the predicate lives beside the
        // constant rather than being spelled out here.
        const rotationInProgress = isGuardianRotationInProgress(err);
        // The message read is shape-based for the same reason: a serialized error
        // still carries `message`, and an `instanceof Error` gate in front of it
        // sends one to `String(err)`, which renders "[object Object]" into a
        // `role="alert"` block.
        // And a value with no usable message at all falls back to localized copy
        // rather than `String(err)`, which renders "[object Object]" for the
        // message-LESS serialized rejection (`{ code: 'x' }`) that the shape read
        // above cannot rescue. Reuses an existing key, so no locale churn.
        const message =
          typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string'
            ? err.message
            : typeof err === 'string'
              ? err
              : t('smthWentWrong');
        setError(rotationInProgress ? t('guardianSwitchAlreadyInProgress') : message);
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
  // handler returned early, and the step's on-screen chevron routes straight back into
  // it - `SubPageLayout`'s `onBack`, on a screen that hides PageLayout's toolbar and so
  // has no close button beside it.
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
      <PageLayout hideToolbar>
        {/* This branch is where the rotation is committed, so it names the network too. A single
            banner on the review branch below would have left exactly this screen unwarned. */}
        <NetworkModeBanner />
        <SubPageLayout
          title={t(isMobile() ? 'enterYourPasscode' : 'enterPassword')}
          onBack={handleAuthBack}
          footer={
            isMobile() ? undefined : (
              <Button
                className="max-w-none"
                data-testid="rotate-guardian-auth-submit"
                title={t('continue')}
                onClick={() => handlePasswordSubmit()}
                disabled={!password || submitting}
                isLoading={submitting}
              />
            )
          }
        >
          <p className="px-1 text-explainer text-muted">{t('guardianSwitchAuthenticationDescription')}</p>
          {isMobile() ? (
            <PasscodeEntry
              onSubmit={code => void authenticateAndSwitch(code)}
              onChange={() => setError(null)}
              error={error}
              isSubmitting={submitting}
              className="mt-auto pb-2"
            />
          ) : (
            // A form so Enter submits; the CTA is pinned in the footer and calls the same handler.
            <form onSubmit={handlePasswordSubmit}>
              <TextField
                id="rotate-guardian-password"
                type="password"
                name="password"
                label={t('password')}
                value={password}
                autoFocus
                placeholder="********"
                error={error ?? undefined}
                onChange={event => {
                  setPassword(event.target.value);
                  setError(null);
                }}
              />
            </form>
          )}
        </SubPageLayout>
      </PageLayout>
    );
  }

  return (
    <PageLayout hideToolbar>
      {/* Rotating a guardian replaces the account's recovery custodian, so this screen names the
          network it commits on. Outside SubPageLayout's body, which is the scroll region. */}
      <NetworkModeBanner />
      {/* Continue and its error are pinned in the footer, outside the scroll region (#463): the
          illustration and the hero cost ~220px of the 600px popup, which pushed a CTA inside the
          scroller below the fold. */}
      <SubPageLayout
        title={t('reviewRotation')}
        onBack={handleBack}
        footerLayout="stack"
        footer={
          <>
            {/* `role="alert"` because nothing else moves when a switch fails: focus stays on
                Continue and the reason appears above it. `max-h` + scroll so a long backend error
                cannot grow the footer and push Continue off-screen. */}
            {error && (
              <Notice tone="negative" role="alert" className="max-h-24 overflow-y-auto select-text wrap-break-word">
                {error}
              </Notice>
            )}
            <Button
              className="max-w-none"
              data-testid="rotate-guardian-confirm"
              title={t('continue')}
              onClick={handleContinue}
              disabled={submitting || hasHardwareProtector === null || !currentAccount || !newEndpoint}
              isLoading={submitting}
            />
          </>
        }
      >
        <div className="flex flex-col items-center">
          <GuardianRotationIllustration className="mb-4 h-28 w-auto" aria-hidden="true" />
          <GuardianTransitionHero
            previousEndpoint={currentEndpoint}
            newEndpoint={newEndpoint}
            previousLabel={t('currentGuardianLabel')}
            newLabel={t('newGuardianLabel')}
            variant="review"
          />
        </div>

        <SubPageSection title={t('details')} titleAs="h2">
          <DetailCard>
            <DetailRow label={t('walletKeyHot')}>{hotKeyLabel}</DetailRow>
            <DetailRow label={t('recoveryPhraseCold')}>{t('required')}</DetailRow>
          </DetailCard>
        </SubPageSection>

        <Notice
          tone="warning"
          title={t('oldGuardianCantBlockTitle')}
          icon={<Icon name={IconName.WarningFill} size="sm" fill="currentColor" />}
        >
          {t('oldGuardianCantBlockBody')}
        </Notice>
      </SubPageLayout>
    </PageLayout>
  );
};

export default RotateGuardianReview;
