import React, { FC, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { useCurrentGuardianEndpoint } from 'app/hooks/useCurrentGuardianEndpoint';
import PageLayout from 'app/layouts/PageLayout';
import { Alert, AlertVariant } from 'components/Alert';
import { Button } from 'components/Button';
import { GuardianTransitionHero } from 'components/GuardianTransitionHero';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { checkBiometricAvailability, isBiometricEnabled } from 'lib/biometric';
import { initiateSwitchGuardianTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { Vault } from 'lib/miden/back/vault';
import { useMidenContext } from 'lib/miden/front';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { enterRouteFlow, reportRouteFlowStep, settleRouteFlow } from 'lib/telemetry/route-flow';
import { DetailCard, DetailRow } from 'lib/ui/DetailCard';
import { navigate, useLocation } from 'lib/woozie';

const RotateGuardianReview: FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const { endpoint: currentEndpoint } = useCurrentGuardianEndpoint();
  const currentAccount = useWalletStore(s => s.currentAccount);
  const { unlock } = useMidenContext();

  const newEndpoint = useMemo(() => new URLSearchParams(search).get('endpoint') ?? '', [search]);

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
      submissionRef.current = true;
      setSubmitting(true);
      setError(null);
      reportRouteFlowStep('guardian_rotate', 'submitting');
      try {
        await unlock(credential);
        const txId = await initiateSwitchGuardianTransaction(
          currentAccount.publicKey,
          newEndpoint,
          isDelegateProofEnabled(),
          zustandProvider
        );
        if (isExtension()) requestSWTransactionProcessing();
        // Settled before navigating away, which unmounts this page.
        settleRouteFlow('guardian_rotate', flow => flow.complete());
        navigate(`/generating-transaction-full/${encodeURIComponent(txId)}`);
      } catch (err) {
        // Not settled: a wrong password leaves the user on this screen and able
        // to try again, so the flow is still open. `submitting` already records
        // that they got this far if they then give up.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        submissionRef.current = false;
        setSubmitting(false);
      }
    },
    [currentAccount, newEndpoint, unlock]
  );

  const handleContinue = useCallback(() => {
    if (!currentAccount || !newEndpoint || submitting || hasHardwareProtector === null) return;
    if (hasHardwareProtector) {
      void authenticateAndSwitch(undefined);
      return;
    }
    setPassword('');
    setError(null);
    setAuthStep(true);
  }, [authenticateAndSwitch, currentAccount, hasHardwareProtector, newEndpoint, submitting]);

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
    <PageLayout pageTitle={<>{t('reviewRotation')}</>} navigationStyle="back">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-4 pb-8">
          <GuardianTransitionHero
            previousEndpoint={currentEndpoint}
            newEndpoint={newEndpoint}
            previousLabel={t('currentLabel')}
            newLabel={t('newLabel')}
            variant="review"
          />

          <div className="mt-4">
            <DetailCard>
              <DetailRow label={t('walletKeyHot')} value={hotKeyLabel} />
              <DetailRow label={t('recoveryPhraseCold')} value={t('required')} isLast />
            </DetailCard>
          </div>

          <Alert
            variant={AlertVariant.Warning}
            className="mt-4"
            title={
              <span className="block text-heading-gray">
                <span className="block text-sm font-semibold text-heading-gray">{t('oldGuardianCantBlockTitle')}</span>
                <span className="mt-1 block text-sm leading-5 text-heading-gray">{t('oldGuardianCantBlockBody')}</span>
              </span>
            }
          />

          {error && <div className="mt-3 text-red-500 text-xs select-text wrap-break-word">{error}</div>}

          <div className="mt-auto pt-6">
            <Button
              className="max-w-none"
              data-testid="rotate-guardian-confirm"
              title={t('continue')}
              onClick={handleContinue}
              disabled={submitting || hasHardwareProtector === null || !currentAccount || !newEndpoint}
              isLoading={submitting}
            />
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default RotateGuardianReview;
