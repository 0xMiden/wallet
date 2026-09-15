import React, { FC, useCallback, useEffect, useState } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Buffer } from 'buffer';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import FormField from 'app/atoms/FormField';
import AccountBanner from 'app/templates/AccountBanner';
import { Button, ButtonVariant } from 'components/Button';
import { PasscodeEntry } from 'components/PasscodeEntry';
import { Vault } from 'lib/miden/back/vault';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { hapticMedium } from 'lib/mobile/haptics';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { isMobile } from 'lib/platform';

async function saveAccountFile(bytes: Uint8Array, fileName: string, dialogTitle: string): Promise<void> {
  if (isMobile()) {
    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: Buffer.from(bytes).toString('base64'),
      directory: Directory.Cache
    });
    try {
      await Share.share({ title: fileName, files: [uri], dialogTitle });
    } finally {
      await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache });
    }
    return;
  }

  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const ExportAccountFile: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const { exportAccountFile } = useMidenContext();
  const [hasHardwareProtector, setHasHardwareProtector] = useState<boolean | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const usePasscodeEntry = isMobile() && hasHardwareProtector === false;
  useHideDappBubblesWhileOpen(true);

  useEffect(() => {
    Vault.hasHardwareProtector().then(setHasHardwareProtector);
  }, []);

  const runExport = useCallback(
    async (stepUpSecret?: string) => {
      if (isExporting || !acknowledged) return;
      setIsExporting(true);
      setError(null);
      setSaved(false);
      try {
        const bytes = await exportAccountFile(account.publicKey, stepUpSecret);
        const accountId = account.publicKey.split('_')[0] ?? account.publicKey;
        await saveAccountFile(bytes, `${accountId}.mac`, t('saveAccountFile'));
        setSaved(true);
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setIsExporting(false);
      }
    },
    [account.publicKey, acknowledged, exportAccountFile, isExporting, t]
  );

  if (hasHardwareProtector === null) return null;

  return (
    <div className="w-full max-w-sm mx-auto flex flex-col flex-1 min-h-0">
      <AccountBanner account={account} className="mb-6 text-heading-gray" />

      <Alert
        type="warn"
        title={t('exportAccountFileWarningTitle')}
        description={<p>{t('exportAccountFileWarningBody')}</p>}
        className="mb-4 rounded-lg"
      />

      <label className="mb-6 flex items-start gap-2 text-sm text-black cursor-pointer select-none">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={acknowledged}
          onChange={event => {
            hapticMedium();
            setAcknowledged(event.target.checked);
          }}
        />
        <span>{t('exportAccountFileAcknowledge')}</span>
      </label>

      {error && <Alert type="error" title={t('error')} description={error} className="mb-4 rounded-lg text-black" />}
      {saved && <Alert type="success" description={t('accountFileExportSuccess')} className="mb-4 rounded-lg" />}

      {hasHardwareProtector ? (
        <p className="text-sm text-heading-gray">{t('exportAccountFileHardwareDescription')}</p>
      ) : usePasscodeEntry ? (
        <PasscodeEntry
          onSubmit={code => runExport(code)}
          onChange={() => setError(null)}
          error={error}
          subtitle={t('exportAccountFilePasscodeDescription')}
          disabled={!acknowledged}
          isSubmitting={isExporting}
        />
      ) : (
        <FormField
          label={t('password')}
          labelDescription={t('exportAccountFilePasswordDescription')}
          id="export-account-file-password"
          name="password"
          type="password"
          value={password}
          onChange={event => {
            setPassword(event.target.value);
            setError(null);
          }}
          containerClassName="mb-4"
        />
      )}

      {!usePasscodeEntry && (
        <div className="mt-auto pb-8 pt-6">
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Primary}
            title={t('saveAccountFile')}
            disabled={isExporting || !acknowledged || (hasHardwareProtector === false && password.length === 0)}
            isLoading={isExporting}
            onClick={() => runExport(hasHardwareProtector ? undefined : password)}
          />
        </div>
      )}
    </div>
  );
};

export default ExportAccountFile;
