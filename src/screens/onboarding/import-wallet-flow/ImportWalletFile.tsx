import React, { useRef, useState } from 'react';

import classNames from 'clsx';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import FormField, { PASSWORD_ERROR_CAPTION } from 'app/atoms/FormField';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { Icon, IconName } from 'app/icons/v2';
import { decrypt, decryptJson, deriveKey, generateKey } from 'lib/miden/passworder';
import { importDb } from 'lib/miden/repo';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { DecryptedWalletFile, ENCRYPTED_WALLET_FILE_PASSWORD_CHECK, EncryptedWalletFile } from 'screens/shared';

interface FormData {
  password?: string;
}

export interface ImportWalletFileScreenProps {
  className?: string;
  onSubmit?: (seedPhrase: string) => void;
}

type WalletFile = EncryptedWalletFile & {
  name: string;
};

// TODO: This needs to move forward in the onboarding steps, likely needs some sort of next thing feature
export const ImportWalletFileScreen: React.FC<ImportWalletFileScreenProps> = ({ className, onSubmit }) => {
  const { t } = useTranslation();
  const walletFileRef = useRef<HTMLInputElement>(null);
  const [walletFile, setWalletFile] = useState<WalletFile | null>(null);
  const [isWrongPassword, setIsWrongPassword] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

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
  };

  const handleImportSubmit = async () => {
    if (!walletFile || !onSubmit) return;

    try {
      const passKey = await generateKey(filePassword);
      const saltByteArray = Object.values(walletFile.salt) as number[];
      const saltU8 = new Uint8Array(saltByteArray);
      const derivedKey = await deriveKey(passKey, saltU8);

      // First, try decrypting `encryptedPasswordCheck`
      const decryptedCheck = await decrypt(walletFile.encryptedPasswordCheck, derivedKey);

      if (decryptedCheck !== ENCRYPTED_WALLET_FILE_PASSWORD_CHECK) {
        setIsWrongPassword(true); // Show error div
        return;
      }

      // Reset wrong password error if it was previously set
      setIsWrongPassword(false);

      // Proceed with full decryption
      const decryptedWallet: DecryptedWalletFile = await decryptJson(
        { dt: walletFile.dt, iv: walletFile.iv },
        derivedKey
      );
      const midenClientDbContent = decryptedWallet.midenClientDbContent;
      const walletDbContent = decryptedWallet.walletDbContent;
      const seedPhrase = decryptedWallet.seedPhrase;

      // Wrap WASM client operations in a lock to prevent concurrent access
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient();
        await midenClient.importDb(midenClientDbContent);
      });
      await importDb(walletDbContent);

      onSubmit(seedPhrase);
    } catch (error) {
      console.error('Decryption failed:', error);
      setIsWrongPassword(true); // Ensure error appears in case of failure
    }
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return; // Ignore if the drag is over a childelement
    setIsDragging(false);
  };

  const onDropFile = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    processFiles(e.dataTransfer.files);
    setIsDragging(false);
  };

  const onUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    // TODO error modals/alerts
    processFiles(e.target.files);
  };

  const processFiles = (files: FileList | null) => {
    if (files && files.length) {
      const file = files[0];
      const parts = file.name.split('.');
      const fileType = parts[parts.length - 1];
      const reader = new FileReader();

      if (fileType !== 'json') {
        alert('File type must be .json');
        return;
      }

      reader.onload = () => {
        try {
          const decoder = new TextDecoder();
          const decodedContent = decoder.decode(reader.result as ArrayBuffer);
          const jsonContent = JSON.parse(decodedContent);

          setWalletFile({ ...jsonContent, name: file.name });
        } catch (e) {
          console.error(e);
          alert('Invalid JSON file');
        }
      };

      reader.onerror = () => {
        alert('Error with file reader');
      };

      reader.readAsArrayBuffer(file);
    } else {
      alert('Select 1 file');
      return;
    }
  };

  const uploadFileComponent = (): JSX.Element => {
    return (
      <span onClick={onUploadFileClick} className="cursor-pointer text-blue-500">
        {t('chooseFromDevice')}
      </span>
    );
  };

  const onUploadFileClick = () => {
    if (walletFileRef != null && walletFileRef.current != null) {
      walletFileRef.current.click();
    }
  };

  return (
    <form
      className={classNames(
        'flex-1 h-full',
        'flex flex-col justify-content items-center gap-y-2',
        'bg-white p-6',
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
            'border border-dashed border-grey-200 rounded-2xl',
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
          <p className="text-sm text-gray-200">{t('jsonFileType')}</p>
          <div>
            <input style={{ display: 'none' }} ref={walletFileRef} onChange={onUploadFile} type="file" />
          </div>
        </div>
      ) : (
        <div
          className={classNames(
            'flex justify-between items-center',
            'bg-grey-25 rounded-2xl',
            'w-[360px] py-5 px-3',
            'mx-auto'
          )}
        >
          <div className="flex">
            <Icon name={IconName.UploadedFile} size="md" />
            <div className="flex items-center pl-4">{walletFile.name}</div>
          </div>
          <button type="button" onClick={handleClear}>
            <Icon name={IconName.Close} fill="black" size="md" />
          </button>
        </div>
      )}

      {walletFile != null && (
        <div className="flex flex-col w-[360px]">
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
            // TODO: Determine error caption? Could also be "the import fucked up"-type error
            errorCaption={isWrongPassword ? 'Wrong password' : errors.password?.message}
            containerClassName="mb-4"
          />
        </div>
      )}

      <div className="mt-auto pb-8 w-full">
        <FormSubmitButton
          loading={isSubmitting}
          className="w-full text-base"
          style={{ display: 'block', fontWeight: 500, padding: '12px 0px' }}
          disabled={!isValid || !walletFile}
        >
          {t('import')}
        </FormSubmitButton>
      </div>
    </form>
  );
};
