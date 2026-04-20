import React, { useCallback, useEffect, useMemo } from 'react';

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { useNativeNavbarAction } from 'lib/dapp-browser';
import { useMidenContext } from 'lib/miden/front';
import { deriveKey, encrypt, encryptJson, generateKey, generateSalt } from 'lib/miden/passworder';
import { exportDb } from 'lib/miden/repo';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isMobile } from 'lib/platform';
import { EncryptedWalletFile, ENCRYPTED_WALLET_FILE_PASSWORD_CHECK, DecryptedWalletFile } from 'screens/shared';

export interface ExportFileCompleteProps {
  onGoBack: () => void;
  onDone: () => void;
  filePassword: string;
  fileName: string;
  walletPassword?: string;
}

const EXTENSION = '.json';

const ExportFileComplete: React.FC<ExportFileCompleteProps> = ({ filePassword, fileName, walletPassword, onDone }) => {
  const { t } = useTranslation();
  const { revealMnemonic, accounts } = useMidenContext();

  // Imported accounts (hdIndex < 0) can't be reconstructed from the
  // mnemonic — their auth key is the raw hex the user pasted in. The
  // encrypted-file format doesn't carry raw secrets, so emitting them
  // here would produce an unrestorable account on the other side
  // (`Vault.spawnFromMidenClient` would either throw or fill the
  // keystore with mnemonic-derived garbage). Filter them out so the
  // restore path sees a consistent list; users are told in the
  // changelog and via `Settings → Reveal Private Key` that imported
  // keys need to be backed up separately.
  const exportableAccounts = useMemo(() => accounts.filter(a => a.hdIndex >= 0), [accounts]);
  const omittedImportedCount = accounts.length - exportableAccounts.length;

  const getExportFile = useCallback(async () => {
    // Wrap WASM client operations in a lock to prevent concurrent access
    const midenClientDbDump = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      return midenClient.exportDb();
    });
    const walletDbDump = await exportDb();

    const seedPhrase = await revealMnemonic(walletPassword);

    const filePayload: DecryptedWalletFile = {
      seedPhrase,
      midenClientDbContent: midenClientDbDump as string,
      walletDbContent: walletDbDump,
      accounts: exportableAccounts
    };

    const salt = generateSalt();
    const passKey = await generateKey(filePassword);
    const derivedKey = await deriveKey(passKey, salt);

    const encryptedPayload = await encryptJson(filePayload, derivedKey);
    const encryptedPasswordCheck = await encrypt(ENCRYPTED_WALLET_FILE_PASSWORD_CHECK, derivedKey);
    const encryptedWalletFile: EncryptedWalletFile = {
      dt: encryptedPayload.dt,
      iv: encryptedPayload.iv,
      salt,
      encryptedPasswordCheck
    };

    const fileContent = JSON.stringify(encryptedWalletFile);
    const fullFileName = `${fileName}${EXTENSION}`;

    if (isMobile()) {
      // On mobile, write to cache directory and share
      try {
        const result = await Filesystem.writeFile({
          path: fullFileName,
          data: fileContent,
          directory: Directory.Cache,
          encoding: Encoding.UTF8
        });

        await Share.share({
          title: fullFileName,
          url: result.uri,
          dialogTitle: t('saveEncryptedWalletFile')
        });
      } catch (error) {
        console.error('Failed to export file on mobile:', error);
      }
    } else {
      // On desktop, use standard download approach
      const encoder = new TextEncoder();
      const fileBytes = encoder.encode(fileContent);
      const blob = new Blob([new Uint8Array(fileBytes)], { type: 'application/json' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fullFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }, [walletPassword, filePassword, fileName, revealMnemonic, t, exportableAccounts]);

  useEffect(() => {
    getExportFile();
  }, [getExportFile]);

  useNativeNavbarAction({
    label: t('done'),
    onTap: onDone,
    enabled: true
  });

  return (
    <div className="flex flex-col flex-1 items-center px-4 bg-app-bg">
      <div className="flex flex-col w-full items-center justify-center flex-1 gap-y-2">
        <div className="w-49 aspect-square flex items-center justify-center">
          <Icon name={IconName.Success} size="4xl" />
        </div>
        <div className="flex flex-col items-center max-w-sm text-center text-heading-gray">
          <h1 className="text-[32px] leading-[120%] tracking-[-0.04em]">
            <span className="font-semibold">{t('encryptedWalletFileExportedTitle1')}</span>
            <br />
            <span className="font-medium">{t('encryptedWalletFileExportedTitle2')}</span>
          </h1>
          <div className="pt-6 text-base leading-[130%]">
            <p>{t('encryptedWalletFileExportedDesc1')}</p>
            <p className="font-bold pt-5">{t('encryptedWalletFileExportedDesc2')}</p>
            <p className="pt-5">{t('encryptedWalletFileExportedDesc3')}</p>
            {omittedImportedCount > 0 && (
              <p className="pt-5 text-sm text-red-600">
                {t('encryptedFileImportedAccountsOmitted', { importedCount: String(omittedImportedCount) })}
              </p>
            )}
          </div>
        </div>
      </div>
      {!isMobile() && (
        <div className="w-full pt-8 pb-4">
          <Button
            className="w-full justify-center"
            title={t('done')}
            variant={ButtonVariant.Primary}
            onClick={onDone}
          />
        </div>
      )}
    </div>
  );
};

export default ExportFileComplete;
