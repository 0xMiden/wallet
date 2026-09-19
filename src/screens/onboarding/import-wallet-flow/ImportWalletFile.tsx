import React, { useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField, { PASSWORD_ERROR_CAPTION } from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
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

  const uploadFileComponent = (): JSX.Element => {
    return (
      <button type="button" onClick={onUploadFileClick} className="p-0 bg-transparent border-0 text-blue-500">
        {t('chooseFromDevice')}
      </button>
    );
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
    <form
      className={classNames(
        'flex-1 h-full',
        'flex flex-col justify-content items-center gap-y-2',
        'bg-app-bg text-ink px-4 pt-6',
        className
      )}
      onSubmit={handleSubmit(handleImportSubmit)}
    >
      <h1 className="text-2xl font-semibold">{t('importWallet')}</h1>
      <p className="text-sm text-center mb-6">{t('importWithEncryptedWalletFileDescription')}</p>
      {walletFile == null ? (
        <div
          className={classNames(
            'p-10',
            'flex flex-col items-center gap-y-2 mb-6',
            'border border-dashed border-border-card rounded-2xl',
            isDragging && 'border-blue-500'
          )}
          onDrop={onDropFile}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={e => {
            e.preventDefault();
          }}
        >
          <Icon name={IconName.UploadFile} size="xxl" />
          <p className="text-sm">
            {t('dragAndDropFile')} {uploadFileComponent()}
          </p>
          <p className="text-sm text-text-muted">{t('jsonFileType')}</p>
          <div>
            <input
              style={{ display: 'none' }}
              ref={walletFileRef}
              onChange={onUploadFile}
              type="file"
              accept=".json,application/json"
            />
          </div>
        </div>
      ) : (
        <div
          className={classNames(
            'flex justify-between items-center',
            'bg-surface-solid rounded-2xl',
            'w-full max-w-[360px] py-5 px-3',
            'mx-auto'
          )}
        >
          <div className="flex">
            <Icon name={IconName.UploadedFile} size="md" />
            <div className="flex items-center pl-4">{walletFile.name}</div>
          </div>
          <button type="button" onClick={handleClear} aria-label={t('clear')}>
            <Icon name={IconName.Close} fill="currentColor" size="md" />
          </button>
        </div>
      )}

      {walletFile != null && pendingRestore == null && (
        <div className="flex flex-col w-full max-w-[360px]">
          <p className="text-sm text-ink my-3">{t('enterDecryptionPassword')}</p>
          <FormField
            {...register('password', {
              required: PASSWORD_ERROR_CAPTION
            })}
            label={t('password')}
            id="newwallet-password"
            type="password"
            name="password"
            placeholder="********"
            errorCaption={errorCaption}
            containerClassName="mb-4"
          />
        </div>
      )}

      {pendingRestore != null && (
        <div className="w-full max-w-[360px] mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-500">
          {t('encryptedFileImportedAccountsOmitted', {
            importedCount: String(omittedImportedCount)
          })}
          {importError === 'restore' && <p className="pt-2 font-medium">{t('encryptedWalletFileRestoreFailed')}</p>}
        </div>
      )}

      <div className="mt-auto w-full pt-4">
        <Button
          type="submit"
          isLoading={isSubmitting || isRestoring}
          className="w-full"
          disabled={isSubmitting || isRestoring || (pendingRestore == null && (!isValid || !walletFile))}
        >
          {pendingRestore != null ? t('continueImport') : t('import')}
        </Button>
      </div>
    </form>
  );
};
