import React, { FC, useCallback, useState } from 'react';

import { Button, ButtonVariant } from 'components/Button';
import { useMidenContext } from 'lib/miden/front';
import { getPasskeyProvider } from 'lib/passkey';
import { generateSalt } from 'lib/miden/passworder';

import { getGoogleAuthToken, GoogleAuthResult } from '../../lib/miden/backup/google-drive-auth';

type EncryptionMethod = 'password' | 'passkey';

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const CloudBackupSettings: FC<{ onClose?: () => void }> = () => {
  const { createCloudBackup, restoreCloudBackup, probeCloudBackup } = useMidenContext();

  const [auth, setAuth] = useState<GoogleAuthResult | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [encryptionMethod, setEncryptionMethod] = useState<EncryptionMethod>('password');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = useCallback(async () => {
    setLoading(true);
    setStatus('Signing in...');
    try {
      const result = await getGoogleAuthToken();
      setAuth(result);
      setStatus(`Signed in as ${result.email || result.displayName || 'unknown'}`);
    } catch (err: unknown) {
      setStatus(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleBackup = useCallback(async () => {
    if (!auth) return;
    setLoading(true);
    setStatus('Creating backup...');
    try {
      if (encryptionMethod === 'passkey') {
        const provider = await getPasskeyProvider();
        if (!provider) throw new Error('Passkeys not available on this platform');

        const salt = generateSalt();
        const { keyMaterial, credentialId, prfSalt } = await provider.register(salt);

        await createCloudBackup(auth.accessToken, {
          method: 'passkey',
          keyMaterial: toBase64(keyMaterial),
          credentialId: toBase64(credentialId),
          prfSalt: toBase64(prfSalt)
        });
      } else {
        if (!backupPassword) return;
        await createCloudBackup(auth.accessToken, { method: 'password', backupPassword });
      }
      setStatus('Backup uploaded successfully');
    } catch (err: unknown) {
      setStatus(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [auth, backupPassword, encryptionMethod, createCloudBackup]);

  const handleRestore = useCallback(async () => {
    if (!auth) return;
    setLoading(true);
    setStatus('Restoring from backup...');
    try {
      const probe = await probeCloudBackup(auth.accessToken);

      if (probe.encryptionMethod === null) {
        setStatus('No backup found');
        return;
      }

      if (probe.encryptionMethod === 'passkey') {
        if (!probe.credentialId || !probe.prfSalt) throw new Error('Backup missing passkey metadata');

        const provider = await getPasskeyProvider();
        if (!provider) throw new Error('Passkeys not available on this platform');

        const credentialId = Uint8Array.from(atob(probe.credentialId), c => c.charCodeAt(0));
        const prfSalt = Uint8Array.from(atob(probe.prfSalt), c => c.charCodeAt(0));
        const { keyMaterial } = await provider.authenticate(credentialId, prfSalt);

        await restoreCloudBackup(auth.accessToken, { method: 'passkey', keyMaterial: toBase64(keyMaterial) });
      } else {
        if (!backupPassword) {
          setStatus('This backup requires a password');
          setLoading(false);
          return;
        }
        await restoreCloudBackup(auth.accessToken, { method: 'password', backupPassword });
      }

      setStatus('Restore completed successfully');
    } catch (err: unknown) {
      setStatus(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [auth, backupPassword, probeCloudBackup, restoreCloudBackup]);

  const backupDisabled = loading || !auth || (encryptionMethod === 'password' && !backupPassword);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold">Cloud Backup (Test)</h2>

      {/* Auth */}
      <Button
        className="w-full justify-center"
        title={auth ? `Signed in: ${auth.email || 'Google'}` : 'Sign in with Google'}
        variant={ButtonVariant.Secondary}
        onClick={handleSignIn}
        disabled={loading}
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

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          className="flex-1 justify-center"
          title={encryptionMethod === 'passkey' ? 'Backup with Passkey' : 'Backup'}
          variant={ButtonVariant.Primary}
          onClick={handleBackup}
          disabled={backupDisabled}
        />
        <Button
          className="flex-1 justify-center"
          title="Restore"
          variant={ButtonVariant.Secondary}
          onClick={handleRestore}
          disabled={!auth || loading}
        />
      </div>

      {/* Status */}
      {status && <p className="text-sm text-gray-500 select-text">{status}</p>}
    </div>
  );
};

export default CloudBackupSettings;
