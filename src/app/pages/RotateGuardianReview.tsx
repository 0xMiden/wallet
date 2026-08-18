import React, { FC, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
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
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { goBack, navigate, useLocation } from 'lib/woozie';

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

  const authenticateAndSwitch = useCallback(
    async (credential?: string) => {
      if (!currentAccount || !newEndpoint || submissionRef.current) return;
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
    <PageLayout hideToolbar>
      <NavigationHeader title={t('reviewRotation')} onBack={goBack} variant="prominent" titleAlign="left" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-lg flex-col px-4 pb-8 font-heading">
          <GuardianRotationIllustration className="mx-auto mb-4 mt-1 h-28 w-auto" />

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

          {error && <div className="mt-3 text-red-500 text-xs select-text wrap-break-word">{error}</div>}

          <div className="mt-auto pt-4">
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
