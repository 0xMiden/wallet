import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Input } from 'components/Input';
import { PasscodeEntry } from 'components/PasscodeEntry';
import {
  StrictActionAuthenticationChallenge,
  StrictAuthenticationMethod,
  StrictAuthenticationResult,
  createStrictActionAuthenticationController
} from 'lib/auth/strict-action-authentication';
import { getPlatform } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { cn } from 'lib/ui/util';

export interface StrictActionAuthenticationProps {
  reason: string;
  onResult: (result: StrictAuthenticationResult) => void;
  className?: string;
}

type DisplayMethod = StrictAuthenticationMethod | 'unavailable' | null;

export const StrictActionAuthentication: React.FC<StrictActionAuthenticationProps> = ({
  reason,
  onResult,
  className
}) => {
  const { t } = useTranslation();
  const loadProtectors = useWalletStore(state => state.getStrictAuthenticationProtectors);
  const verify = useWalletStore(state => state.verifyStrictActionAuthentication);
  const controller = useMemo(
    () => createStrictActionAuthenticationController({ getPlatform, loadProtectors, verify }),
    [loadProtectors, verify]
  );
  const [method, setMethod] = useState<DisplayMethod>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const challengeRef = useRef<StrictActionAuthenticationChallenge>();
  const mountedRef = useRef(false);
  const submittingRef = useRef(false);

  const beginChallenge = useCallback(() => {
    challengeRef.current?.cancel();
    const challenge = controller.begin();
    challengeRef.current = challenge;
    setMethod(null);
    void challenge.method.then(nextMethod => {
      if (mountedRef.current && challengeRef.current === challenge) {
        setMethod(nextMethod ?? 'unavailable');
      }
    });
  }, [controller]);

  useEffect(() => {
    mountedRef.current = true;
    beginChallenge();
    return () => {
      mountedRef.current = false;
      challengeRef.current?.cancel();
      challengeRef.current = undefined;
    };
  }, [beginChallenge]);

  const authenticate = useCallback(
    async (credential?: string) => {
      const challenge = challengeRef.current;
      if (challenge === undefined || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      setPassword('');
      const result = await challenge.authenticate(credential);
      if (!mountedRef.current || challengeRef.current !== challenge) return;
      submittingRef.current = false;
      setSubmitting(false);
      if (result === 'authenticated') {
        onResult(result);
        return;
      }
      setError(t(method === 'hardware' ? 'biometricFailed' : 'smthWentWrong'));
      beginChallenge();
    },
    [beginChallenge, method, onResult, t]
  );

  const cancel = useCallback(() => {
    challengeRef.current?.cancel();
    challengeRef.current = undefined;
    submittingRef.current = false;
    setPassword('');
    onResult('cancelled');
  }, [onResult]);

  const submitPassword = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (password.length === 0) return;
      void authenticate(password);
    },
    [authenticate, password]
  );

  return (
    <section className={cn('flex w-full flex-col gap-4', className)} aria-busy={submitting}>
      <p className="text-sm text-text-secondary-token">{reason}</p>
      {error && (
        <p role="alert" className="text-sm text-status-negative">
          {error}
        </p>
      )}
      {method === null && (
        <p role="status" className="text-sm text-text-secondary-token">
          {t('loading')}
        </p>
      )}
      {method === 'unavailable' && (
        <p role="alert" className="text-sm text-status-negative">
          {t('guardianAuthenticationUnavailable')}
        </p>
      )}
      {method === 'passcode' && (
        <PasscodeEntry
          onSubmit={credential => void authenticate(credential)}
          onChange={() => setError(null)}
          error={error}
          disabled={submitting}
          isSubmitting={submitting}
        />
      )}
      {method === 'password' && (
        <form className="flex flex-col gap-4" onSubmit={submitPassword}>
          <Input
            id="strict-action-password"
            type="password"
            label={t('password')}
            aria-label={t('password')}
            autoComplete="current-password"
            value={password}
            disabled={submitting}
            onChange={event => {
              setPassword(event.target.value);
              setError(null);
            }}
          />
          <Button
            type="submit"
            title={t('continue')}
            disabled={password.length === 0 || submitting}
            isLoading={submitting}
          />
        </form>
      )}
      {method === 'hardware' && (
        <Button
          title={t(error ? 'tryAgain' : 'continue')}
          disabled={submitting}
          isLoading={submitting}
          onClick={() => void authenticate()}
        />
      )}
      <Button variant={ButtonVariant.Secondary} title={t('cancel')} disabled={submitting} onClick={cancel} />
    </section>
  );
};

export default StrictActionAuthentication;
