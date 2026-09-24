import React, { useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Card } from 'components/ui/Card';
import { IconButton } from 'components/ui/IconButton';
import { Notice } from 'components/ui/Notice';
import { TextAction } from 'components/ui/TextAction';
import { TextField } from 'components/ui/TextField';
import {
  type DecryptedWalletFile,
  isRecord,
  parseDecryptedWalletFile,
  UnsupportedBackupVersionError
} from 'lib/miden/backup-file';
import { decrypt, decryptJson, deriveKey, generateKey } from 'lib/miden/passworder';
import { importDb } from 'lib/miden/repo';
import { assertWasmHoldCurrent, getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { ENCRYPTED_WALLET_FILE_PASSWORD_CHECK, EncryptedWalletFile } from 'screens/shared';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';

/** react-hook-form's message for an empty password: the field is required, not wrong, so no error line. */
const PASSWORD_ERROR_CAPTION = 'PASSWORD_ERROR_CAPTION';

interface FormData {
  password?: string;
}

export interface ImportWalletFileScreenProps {
  className?: string;
  onSubmit?: (payload: DecryptedWalletFile) => void;
}

type WalletFile = Omit<EncryptedWalletFile, 'salt'> & {
  name: string;
  salt: Record<string, number> | number[];
};

type ImportError = 'wrong-password' | 'malformed' | 'unsupported' | 'restore';

// A backup carries two base64 database dumps, so the ceiling is generous; it
// exists to stop an unrelated or hostile file from being decoded and parsed on
// the UI thread, not to bound a legitimate wallet.
const MAX_WALLET_FILE_BYTES = 64 * 1024 * 1024;

const isWalletFile = (value: unknown): value is Omit<WalletFile, 'name'> => {
  if (
    !isRecord(value) ||
    !isRecord(value.encryptedPasswordCheck) ||
    (!isRecord(value.salt) && !Array.isArray(value.salt))
  ) {
    return false;
  }
  const salt = Object.values(value.salt);
  return (
    typeof value.dt === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.encryptedPasswordCheck.dt === 'string' &&
    typeof value.encryptedPasswordCheck.iv === 'string' &&
    salt.length > 0 &&
    salt.every(byte => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)
  );
};

export const ImportWalletFileScreen: React.FC<ImportWalletFileScreenProps> = ({ className, onSubmit }) => {
  const { t } = useTranslation();
  const walletFileRef = useRef<HTMLInputElement>(null);
  // A restore replaces two databases and then advances onboarding, so it owns a
  // generation: clearing the file retires the running restore's claim on both.
  const restoreInFlight = useRef(false);
  const restoreGeneration = useRef(0);
  const [walletFile, setWalletFile] = useState<WalletFile | null>(null);
  const [importError, setImportError] = useState<ImportError>();
  const [isDragging, setIsDragging] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<DecryptedWalletFile | null>(null);
  // The ref decides; this mirrors it for the button, so a restore that is still
  // winding down after a clear reads as busy instead of swallowing the press.
  const [isRestoring, setIsRestoring] = useState(false);

  const {
    watch,
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isValid }
  } = useForm<FormData>({
    mode: 'onChange'
  });

  const filePassword = watch('password') ?? '';

  // Leaving the step retires the running restore for the same reason clearing the
  // file does: the user is no longer asking for it. Without this the run keeps
  // going after the screen unmounts and its onSubmit drags onboarding forward
  // into the restore the user just backed out of.
  useEffect(
    () => () => {
      restoreGeneration.current += 1;
    },
    []
  );

  const handleClear = () => {
    // A restore already running belongs to the file being discarded, so it must
    // stop writing and must not advance onboarding. Its own run clears the
    // in-flight flag when it ends: until then nothing else may write.
    restoreGeneration.current += 1;
    setWalletFile(null);
    setPendingRestore(null);
    setImportError(undefined);
    // The picker fires no change event for an unchanged value, so without this the
    // user cannot re-select the SAME file - which is exactly the retry they make
    // after a mistyped password, and it looks like a frozen screen.
    if (walletFileRef.current) walletFileRef.current.value = '';
  };

  const handleImportSubmit = async () => {
    if (!walletFile || !onSubmit) return;
    // A restore replaces both databases, so a second one must never overlap it:
    // the button is not the only way in, since Enter in the password field
    // submits too.
    if (restoreInFlight.current) return;
    restoreInFlight.current = true;
    setIsRestoring(true);
    // Captured before the first await, so everything this run does afterwards -
    // decrypting, parsing, writing, advancing - belongs to the file that was
    // staged when the user pressed Import.
    const generation = restoreGeneration.current;
    // Every state this run publishes belongs to the file that was staged when the
    // user pressed Import. A cleared file retires the generation, so nothing this
    // run learns afterwards - an error just as much as a successful restore - may
    // land on whatever is staged now.
    const current = () => generation === restoreGeneration.current;

    const importParsedWallet = async (payload: DecryptedWalletFile) => {
      // A discarded file must reach none of the three steps below, so each one
      // is gated immediately before it runs rather than after it finishes.
      const current = () => generation === restoreGeneration.current;
      try {
        setImportError(undefined);
        // The SDK client is single threaded and this replaces the store it has
        // open, so the swap runs under the realm lock and through the interface
        // that owns the store name. Waiting for that lock is the longest window
        // a clear can land in, so the generation is re-read inside it.
        await withWasmClientLock(
          async hold => {
            const midenClient = await getMidenClient();
            assertWasmHoldCurrent(hold, 'in the encrypted-file restore after the client build');
            if (!current()) return;
            await midenClient.importDb(payload.midenClientDbContent);
          },
          { label: 'onboarding-restore-import-store' }
        );
        if (!current()) return;
        await importDb(payload.walletDbContent);
        if (!current()) return;
        onSubmit(payload);
      } catch (error) {
        console.error('Wallet restore failed:', error);
        if (current()) setImportError('restore');
      }
    };

    try {
      if (pendingRestore) {
        await importParsedWallet(pendingRestore);
        return;
      }

      setImportError(undefined);
      let derivedKey: CryptoKey;
      try {
        const passKey = await generateKey(filePassword);
        const saltU8 = new Uint8Array(Object.values(walletFile.salt));
        derivedKey = await deriveKey(passKey, saltU8);
        const decryptedCheck = await decrypt(walletFile.encryptedPasswordCheck, derivedKey);
        if (decryptedCheck !== ENCRYPTED_WALLET_FILE_PASSWORD_CHECK) {
          if (current()) setImportError('wrong-password');
          return;
        }
      } catch (error) {
        console.error('Decryption failed:', error);
        if (current()) setImportError('wrong-password');
        return;
      }

      let decryptedWallet: unknown;
      try {
        decryptedWallet = await decryptJson({ dt: walletFile.dt, iv: walletFile.iv }, derivedKey);
      } catch (error) {
        console.error('Wallet payload decryption failed:', error);
        if (current()) setImportError('malformed');
        return;
      }

      let parsedWallet: DecryptedWalletFile;
      try {
        parsedWallet = parseDecryptedWalletFile(decryptedWallet);
      } catch (error) {
        // The other three failure arms log their cause; a malformed backup is the
        // one a support report is most likely to be about.
        console.error('Wallet file parse failed:', error);
        if (current()) setImportError(error instanceof UnsupportedBackupVersionError ? 'unsupported' : 'malformed');
        return;
      }

      if (!current()) return;

      if (parsedWallet.formatVersion === undefined && (parsedWallet.omittedImportedAccountCount ?? 0) > 0) {
        setPendingRestore(parsedWallet);
        return;
      }

      await importParsedWallet(parsedWallet);
    } finally {
      // Released by the run that took it, so a cleared file does not free the
      // lane while its own writes are still landing.
      restoreInFlight.current = false;
      setIsRestoring(false);
    }
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const onDropFile = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    processFiles(e.dataTransfer.files);
    setIsDragging(false);
  };

  const onUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
    // Same rule on the re-selection path, so picking the same file twice in a row
    // raises an event both times.
    e.target.value = '';
  };

  const processFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.json')) {
        alert(t('encryptedWalletFileJsonOnly'));
        return;
      }

      // Decoding and parsing happen on the UI thread, so a file far larger than
      // any wallet backup is refused before it is read at all.
      if (file.size > MAX_WALLET_FILE_BYTES) {
        alert(t('encryptedWalletFileTooLarge'));
        return;
      }

      const reader = new FileReader();
      // Selecting a file retires whatever came before it, so a slow read cannot
      // stage itself over a newer selection or over a cleared screen.
      restoreGeneration.current += 1;
      const generation = restoreGeneration.current;

      reader.onload = () => {
        if (generation !== restoreGeneration.current) return;
        try {
          const decoder = new TextDecoder();
          const decodedContent = decoder.decode(reader.result as ArrayBuffer);
          const jsonContent: unknown = JSON.parse(decodedContent);
          if (!isWalletFile(jsonContent)) throw new Error('Invalid encrypted wallet file envelope');

          setWalletFile({ ...jsonContent, name: file.name });
          setPendingRestore(null);
          setImportError(undefined);
        } catch (e) {
          console.error(e);
          alert(t('encryptedWalletFileMalformed'));
        }
      };

      reader.onerror = () => {
        // Same retirement rule as onload above: a read the user has superseded or
        // walked away from must not interrupt whatever they are doing now.
        if (generation !== restoreGeneration.current) return;
        alert(t('encryptedWalletFileReadFailed'));
      };

      reader.readAsArrayBuffer(file);
    } else {
      alert(t('encryptedWalletFileSelectOne'));
    }
  };

  const onUploadFileClick = () => {
    walletFileRef.current?.click();
  };

  const errorCaption =
    importError === 'wrong-password'
      ? t('incorrectPassword')
      : importError === 'malformed'
        ? t('encryptedWalletFileMalformed')
        : importError === 'unsupported'
          ? t('encryptedWalletFileUnsupportedVersion')
          : importError === 'restore'
            ? t('encryptedWalletFileRestoreFailed')
            : errors.password?.message;
  const omittedImportedCount =
    pendingRestore?.formatVersion === undefined ? (pendingRestore?.omittedImportedAccountCount ?? 0) : 0;

  return (
    // The form wraps the whole step so the pinned Import button submits it.
    <form className={classNames('flex min-h-0 flex-1 flex-col', className)} onSubmit={handleSubmit(handleImportSubmit)}>
      <OnboardingStepLayout
        data-testid="import-wallet-file"
        title={t('importWallet')}
        description={t('importWithEncryptedWalletFileDescription')}
        footer={
          <Button
            type="submit"
            isLoading={isSubmitting || isRestoring}
            className="max-w-none"
            disabled={isSubmitting || isRestoring || (pendingRestore == null && (!isValid || !walletFile))}
          >
            {pendingRestore != null ? t('continueImport') : t('import')}
          </Button>
        }
      >
        {walletFile == null ? (
          // A drop target on the shared fill, no dashed outline: a file dragged over it rings it.
          <div
            data-testid="wallet-file-dropzone"
            data-dragging={isDragging || undefined}
            className={classNames(
              'flex flex-col items-center gap-2 rounded-2xl bg-fill px-4 py-8 text-center',
              'transition-shadow duration-150 motion-reduce:transition-none',
              isDragging && 'ring-2 ring-accent-primary ring-inset'
            )}
            onDrop={onDropFile}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={e => {
              e.preventDefault();
            }}
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-page text-ink">
              <Icon name={IconName.UploadFile} size="md" fill="currentColor" aria-hidden="true" />
            </span>
            <p className="font-sans text-[15px] leading-[22px] text-ink">{t('dragAndDropFile')}</p>
            <p className="font-sans text-[13px] leading-[17px] text-muted">{t('jsonFileType')}</p>
            <TextAction onClick={onUploadFileClick}>{t('chooseFromDevice')}</TextAction>
            <input
              style={{ display: 'none' }}
              ref={walletFileRef}
              onChange={onUploadFile}
              type="file"
              accept=".json,application/json"
            />
          </div>
        ) : (
          <Card padding="row" className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-page text-ink">
              <Icon name={IconName.UploadedFile} size="sm" fill="currentColor" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 truncate font-heading text-base leading-5 font-bold text-ink">
              {walletFile.name}
            </span>
            <IconButton icon={IconName.Close} label={t('clear')} onClick={handleClear} />
          </Card>
        )}

        {walletFile != null && pendingRestore == null && (
          <TextField
            {...register('password', {
              required: PASSWORD_ERROR_CAPTION
            })}
            label={t('password')}
            hint={t('enterDecryptionPassword')}
            id="newwallet-password"
            type="password"
            // This decrypts a wallet FILE with a password the user chose at export time, so it is
            // the one password field here that wants the manager: `current-password` asks for the
            // stored one, where the component default (`new-password`, which suppresses the
            // manager on vault secrets) would offer to generate a password that already exists.
            autoComplete="current-password"
            placeholder="********"
            error={errorCaption && errorCaption !== PASSWORD_ERROR_CAPTION ? errorCaption : undefined}
          />
        )}

        {pendingRestore != null && (
          <Notice tone="negative" role="alert">
            <span className="flex flex-col gap-2">
              <span>
                {t('encryptedFileImportedAccountsOmitted', {
                  importedCount: String(omittedImportedCount)
                })}
              </span>
              {importError === 'restore' && <span className="font-bold">{t('encryptedWalletFileRestoreFailed')}</span>}
            </span>
          </Notice>
        )}
      </OnboardingStepLayout>
    </form>
  );
};
