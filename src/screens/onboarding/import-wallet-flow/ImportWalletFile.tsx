import React, { useRef, useState } from 'react';

import { useImportStore } from '@miden-sdk/react/lazy';
import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField, { PASSWORD_ERROR_CAPTION } from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { Icon, IconName } from 'app/icons/v2';
import {
  type DecryptedWalletFile,
  parseDecryptedWalletFile,
  UnsupportedBackupVersionError
} from 'lib/miden/backup-file';
import { decrypt, decryptJson, deriveKey, generateKey } from 'lib/miden/passworder';
import { importDb } from 'lib/miden/repo';
import { getMidenClient } from 'lib/miden/sdk/miden-client';
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  const { importStore } = useImportStore();
  const walletFileRef = useRef<HTMLInputElement>(null);
  const [walletFile, setWalletFile] = useState<WalletFile | null>(null);
  const [importError, setImportError] = useState<ImportError>();
  const [isDragging, setIsDragging] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<DecryptedWalletFile | null>(null);

  const {
    watch,
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isValid }
  } = useForm<FormData>({
    mode: 'onChange'
  });

  const filePassword = watch('password') ?? '';

  const handleClear = () => {
    setWalletFile(null);
    setPendingRestore(null);
    setImportError(undefined);
  };

  const handleImportSubmit = async () => {
    if (!walletFile || !onSubmit) return;

    const importParsedWallet = async (payload: DecryptedWalletFile) => {
      try {
        setImportError(undefined);
        const storeName = await (await getMidenClient()).client.storeIdentifier();
        await importStore(payload.midenClientDbContent, storeName);
        await importDb(payload.walletDbContent);
        onSubmit(payload);
      } catch (error) {
        console.error('Wallet restore failed:', error);
        setImportError('restore');
      }
    };

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
        setImportError('wrong-password');
        return;
      }
    } catch (error) {
      console.error('Decryption failed:', error);
      setImportError('wrong-password');
      return;
    }

    let decryptedWallet: unknown;
    try {
      decryptedWallet = await decryptJson({ dt: walletFile.dt, iv: walletFile.iv }, derivedKey);
    } catch (error) {
      console.error('Wallet payload decryption failed:', error);
      setImportError('malformed');
      return;
    }

    let parsedWallet: DecryptedWalletFile;
    try {
      parsedWallet = parseDecryptedWalletFile(decryptedWallet);
    } catch (error) {
      setImportError(error instanceof UnsupportedBackupVersionError ? 'unsupported' : 'malformed');
      return;
    }

    if (parsedWallet.formatVersion === undefined && (parsedWallet.omittedImportedAccountCount ?? 0) > 0) {
      setPendingRestore(parsedWallet);
      return;
    }

    await importParsedWallet(parsedWallet);
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
  };

  const processFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) {
      const reader = new FileReader();

      if (!file.name.toLowerCase().endsWith('.json')) {
        alert(t('encryptedWalletFileJsonOnly'));
        return;
      }

      reader.onload = () => {
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
        alert(t('encryptedWalletFileReadFailed'));
      };

      reader.readAsArrayBuffer(file);
    } else {
      alert(t('encryptedWalletFileSelectOne'));
      return;
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
    if (walletFileRef != null && walletFileRef.current != null) {
      walletFileRef.current.click();
    }
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
        'bg-app-bg text-heading-gray px-4 pt-6',
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
          <p className="text-sm text-black my-3">{t('enterDecryptionPassword')}</p>
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
        <FormSubmitButton
          loading={isSubmitting}
          className="w-full text-base"
          style={{ display: 'block', fontWeight: 500, padding: '12px 0px' }}
          disabled={pendingRestore != null ? false : !isValid || !walletFile}
        >
          {pendingRestore != null ? t('continueImport') : t('import')}
        </FormSubmitButton>
      </div>
    </form>
  );
};
