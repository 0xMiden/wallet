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
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';

const RotateGuardianReview: FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const currentAccount = useWalletStore(s => s.currentAccount);
  const { unlock } = useMidenContext();
  // The picker is this screen's only parent, and the screen rebuilds its whole
  // state from the query string, so a cold load belongs back at the picker rather
  // than dumped at the wallet home.
  const handleBack = useBackWithFallback('/rotate-guardian');

  const newEndpoint = useMemo(() => new URLSearchParams(search).get('endpoint') ?? '', [search]);
  // The picker refuses to rotate onto the active guardian, but this screen takes
  // its target from the query string, so backing into it after the rotation landed
  // would queue a second switch to the endpoint that is now already current.
  const endpointUnchanged = newEndpoint === currentEndpoint;

  const [authStep, setAuthStep] = useState(false);
  const [password, setPassword] = useState('');
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionRef = useRef(false);

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
    [currentAccount, newEndpoint, endpointUnchanged, unlock, t]
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
    if (hasHardwareProtector) {
      void authenticateAndSwitch(undefined);
      return;
    }
    setPassword('');
    setError(null);
    setAuthStep(true);
  }, [authenticateAndSwitch, currentAccount, endpointUnchanged, hasHardwareProtector, newEndpoint, submitting, t]);

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
          <p className="pt-6 text-sm text-text-muted">{t('guardianSwitchAuthenticationDescription')}</p>
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
            <h3 className="text-sm font-semibold text-text-muted">{t('details')}</h3>
            <div className="flex items-center justify-between border-b border-border-faint py-3 text-sm">
              <span className="font-medium text-text-muted">{t('walletKeyHot')}</span>
              <span className="font-semibold text-heading-gray">{hotKeyLabel}</span>
            </div>
            <div className="flex items-center justify-between py-3 text-sm">
              <span className="font-medium text-text-muted">{t('recoveryPhraseCold')}</span>
              <span className="font-semibold text-heading-gray">{t('required')}</span>
            </div>
          </div>

          <div className="mt-2 flex items-start gap-3 rounded-2xl bg-gray-100 p-4">
            <Icon name={IconName.WarningFill} size="sm" className="mt-0.5 shrink-0" fill="#E8A33D" />
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
        {error && <div className="mb-3 text-red-500 text-xs select-text wrap-break-word">{error}</div>}
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
