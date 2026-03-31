import React, { useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField, { PASSWORD_ERROR_CAPTION } from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { getGoogleAuthToken, getStoredOAuthResult, GoogleAuthResult } from 'lib/miden/backup/google-drive-auth';
import { useMidenContext } from 'lib/miden/front';
import { WalletAccount, WalletSettings } from 'lib/shared/types';

interface FormData {
  backupPassword: string;
}

export interface ImportFromCloudScreenProps {
  className?: string;
  onSubmit?: (payload: { walletAccounts: WalletAccount[]; walletSettings: WalletSettings }) => void;
}

export const ImportFromCloudScreen: React.FC<ImportFromCloudScreenProps> = ({ className, onSubmit }) => {
  const { t } = useTranslation();
  const { restoreCloudBackup } = useMidenContext();

  const [auth, setAuth] = useState<GoogleAuthResult | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Check for a stored OAuth result from a previous sign-in (popup may have closed during OAuth)
  useEffect(() => {
    getStoredOAuthResult().then(stored => {
      if (stored) setAuth(stored);
    });
  }, []);

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

  const handleRestore = useCallback(
    async (data: FormData) => {
      if (!auth || !onSubmit) return;
      setRestoreError(null);
      try {
        const { walletAccounts, walletSettings } = await restoreCloudBackup(auth.accessToken, data.backupPassword);
        onSubmit({ walletAccounts, walletSettings });
      } catch (err) {
        setRestoreError(err instanceof Error ? err.message : String(err));
      }
    },
    [auth, restoreCloudBackup, onSubmit]
  );

  return (
    <form
      className={classNames('flex-1 h-full', 'flex flex-col items-center gap-y-2', 'bg-app-bg px-4 pt-6', className)}
      onSubmit={handleSubmit(handleRestore)}
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
      ) : (
        <div className="flex flex-col gap-3 w-full">
          <div className="rounded-xl bg-grey-25 px-4 py-3 text-sm">{t('cloudSignedIn', { email: auth.email })}</div>

          <FormField
            {...register('backupPassword', { required: PASSWORD_ERROR_CAPTION })}
            label={t('backupPassword')}
            id="cloud-backup-password"
            type="password"
            placeholder="********"
            errorCaption={restoreError || errors.backupPassword?.message}
            containerClassName="mb-2"
          />
        </div>
      )}

      <div className="mt-auto w-full pt-4">
        <FormSubmitButton
          loading={isSubmitting}
          className="w-full text-base"
          style={{ display: 'block', fontWeight: 500, padding: '12px 0px' }}
          disabled={!auth || !isValid}
        >
          {isSubmitting ? t('cloudRestoring') : t('import')}
        </FormSubmitButton>
      </div>
    </form>
  );
};
