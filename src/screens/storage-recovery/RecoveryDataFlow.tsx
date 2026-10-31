import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { StrictActionAuthentication } from 'components/StrictActionAuthentication';
import { Button, ButtonVariant } from 'components/ui/Button';
import { ErrorLine } from 'components/ui/ErrorLine';
import { SubPageHeaderProvider, SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import type { StrictAuthenticationResult } from 'lib/auth/strict-action-authentication';
import { useMidenContext } from 'lib/miden/front';
import { RECOVERY_DATA_FILE_MAX_BYTES } from 'lib/miden/recovery/external-file';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import type { UserErrorId } from 'lib/telemetry/user-visible-error';
import ExportFileComplete from 'screens/encrypted-file-flow/ExportFileComplete';
import ExportFilePassword from 'screens/encrypted-file-flow/ExportFileSetNamePassword';

export interface RecoveryDataFlowProps {
  mode: 'export' | 'import';
  onClose: () => void;
}

type FileErrorKey = Extract<
  UserErrorId,
  | 'recoveryDataWrongPassword'
  | 'recoveryDataMalformed'
  | 'recoveryDataVersion'
  | 'recoveryDataSize'
  | 'recoveryDataNetwork'
  | 'recoveryDataReadFailed'
  | 'recoveryDataAccount'
  | 'recoveryDataUnavailable'
>;

function fileError(error: unknown): FileErrorKey | undefined {
  if (error instanceof Error && (error.name === 'StorageUnavailableError' || error.name === 'StorageContinuityError'))
    return 'recoveryDataUnavailable';
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'RecoveryDataFile:password':
      return 'recoveryDataWrongPassword';
    case 'RecoveryDataFile:malformed':
      return 'recoveryDataMalformed';
    case 'RecoveryDataFile:version':
      return 'recoveryDataVersion';
    case 'RecoveryDataFile:size':
      return 'recoveryDataSize';
    case 'RecoveryDataFile:network':
      return 'recoveryDataNetwork';
    case 'RecoveryDataFile:account':
      return 'recoveryDataAccount';
    case 'RecoveryDataFile:unavailable':
      return 'recoveryDataUnavailable';
    default:
      return undefined;
  }
}

