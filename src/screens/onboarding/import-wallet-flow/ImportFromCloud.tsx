import React, { useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField, { PASSWORD_ERROR_CAPTION } from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { getGoogleAuthToken, getStoredOAuthResult, GoogleAuthResult } from 'lib/miden/backup/google-drive-auth';
import { useMidenContext } from 'lib/miden/front';
import { getPasskeyProvider } from 'lib/passkey';
import { CloudBackupCredentials, CloudBackupProbeResult } from 'lib/shared/types';

interface FormData {
  backupPassword: string;
}

export interface ImportFromCloudScreenProps {
  className?: string;
  onSubmit?: (payload: CloudBackupCredentials) => void;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export const ImportFromCloudScreen: React.FC<ImportFromCloudScreenProps> = ({ className, onSubmit }) => {
  const { t } = useTranslation();
  const { restoreCloudBackup, probeCloudBackup } = useMidenContext();

  const [auth, setAuth] = useState<GoogleAuthResult | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<CloudBackupProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  // Check for a stored OAuth result from a previous sign-in
  useEffect(() => {
    getStoredOAuthResult().then(stored => {
      if (stored) setAuth(stored);
    });
  }, []);

  // Probe backup after sign-in to detect encryption method
  useEffect(() => {
    if (!auth) return;
    setProbing(true);
    probeCloudBackup(auth.accessToken)
      .then(setProbeResult)
      .catch(() => setProbeResult(null))
      .finally(() => setProbing(false));
  }, [auth, probeCloudBackup]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isValid }
  } = useForm<FormData>({ mode: 'onChange' });

  const handleSignIn = useCallback(async () => {
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await getGoogleAuthToken();
      setAuth(result);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  }, []);

  const handlePasswordRestore = useCallback(
    async (data: FormData) => {
      if (!auth || !onSubmit) return;
      setRestoreError(null);
      try {
        const { walletAccounts, walletSettings } = await restoreCloudBackup(auth.accessToken, {
          method: 'password',
          backupPassword: data.backupPassword
        });
        onSubmit({
          walletAccounts,
          walletSettings,
          accessToken: auth.accessToken,
          expiresAt: auth.expiresAt,
          refreshToken: auth.refreshToken,
          encryption: { method: 'password', backupPassword: data.backupPassword }
        });
      } catch (err) {
        setRestoreError(err instanceof Error ? err.message : String(err));
      }
    },
    [auth, restoreCloudBackup, onSubmit]
  );

  const handlePasskeyRestore = useCallback(async () => {
    if (!auth || !onSubmit || !probeResult?.credentialId || !probeResult?.prfSalt) return;
    setRestoreError(null);
    try {
      const provider = await getPasskeyProvider();
      if (!provider) throw new Error('Passkeys not available on this platform');

      const credentialId = Uint8Array.from(atob(probeResult.credentialId), c => c.charCodeAt(0));
      const prfSalt = Uint8Array.from(atob(probeResult.prfSalt), c => c.charCodeAt(0));
      const { keyMaterial } = await provider.authenticate(credentialId, prfSalt);

      const { walletAccounts, walletSettings } = await restoreCloudBackup(auth.accessToken, {
        method: 'passkey',
        keyMaterial: toBase64(keyMaterial)
      });
      onSubmit({
        walletAccounts,
        walletSettings,
        accessToken: auth.accessToken,
        expiresAt: auth.expiresAt,
        refreshToken: auth.refreshToken,
        encryption: {
          method: 'passkey',
          keyMaterial: toBase64(keyMaterial),
          credentialId: probeResult.credentialId,
          prfSalt: probeResult.prfSalt
        }
      });
    } catch (err) {
      console.log('Passkey restore error:', err);
      setRestoreError(err instanceof Error ? err.message : String(err));
    }
  }, [auth, probeResult, restoreCloudBackup, onSubmit]);

  const isPasskeyBackup = probeResult?.encryptionMethod === 'passkey';
  const isPasswordBackup = probeResult?.encryptionMethod === 'password';
  const noBackup = probeResult?.encryptionMethod === null;

  return (
    <div
      className={classNames('flex-1 h-full', 'flex flex-col items-center gap-y-2', 'bg-app-bg px-4 pt-6', className)}
    >
      <h1 className="text-2xl font-semibold">{t('importFromCloudBackup')}</h1>
      <p className="text-sm text-center mb-4">{t('importWithCloudBackupDescription')}</p>

      {!auth ? (
        <div className="flex flex-col items-center gap-3 w-full">
          <button
            type="button"
            onClick={handleSignIn}
            disabled={signingIn}
            className={classNames(
              'w-full rounded-xl border border-grey-200 px-4 py-3',
              'text-sm font-medium transition-colors',
              'hover:bg-grey-50 disabled:opacity-50'
            )}
          >
            {signingIn ? t('signingIn') : t('cloudSignIn')}
          </button>
          {signInError && <p className="text-sm text-red-500 select-text">{signInError}</p>}
        </div>
      ) : probing ? (
        <p className="text-sm text-gray-500">{t('cloudProbing')}</p>
      ) : noBackup ? (
        <p className="text-sm text-red-500">{t('cloudNoBackupFound')}</p>
      ) : isPasskeyBackup ? (
        <div className="flex flex-col gap-3 w-full">
          <div className="rounded-xl bg-grey-25 px-4 py-3 text-sm">{t('cloudSignedIn', { email: 'Google' })}</div>
          <p className="text-sm text-center">{t('cloudPasskeyRestoreHint')}</p>
          {restoreError && <p className="text-sm text-red-500 select-text">{restoreError}</p>}
          <div className="mt-auto w-full pt-4">
            <button
              type="button"
              onClick={handlePasskeyRestore}
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium"
            >
              {t('cloudRestoreWithPasskey')}
            </button>
          </div>
        </div>
      ) : isPasswordBackup ? (
        <form className="flex flex-col gap-3 w-full flex-1" onSubmit={handleSubmit(handlePasswordRestore)}>
          <div className="rounded-xl bg-grey-25 px-4 py-3 text-sm">{t('cloudSignedIn', { email: 'Google' })}</div>
          <FormField
            {...register('backupPassword', { required: PASSWORD_ERROR_CAPTION })}
            label={t('backupPassword')}
            id="cloud-backup-password"
            type="password"
            placeholder="********"
            errorCaption={restoreError || errors.backupPassword?.message}
            containerClassName="mb-2"
          />
          <div className="mt-auto w-full pt-4">
            <FormSubmitButton
              loading={isSubmitting}
              className="w-full text-base"
              style={{ display: 'block', fontWeight: 500, padding: '12px 0px' }}
              disabled={!isValid}
            >
              {isSubmitting ? t('cloudRestoring') : t('import')}
            </FormSubmitButton>
          </div>
        </form>
      ) : null}
    </div>
  );
};
