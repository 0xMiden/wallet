import React, { ChangeEvent, useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { SubmitHandler, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { NavigationHeader } from 'components/NavigationHeader';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
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
  const { navigateTo, goBack, cardStack, activeRoute } = useNavigator();
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(true);

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

  const onSubmit: SubmitHandler<EncryptedFileForm> = useCallback(async () => {
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
  }, [formState.isSubmitting, clearErrors, setError]);

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

  const handleWalletPasswordNext = useCallback(() => {
    setDrawerOpen(false);
    goToStep(EncryptedFileStep.ExportFilePassword);
  }, [goToStep]);

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case EncryptedFileStep.WalletPassword:
          return null;
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
    [goBack, onFileNameChange, fileName, onFilePasswordChange, filePassword, walletPassword, onClose, goToStep]
  );

  const isWalletPasswordStep = activeRoute?.name === EncryptedFileStep.WalletPassword;

  return (
    <div
      className={classNames('mx-auto overflow-hidden', 'flex flex-1', 'flex-col bg-app-bg', 'overflow-hidden relative')}
      data-testid="encrypted-file-manager-flow"
    >
      <Drawer
        open={drawerOpen && isWalletPasswordStep}
        onOpenChange={open => {
          if (!open) onClose();
        }}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('encryptedWalletFile')}</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-6 overflow-y-auto min-h-0">
            <EncryptedWalletFileWalletPassword
              onGoNext={handleWalletPasswordNext}
              onGoBack={onClose}
              onPasswordChange={onWalletPasswordChange}
              walletPassword={walletPassword}
            />
          </div>
        </DrawerContent>
      </Drawer>

      {!isWalletPasswordStep && (
        <>
          <NavigationHeader showBorder title={t('encryptedWalletFile')} onBack={onClose} />
          <form onSubmit={handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0 bg-app-bg">
            <Navigator renderRoute={renderStep} />
          </form>
        </>
      )}
    </div>
  );
};

const NavigatorWrapper: React.FC<EncryptedFileManagerProps> = () => {
  return (
    <NavigatorProvider routes={ROUTES} initialRouteName={EncryptedFileStep.WalletPassword}>
      <EncryptedFileManager />
    </NavigatorProvider>
  );
};

export { NavigatorWrapper as EncryptedFileFlow };