export const RecoveryDataFlow: React.FC<RecoveryDataFlowProps> = ({ mode, onClose }) => {
  const { t } = useTranslation();
  const { storageAvailability, exportRecoveryDataFile, importRecoveryDataFile, cancelRecoveryDataOperation } =
    useMidenContext();
  const epoch = storageAvailability?.status === 'pending' ? undefined : storageAvailability?.epoch;
  const [phase, setPhase] = useState<'form' | 'authenticate' | 'delivery' | 'imported'>('form');
  const [filePassword, setFilePassword] = useState('');
  const [fileName, setFileName] = useState(() => t('recoveryDataDefaultFileName'));
  const [content, setContent] = useState<string>();
  const [preparedContent, setPreparedContent] = useState<string>();
  const [file, setFile] = useState<File>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<FileErrorKey>();
  const generation = useRef(0);
  const mounted = useRef(false);
  const reader = useRef<FileReader>();
  const operation = useRef<string>();

  const retire = useCallback(() => {
    generation.current++;
    const previous = reader.current;
    reader.current = undefined;
    previous?.abort();
    const id = operation.current;
    operation.current = undefined;
    if (id) void cancelRecoveryDataOperation(id).catch(() => undefined);
  }, [cancelRecoveryDataOperation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      retire();
    };
  }, [retire]);

  const close = useCallback(() => {
    retire();
    setFilePassword('');
    onClose();
  }, [onClose, retire]);

  const back = useCallback(() => {
    if (phase === 'form' || phase === 'imported' || phase === 'delivery') {
      close();
    } else {
      retire();
      setPhase('form');
    }
  }, [close, phase, retire]);

  useMobileBackHandler(() => {
    back();
    return true;
  }, [back]);

  const clearFile = useCallback(() => {
    retire();
    setFile(undefined);
    setContent(undefined);
    setReading(false);
    setError(undefined);
    setPhase('form');
  }, [retire]);

  const selectFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const selected = event.target.files?.[0];
      event.target.value = '';
      clearFile();
      if (!selected) return;
      setFile(selected);
      if (selected.size > RECOVERY_DATA_FILE_MAX_BYTES) {
        setError('recoveryDataSize');
        return;
      }
      const owner = generation.current;
      const next = new FileReader();
      reader.current = next;
      setReading(true);
      const current = () => mounted.current && generation.current === owner && reader.current === next;
      next.onload = () => {
        if (!current()) return;
        reader.current = undefined;
        setReading(false);
        if (typeof next.result !== 'string') {
          setError('recoveryDataMalformed');
        } else if (new TextEncoder().encode(next.result).byteLength > RECOVERY_DATA_FILE_MAX_BYTES) {
          setError('recoveryDataSize');
        } else {
          setContent(next.result);
        }
      };
      next.onerror = () => {
        if (!current()) return;
        reader.current = undefined;
        setReading(false);
        setError('recoveryDataReadFailed');
      };
      next.readAsText(selected);
    },
    [clearFile]
  );

  const perform = useCallback(
    async (credential?: string) => {
      if (epoch === undefined || operation.current) throw new Error('Recovery operation unavailable');
      const owner = generation.current;
      const id = crypto.randomUUID();
      operation.current = id;
      const current = () => mounted.current && generation.current === owner && operation.current === id;
      try {
        if (mode === 'export') {
          const encrypted = await exportRecoveryDataFile(filePassword, epoch, id, credential);
          if (!current()) return;
          setPreparedContent(encrypted);
        } else {
          if (content === undefined) throw new Error('Recovery file unavailable');
          const result = await importRecoveryDataFile(content, filePassword, epoch, id, credential);
          if (!current()) return;
          if (!result.imported) throw new Error('Recovery import incomplete');
        }
      } catch (cause) {
        const category = fileError(cause);
        if (current() && category) {
          setError(category);
          setPhase('form');
        }
        throw cause;
      } finally {
        if (operation.current === id) operation.current = undefined;
      }
    },
    [content, epoch, exportRecoveryDataFile, filePassword, importRecoveryDataFile, mode]
  );

  const authenticated = useCallback(
    (result: StrictAuthenticationResult) => {
      if (result === 'authenticated') {
        setFilePassword('');
        setContent(undefined);
        setPhase(mode === 'export' ? 'delivery' : 'imported');
      } else setPhase('form');
    },
    [mode]
  );

  const startAuthentication = () => {
    if (epoch === undefined) return;
    setError(undefined);
    setPhase('authenticate');
  };

  const title = t(mode === 'export' ? 'recoveryDataExport' : 'recoveryDataImport');
  return (
    <SubPageHeaderProvider value={{ title, onBack: back, focusTitleOnMount: true }}>
      {phase === 'form' && mode === 'export' && (
        <ExportFilePassword
          error={error}
          description={t('recoveryDataDescription')}
          passwordDescription={t('recoveryDataExportPasswordDescription')}
          onGoNext={startAuthentication}
          onGoBack={back}
          passwordValue={filePassword}
          handlePasswordChange={event => setFilePassword(event.target.value)}
          fileName={fileName}
          onFileNameChange={event => setFileName(event.target.value)}
        />
      )}
      {phase === 'form' && mode === 'import' && (
        <SubPageLayout
          footer={
            <Button
              title={t('continue')}
              disabled={!content || !filePassword || reading || epoch === undefined}
              onClick={startAuthentication}
            />
          }
        >
          <SubPageSection description={t('recoveryDataImportDescription')}>
            <TextField
              type="file"
              accept="application/json,.json"
              label={t('recoveryDataChooseFile')}
              onChange={selectFile}
            />
            {file && (
              <Button variant={ButtonVariant.Secondary} title={t('recoveryDataClearFile')} onClick={clearFile} />
            )}
            <TextField
              type="password"
              label={t('recoveryDataFilePassword')}
              value={filePassword}
              onChange={event => setFilePassword(event.target.value)}
              autoComplete="off"
            />
            <ErrorLine errorId={error}>{error && t(error)}</ErrorLine>
          </SubPageSection>
        </SubPageLayout>
      )}
      {phase === 'authenticate' && (
        <SubPageLayout>
          <StrictActionAuthentication
            reason={t('recoveryDataAuthenticate')}
            authenticatedAction={perform}
            onResult={authenticated}
          />
        </SubPageLayout>
      )}
      {phase === 'delivery' && preparedContent !== undefined && (
        <ExportFileComplete
          preparedContent={preparedContent}
          fileKind="recovery-data"
          filePassword=""
          fileName={fileName}
          onGoBack={back}
          onDone={close}
        />
      )}
      {phase === 'imported' && (
        <SubPageLayout footer={<Button title={t('done')} onClick={close} />}>
          <SubPageSection description={t('recoveryDataImported')}>
            <p role="status" className="text-body text-muted">
              {t('recoveryDataCheckRequired')}
            </p>
          </SubPageSection>
        </SubPageLayout>
      )}
    </SubPageHeaderProvider>
  );
};
