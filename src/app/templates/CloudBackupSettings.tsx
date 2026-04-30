import React, { FC, useCallback, useEffect, useState } from 'react';

import { Button, ButtonVariant } from 'components/Button';
import {
  consumePendingExtensionAuth,
  getGoogleAuthToken,
  GoogleAuthResult,
  trySilentGoogleAuth
} from 'lib/miden/backup/google-drive-auth';
import { useMidenContext } from 'lib/miden/front';
import { generateSalt } from 'lib/miden/passworder';
import { getPasskeyProvider } from 'lib/passkey';
import { u8ToB64 } from 'lib/shared/helpers';
import { AutoBackupStatus } from 'lib/shared/types';

type EncryptionMethod = 'password' | 'passkey';

const CloudBackupSettings: FC<{ onClose?: () => void }> = () => {
  const { setAutoBackupEnabled, fetchAutoBackupStatus, restoreFromAutoBackup } = useMidenContext();

  const [auth, setAuth] = useState<GoogleAuthResult | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [encryptionMethod, setEncryptionMethod] = useState<EncryptionMethod>('password');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoBackupStatus, setAutoBackupStatus] = useState<AutoBackupStatus | null>(null);

  // Fetch auto-backup status and try silent Google auth on mount.
  // If we just landed here in the side panel after the popup deferred OAuth
  // (popup closes when OAuth window takes focus), resume the interactive flow.
  useEffect(() => {
    fetchAutoBackupStatus()
      .then(setAutoBackupStatus)
      .catch(() => {});
    consumePendingExtensionAuth()
      .then(deferred => {
        if (deferred) {
          setAuth(deferred);
          setStatus('Signed in with Google');
          return;
        }
        return trySilentGoogleAuth().then(silent => {
          if (silent) setAuth(silent);
        });
      })
      .catch(err => setStatus(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`));
  }, [fetchAutoBackupStatus]);

  const handleSignIn = useCallback(async () => {
    setLoading(true);
    setStatus('Signing in...');
    try {
      const result = await getGoogleAuthToken();
      setAuth(result);
      setStatus('Signed in with Google');
    } catch (err: unknown) {
      setStatus(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleEnable = useCallback(async () => {
    if (!auth) return;
    setLoading(true);
    setStatus('Enabling auto-backup...');
    try {
      if (encryptionMethod === 'passkey') {
        const provider = await getPasskeyProvider();
        if (!provider) throw new Error('Passkeys not available on this platform');

        const salt = generateSalt();
        const { keyMaterial, credentialId, prfSalt } = await provider.register(salt);

        await setAutoBackupEnabled(true, auth.accessToken, auth.expiresAt, {
          method: 'passkey',
          keyMaterial: u8ToB64(keyMaterial),
          credentialId: u8ToB64(credentialId),
          prfSalt: u8ToB64(prfSalt)
        });
      } else {
        if (!backupPassword) return;
        await setAutoBackupEnabled(true, auth.accessToken, auth.expiresAt, {
          method: 'password',
          backupPassword
        });
      }
      setBackupPassword('');
      setStatus('Auto-backup enabled');
      const updated = await fetchAutoBackupStatus();
      setAutoBackupStatus(updated);
    } catch (err: unknown) {
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [auth, backupPassword, encryptionMethod, setAutoBackupEnabled, fetchAutoBackupStatus]);

  const handleDisable = useCallback(async () => {
    setLoading(true);
    setStatus('Disabling auto-backup...');
    try {
      await setAutoBackupEnabled(false);
      setStatus('Auto-backup disabled');
      const updated = await fetchAutoBackupStatus();
      setAutoBackupStatus(updated);
    } catch (err: unknown) {
      setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [setAutoBackupEnabled, fetchAutoBackupStatus]);

  const handleRestore = useCallback(async () => {
    setLoading(true);
    setStatus('Restoring from backup...');
    try {
      await restoreFromAutoBackup();
      setStatus('Restored from backup');
      const updated = await fetchAutoBackupStatus();
      setAutoBackupStatus(updated);
    } catch (err: unknown) {
      setStatus(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [restoreFromAutoBackup, fetchAutoBackupStatus]);

  const handleGoogleReauth = useCallback(async () => {
    setLoading(true);
    setStatus('Re-authenticating with Google...');
    try {
      const result = await getGoogleAuthToken();
      setAuth(result);
      // Re-enable with fresh token (encryption unchanged, just refreshing token)
      setStatus('Re-authenticated with Google');
    } catch (err: unknown) {
      setStatus(`Re-auth failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const isEnabled = autoBackupStatus?.enabled ?? false;
  const enableDisabled = loading || !auth || (encryptionMethod === 'password' && !backupPassword);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">Cloud Backup</h2>

      {/* Status */}
      {isEnabled && autoBackupStatus && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
          <p className="font-medium text-green-800">Auto-backup enabled ({autoBackupStatus.method})</p>
          {autoBackupStatus.lastBackupAt && (
            <p className="text-green-600">Last backup: {new Date(autoBackupStatus.lastBackupAt).toLocaleString()}</p>
          )}
          {autoBackupStatus.lastError && <p className="text-red-600">Error: {autoBackupStatus.lastError}</p>}
          {autoBackupStatus.needsGoogleReauth && (
            <Button
              className="mt-2 w-full justify-center"
              title="Re-authenticate with Google"
              variant={ButtonVariant.Secondary}
              onClick={handleGoogleReauth}
              disabled={loading}
            />
          )}
        </div>
      )}

      {/* Auth */}
      {!isEnabled && (
        <>
          <Button
            className="w-full justify-center"
            title={auth ? 'Signed in with Google' : 'Sign in with Google'}
            variant={ButtonVariant.Secondary}
            onClick={handleSignIn}
            disabled={loading || !!auth}
          />

          {/* Encryption method selector */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEncryptionMethod('password')}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                encryptionMethod === 'password' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300'
              }`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setEncryptionMethod('passkey')}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                encryptionMethod === 'passkey' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-300'
              }`}
            >
              Passkey
            </button>
          </div>

          {/* Password input (only for password method) */}
          {encryptionMethod === 'password' && (
            <input
              type="password"
              placeholder="Backup password"
              value={backupPassword}
              onChange={e => setBackupPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          )}

          {/* Enable */}
          <Button
            className="w-full justify-center"
            title={encryptionMethod === 'passkey' ? 'Enable with Passkey' : 'Enable Auto-Backup'}
            variant={ButtonVariant.Primary}
            onClick={handleEnable}
            disabled={enableDisabled}
          />
        </>
      )}

      {/* Restore + Disable */}
      {isEnabled && (
        <>
          <Button
            className="w-full justify-center"
            title="Restore from Backup"
            variant={ButtonVariant.Primary}
            onClick={handleRestore}
            disabled={loading || autoBackupStatus?.needsGoogleReauth}
          />
          <Button
            className="w-full justify-center"
            title="Disable Auto-Backup"
            variant={ButtonVariant.Secondary}
            onClick={handleDisable}
            disabled={loading}
          />
        </>
      )}

      {/* Status message */}
      {status && <p className="text-sm text-gray-500 select-text">{status}</p>}
    </div>
  );
};

export default CloudBackupSettings;
