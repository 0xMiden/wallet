import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Hero } from 'components/ui/Hero';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { CURRENT_BACKUP_FORMAT_VERSION, parseImportedAccountBackupFailure } from 'lib/miden/backup-file';
import { useMidenContext } from 'lib/miden/front';
import { deriveKey, encrypt, encryptJson, generateKey, generateSalt } from 'lib/miden/passworder';
import { isShareCancellation } from 'lib/mobile/share-cancellation';
import { isMobile } from 'lib/platform';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
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

class BackupSnapshotError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = 'BackupSnapshotError';
  }
}

const ExportFileComplete: React.FC<ExportFileCompleteProps> = ({ filePassword, fileName, walletPassword, onDone }) => {
  const { t } = useTranslation();
  const { exportWalletBackupMaterial } = useMidenContext();

  const getExportFile = useCallback(async () => {
    const backupMaterial = await exportWalletBackupMaterial(walletPassword).catch(error => {
      // A backend message is never shown: it is untranslated and can carry
      // internal detail. Only the one failure the user can act on is named, and
      // it travels as a code plus the account name.
      // The cause never reaches the user, but it is the only thing that says why
      // an export refused to run, so it is logged before it is replaced.
      console.error('Encrypted wallet file snapshot failed:', error);
      const accountName = error instanceof Error ? parseImportedAccountBackupFailure(error.message) : null;
      throw new BackupSnapshotError(
        accountName
          ? t('encryptedWalletFileExportFailedAccount', { accountName })
          : t('encryptedWalletFileExportFailedDesc')
      );
    });
    // The accounts and the miden-client dump come from the backend's one
    // serialized turn, so they cannot describe two different wallets. The wallet
    // transaction dump is taken after that turn on purpose: it is display history
    // and nothing in the restore checks it against the accounts.
    const filePayload: DecryptedWalletFile = {
      ...backupMaterial,
      formatVersion: CURRENT_BACKUP_FORMAT_VERSION
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
  }, [walletPassword, filePassword, fileName, exportWalletBackupMaterial, t]);

  // "Exported!" is a claim about a file on disk, so it waits for the write to
  // actually land. Rendering it on mount — as this screen used to — tells the
  // user a backup exists while the export is still running, and keeps telling
  // them so if it then fails: the one thing a backup flow must never do.
  const [exportState, setExportState] = useState<'pending' | 'success' | 'error' | 'cancelled'>('pending');
  const [exportFailureMessage, setExportFailureMessage] = useState<string>();
  // Set only on the cancelled path, where the encrypted file is already written
  // and re-sharing it costs nothing beyond re-opening the sheet.
  const sharedFileUriRef = useRef<string | undefined>(undefined);

  // Exactly once per mount. A changed context callback must not re-run the
  // export and open a second mobile share sheet for the same screen.
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
        setExportFailureMessage(error instanceof BackupSnapshotError ? error.publicMessage : undefined);
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

  const actionButton = 'flex-1 max-w-none';

  if (exportState === 'pending') {
    return (
      <SubPageLayout data-testid="export-file-complete">
        <div role="status" aria-live="polite" className="flex flex-1 flex-col items-center justify-center">
          <Hero
            visual={<TransactionHeroIcon state="processing" />}
            subtitle={t('encryptedWalletFileExporting')}
            data-testid="export-outcome"
          />
        </div>
      </SubPageLayout>
    );
  }

  // Not a failure: the file encrypted and wrote fine, the user just declined the
  // destination. Saying "nothing was saved" here would be false, and sending them
  // back through the flow would make them re-enter the file password to redo work
  // that already succeeded.
  if (exportState === 'cancelled') {
    return (
      <SubPageLayout
        data-testid="export-file-complete"
        footerLayout="stack"
        footer={
          <>
            <Button
              className={actionButton}
              title={t('encryptedWalletFileSaveAgain')}
              variant={ButtonVariant.Primary}
              onClick={handleShareAgain}
            />
            <Button className={actionButton} title={t('done')} variant={ButtonVariant.Secondary} onClick={onDone} />
          </>
        }
      >
        <OutcomeHero
          visual={
            <div className="flex size-16 items-center justify-center rounded-full bg-fill">
              {/* The glyph paints in `currentColor`, so the brand orange is set here. */}
              <Icon name={IconName.Share} size="md" className="text-accent-primary" />
            </div>
          }
          title={t('encryptedWalletFileNotSavedTitle')}
        >
          <p>{t('encryptedWalletFileNotSavedDesc')}</p>
        </OutcomeHero>
      </SubPageLayout>
    );
  }

  if (exportState === 'error') {
    return (
      <SubPageLayout
        data-testid="export-file-complete"
        footer={<Button className={actionButton} title={t('done')} variant={ButtonVariant.Primary} onClick={onDone} />}
      >
        <div role="alert" className="flex flex-1 flex-col">
          <OutcomeHero
            visual={<TransactionHeroIcon state="failed" />}
            title={t('encryptedWalletFileExportFailedTitle')}
          >
            <p className="select-text">{exportFailureMessage ?? t('encryptedWalletFileExportFailedDesc')}</p>
          </OutcomeHero>
        </div>
      </SubPageLayout>
    );
  }

  return (
    <SubPageLayout
      data-testid="export-file-complete"
      footer={<Button className={actionButton} title={t('done')} variant={ButtonVariant.Primary} onClick={onDone} />}
    >
      <OutcomeHero
        visual={<TransactionHeroIcon state="success" />}
        title={
          <>
            <span>{t('encryptedWalletFileExportedTitle1')}</span>
            <br />
            <span>{t('encryptedWalletFileExportedTitle2')}</span>
          </>
        }
      >
        <p>{t('encryptedWalletFileExportedDesc1')}</p>
        <p className="font-bold text-ink">{t('encryptedWalletFileExportedDesc2')}</p>
        <p>{t('encryptedWalletFileExportedDesc3')}</p>
      </OutcomeHero>
    </SubPageLayout>
  );
};

/**
 * An export outcome: the shared Hero (the 64px status circle every transaction outcome uses and a
 * 24px title), centred in the body, then its explanation in 14px `muted`.
 */
const OutcomeHero: React.FC<{ visual: React.ReactNode; title: React.ReactNode; children: React.ReactNode }> = ({
  visual,
  title,
  children
}) => (
  <div className="flex flex-1 flex-col items-center justify-center" data-testid="export-outcome">
    <Hero visual={visual} name={title} />
    <div className="mt-3 flex max-w-sm flex-col gap-3 text-center text-body-sm text-muted">{children}</div>
  </div>
);

export default ExportFileComplete;
