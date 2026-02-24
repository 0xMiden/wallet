import React, { ChangeEvent, useCallback, useEffect } from 'react';

import classNames from 'clsx';
import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { NavigationHeader } from 'components/NavigationHeader';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { navigate } from 'lib/woozie';
import EncryptedWalletFileWalletPassword from 'screens/encrypted-file-flow/EncryptedWalletFileWalletPassword';

import ExportFileComplete from './ExportFileComplete';
import ExportFilePassword from './ExportFileSetNamePassword';
import { EncryptedFileAction, EncryptedFileActionId, EncryptedFileForm, EncryptedFileStep } from './types';

const ROUTES: Route[] = [
  {
    name: EncryptedFileStep.WalletPassword,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: EncryptedFileStep.ExportFilePassword,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: EncryptedFileStep.ExportFileComplete,
    animationIn: 'push',
    animationOut: 'pop'
  }
];

export interface EncryptedFileManagerProps {}

export const EncryptedFileManager: React.FC<{}> = () => {
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { fullPage } = useAppEnv();
  const { t } = useTranslation();

  const onClose = useCallback(() => {
    navigate('/settings');
  }, []);

  // Handle mobile back button/gesture
  useMobileBackHandler(() => {
    if (cardStack.length > 1) {
      goBack(); // Go to previous step
      return true;
    }
    // On first step, close entire flow
    onClose();
    return true;
  }, [cardStack.length, goBack, onClose]);

  const { register, watch, handleSubmit, formState, setError, clearErrors, setValue } = useForm<EncryptedFileForm>({
    defaultValues: {
      walletPassword: '',
      filePassword: '',
      fileName: ''
    }
  });

  useEffect(() => {
    register('fileName');
    register('filePassword');
    register('walletPassword');
  }, [register]);

  const fileName = watch('fileName');
  const filePassword = watch('filePassword');
  const walletPassword = watch('walletPassword');

  const onAction = useCallback(
    (action: EncryptedFileAction) => {
      switch (action.id) {
        case EncryptedFileActionId.Navigate:
          navigateTo(action.step);
          break;
        case EncryptedFileActionId.GoBack:
          goBack();
          break;
        case EncryptedFileActionId.Finish:
          onClose?.();
          break;
        case EncryptedFileActionId.SetFormValues:
          Object.entries(action.payload).forEach(([key, value]) => {
            setValue(key as keyof EncryptedFileForm, value);
          });
          break;
        default:
          break;
      }
    },
    [navigateTo, goBack, onClose, setValue]
  );

  const onSubmit: SubmitHandler<EncryptedFileForm> = useCallback(
    async data => {
      if (formState.isSubmitting) {
        return;
      }
      try {
        clearErrors('root');
      } catch (e: unknown) {
        const error = e as Error;
        if (error.message) {
          setError('root', { type: 'manual', message: error.message });
        }
        console.error(e);
      }
    },
    [formState.isSubmitting, clearErrors, setError]
  );

  const goToStep = useCallback(
    (step: EncryptedFileStep) => {
      onAction({ id: EncryptedFileActionId.Navigate, step });
    },
    [onAction]
  );

  const onFileNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onAction({
        id: EncryptedFileActionId.SetFormValues,
        payload: { fileName: event.target.value }
      });
    },
    [onAction]
  );

  const onFilePasswordChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onAction({
        id: EncryptedFileActionId.SetFormValues,
        payload: { filePassword: event.target.value }
      });
    },
    [onAction]
  );

  const onWalletPasswordChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onAction({
        id: EncryptedFileActionId.SetFormValues,
        payload: { walletPassword: event.target.value }
      });
    },
    [onAction]
  );

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case EncryptedFileStep.WalletPassword:
          const onGoNext = () => goToStep(EncryptedFileStep.ExportFilePassword);
          return (
            <EncryptedWalletFileWalletPassword
              onGoNext={onGoNext}
              onGoBack={goBack}
              onPasswordChange={onWalletPasswordChange}
              walletPassword={walletPassword}
            />
          );
        case EncryptedFileStep.ExportFilePassword:
          return (
            <ExportFilePassword
              onGoBack={goBack}
              onGoNext={() => {
                goToStep(EncryptedFileStep.ExportFileComplete);
              }}
              handlePasswordChange={onFilePasswordChange}
              passwordValue={filePassword ?? ''}
              fileName={fileName}
              onFileNameChange={onFileNameChange}
            />
          );
        case EncryptedFileStep.ExportFileComplete:
          return (
            <ExportFileComplete
              onGoBack={goBack}
              filePassword={filePassword ?? ''}
              fileName={fileName}
              walletPassword={walletPassword ?? ''}
              onDone={onClose}
            />
          );
        default:
          return <></>;
      }
    },
    [
      goBack,
      onWalletPasswordChange,
      onFileNameChange,
      fileName,
      onFilePasswordChange,
      filePassword,
      walletPassword,
      onClose,
      goToStep
    ]
  );

  return (
    <div
      className={classNames('mx-auto overflow-hidden', 'flex flex-1', 'flex-col bg-white', 'overflow-hidden relative')}
      data-testid="encrypted-file-manager-flow"
    >
      {}
      <NavigationHeader showBorder title={t('encryptedWalletFile')} onBack={onClose} />
      <form onSubmit={handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0">
        <Navigator renderRoute={renderStep} initialRouteName={EncryptedFileStep.WalletPassword} />
      </form>
    </div>
  );
};

const NavigatorWrapper: React.FC<EncryptedFileManagerProps> = props => {
  return (
    <NavigatorProvider routes={ROUTES}>
      <EncryptedFileManager />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as EncryptedFileFlow };
