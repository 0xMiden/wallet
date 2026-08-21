import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
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

/**
 * The user dismissed the share sheet. The encrypted file exists at `uri`; only
 * delivery was declined, so this is recoverable by re-opening the sheet rather
 * than re-running the whole export.
 */
class ShareCancelledError extends Error {
  constructor(readonly uri: string) {
    super('Share cancelled');
    this.name = 'ShareCancelledError';
  }
}

/**
 * Capacitor reports a dismissed sheet as a plain rejection with this message on
 * both platforms — there is no code or typed error to key off, so the message is
 * the only available signal. Matched loosely (the platforms spell it "canceled")
 * and deliberately fail-safe: an unrecognised error stays a hard failure.
 */
const isShareCancellation = (error: unknown): boolean => error instanceof Error && /cancell?ed/i.test(error.message);

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
      accounts: exportableAccounts,
      omittedImportedAccountCount: omittedImportedCount
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
      // Set once the encrypted file is on disk, so the cancel path below can
      // distinguish "never written" from "written but not delivered".
      let writtenUri: string | undefined;
      // On mobile, write to cache directory and share
      try {
        const result = await Filesystem.writeFile({
          path: fullFileName,
          data: fileContent,
          directory: Directory.Cache,
          encoding: Encoding.UTF8
        });
        writtenUri = result.uri;

        await Share.share({
          title: fullFileName,
          url: result.uri,
          dialogTitle: t('saveEncryptedWalletFile')
        });
      } catch (error) {
        // Rethrow: on mobile the share sheet IS the delivery — the cache file is
        // not reachable by the user — so swallowing this reports a backup that
        // does not exist anywhere they can find it.
        //
        // Dismissing the sheet rejects too ("Share canceled" — SharePlugin.swift
        // on `completed == false`, SharePlugin.java on RESULT_CANCELED), and that
        // is NOT the same event: the file encrypted and wrote fine, the user just
        // declined this destination. Distinguish it so the screen can offer the
        // sheet again instead of claiming nothing was saved and making them redo
        // the password.
        console.error('Failed to export file on mobile:', error);
        throw writtenUri !== undefined && isShareCancellation(error) ? new ShareCancelledError(writtenUri) : error;
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
  }, [walletPassword, filePassword, fileName, revealMnemonic, t, exportableAccounts, omittedImportedCount]);

  // "Exported!" is a claim about a file on disk, so it waits for the write to
  // actually land. Rendering it on mount — as this screen used to — tells the
  // user a backup exists while the export is still running, and keeps telling
  // them so if it then fails: the one thing a backup flow must never do.
  const [exportState, setExportState] = useState<'pending' | 'success' | 'error' | 'cancelled'>('pending');
  // Set only on the cancelled path, where the encrypted file is already written
  // and re-sharing it costs nothing beyond re-opening the sheet.
  const sharedFileUriRef = useRef<string | undefined>(undefined);

  // Exactly once per mount. `getExportFile` is a `useCallback` over values that
  // include `exportableAccounts` — a `useMemo` over the context's `accounts` —
  // so its identity is only as stable as that array's. Any re-render that
  // reseats it would otherwise re-run the WHOLE export: re-derive the mnemonic,
  // re-encrypt, and on mobile open a second share sheet for a file the user was
  // already handed. The state update below makes such a re-render certain.
  const exportStartedRef = useRef(false);
  // Tracks the COMPONENT, not the effect run. Scoping it per-effect deadlocks
  // the screen: if `getExportFile`'s identity changes while the export is in
  // flight, that run's cleanup marks it cancelled, the replacement run returns
  // early on the ref above, and the still-pending promise is then forbidden from
  // reporting — leaving "Creating your wallet file…" on screen forever.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (exportStartedRef.current) return;
    exportStartedRef.current = true;

    getExportFile().then(
      () => {
        if (mountedRef.current) setExportState('success');
      },
      (error: unknown) => {
        console.error('Failed to export encrypted wallet file:', error);
        if (!mountedRef.current) return;
        if (error instanceof ShareCancelledError) {
          sharedFileUriRef.current = error.uri;
          setExportState('cancelled');
          return;
        }
        setExportState('error');
      }
    );
  }, [getExportFile]);

  // Re-opens the sheet for the file already on disk. Deliberately does NOT
  // re-run `getExportFile`: the mnemonic reveal, key derivation and encryption
  // all succeeded, and repeating them would make the user re-enter nothing while
  // doing every expensive and sensitive step a second time.
  const handleShareAgain = useCallback(async () => {
    const uri = sharedFileUriRef.current;
    if (uri === undefined) return;
    setExportState('pending');
    try {
      await Share.share({ title: `${fileName}${EXTENSION}`, url: uri, dialogTitle: t('saveEncryptedWalletFile') });
      if (mountedRef.current) setExportState('success');
    } catch (error) {
      console.error('Failed to re-share encrypted wallet file:', error);
      if (!mountedRef.current) return;
      setExportState(isShareCancellation(error) ? 'cancelled' : 'error');
    }
  }, [fileName, t]);

  if (exportState === 'pending') {
    return (
      <div className="flex flex-col flex-1 items-center px-4 bg-app-bg">
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col w-full items-center justify-center flex-1 gap-y-4"
        >
          <ActivitySpinner />
          <p className="text-base text-heading-gray">{t('encryptedWalletFileExporting')}</p>
        </div>
      </div>
    );
  }

  // Not a failure: the file encrypted and wrote fine, the user just declined the
  // destination. Saying "nothing was saved" here would be false, and sending them
  // back through the flow would make them re-enter the file password to redo work
  // that already succeeded.
  if (exportState === 'cancelled') {
    return (
      <div className="flex flex-col flex-1 items-center px-4 bg-app-bg">
        <div className="flex flex-col w-full items-center justify-center flex-1 gap-y-2">
          <div className="w-49 aspect-square flex items-center justify-center">
            {/* Self-coloured brand glyph — no `fill`/`text-*` needed, unlike `Close`. */}
            <Icon name={IconName.Share} size="4xl" />
          </div>
          <div className="flex flex-col items-center max-w-sm text-center text-heading-gray">
            <h1 className="text-[32px] leading-[120%] tracking-[-0.04em] font-semibold">
              {t('encryptedWalletFileNotSavedTitle')}
            </h1>
            <p className="pt-6 text-base leading-[130%]">{t('encryptedWalletFileNotSavedDesc')}</p>
          </div>
        </div>
        <div className="w-full pt-8 pb-4 flex flex-col gap-y-3">
          <Button
            className="w-full justify-center"
            title={t('encryptedWalletFileSaveAgain')}
            variant={ButtonVariant.Primary}
            onClick={handleShareAgain}
          />
          <Button
            className="w-full justify-center"
            title={t('done')}
            variant={ButtonVariant.Secondary}
            onClick={onDone}
          />
        </div>
      </div>
    );
  }

  if (exportState === 'error') {
    return (
      <div className="flex flex-col flex-1 items-center px-4 bg-app-bg">
        <div className="flex flex-col w-full items-center justify-center flex-1 gap-y-2">
          <div className="w-49 aspect-square flex items-center justify-center">
            {/* `close.svg` is `fill="none"` with an unfilled path, so a `text-*`
                class alone renders nothing — the fill has to be passed through. */}
            <Icon name={IconName.Close} size="4xl" fill="currentColor" className="text-status-negative" />
          </div>
          <div role="alert" className="flex flex-col items-center max-w-sm text-center text-heading-gray">
            <h1 className="text-[32px] leading-[120%] tracking-[-0.04em] font-semibold">
              {t('encryptedWalletFileExportFailedTitle')}
            </h1>
            <p className="pt-6 text-base leading-[130%] select-text">{t('encryptedWalletFileExportFailedDesc')}</p>
          </div>
        </div>
        <div className="w-full pt-8 pb-4">
          <Button
            className="w-full justify-center"
            title={t('done')}
            variant={ButtonVariant.Primary}
            onClick={onDone}
          />
        </div>
      </div>
    );
  }

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
      <div className="w-full pt-8 pb-4">
        <Button className="w-full justify-center" title={t('done')} variant={ButtonVariant.Primary} onClick={onDone} />
      </div>
    </div>
  );
};

export default ExportFileComplete;
