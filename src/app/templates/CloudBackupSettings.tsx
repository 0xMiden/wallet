import React, { FC, useCallback, useState } from 'react';

import { Button, ButtonVariant } from 'components/Button';
import { useMidenContext } from 'lib/miden/front';

import { getGoogleAuthToken, GoogleAuthResult } from '../../lib/miden/backup/google-drive-auth';

const CloudBackupSettings: FC<{ onClose?: () => void }> = () => {
  const { createCloudBackup, restoreCloudBackup } = useMidenContext();

  const [auth, setAuth] = useState<GoogleAuthResult | null>(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = useCallback(async () => {
    setLoading(true);
    setStatus('Signing in...');
    try {
      const result = await getGoogleAuthToken();
      setAuth(result);
      setStatus(`Signed in as ${result.email || result.displayName || 'unknown'}`);
    } catch (err: any) {
      setStatus(`Sign-in failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleBackup = useCallback(async () => {
    if (!auth || !backupPassword) return;
    setLoading(true);
    setStatus('Creating backup...');
    try {
      await createCloudBackup(auth.accessToken, backupPassword);
      setStatus('Backup uploaded successfully');
    } catch (err: any) {
      setStatus(`Backup failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [auth, backupPassword, createCloudBackup]);

  const handleRestore = useCallback(async () => {
    if (!auth || !backupPassword) return;
    setLoading(true);
    setStatus('Restoring from backup...');
    try {
      await restoreCloudBackup(auth.accessToken, backupPassword);
      setStatus('Restore completed successfully');
    } catch (err: any) {
      setStatus(`Restore failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [auth, backupPassword, restoreCloudBackup]);

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

      {/* Password */}
      <input
        type="password"
        placeholder="Backup password"
        value={backupPassword}
        onChange={e => setBackupPassword(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />

      {/* Actions */}
      <div className="flex gap-2">
        <Button
          className="flex-1 justify-center"
          title="Backup"
          variant={ButtonVariant.Primary}
          onClick={handleBackup}
          disabled={!auth || !backupPassword || loading}
        />
        <Button
          className="flex-1 justify-center"
          title="Restore"
          variant={ButtonVariant.Secondary}
          onClick={handleRestore}
          disabled={!auth || !backupPassword || loading}
        />
      </div>

      {/* Status */}
      {status && <p className="text-sm text-gray-500 select-text">{status}</p>}
    </div>
  );
};

export default CloudBackupSettings;
