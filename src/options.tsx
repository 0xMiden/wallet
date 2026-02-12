import './main.css';

import React, { FC, useCallback } from 'react';

import classNames from 'clsx';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import browser from 'webextension-polyfill';

import 'lib/lock-up/run-checks';

import DisableOutlinesForClick from 'app/a11y/DisableOutlinesForClick';
import Dialogs from 'app/layouts/Dialogs';
import { getMessage } from 'lib/i18n';
import { clearStorage } from 'lib/miden/reset';
import { AlertFn, ConfirmFn, DialogsProvider, useAlert, useConfirm } from 'lib/ui/dialog';

// Disable animations for extension
// Animations enabled for extension

const OptionsWrapper: FC = () => (
  <DialogsProvider>
    <Options />
    <Dialogs />
    <DisableOutlinesForClick />
  </DialogsProvider>
);

const Options: FC = () => {
  const customAlert = useAlert();
  const confirm = useConfirm();

  const internalHandleReset = useCallback(() => {
    handleReset(customAlert, confirm);
  }, [customAlert, confirm]);

  return (
    <div className="p-4">
      <h1 className="mb-2 text-xl font-semibold">{getMessage('leoWalletOptions')}</h1>

      <div className="my-6">
        <button
          className={classNames(
            'relative',
            'px-2 py-1',
            'bg-primary-orange rounded',
            'border-2 border-primary-orange',
            'flex items-center',
            'text-white',
            'text-sm font-semibold',
            'transition duration-200 ease-in-out',
            'opacity-90 hover:opacity-100 focus:opacity-100',
            'shadow-sm hover:shadow focus:shadow'
          )}
          onClick={internalHandleReset}
        >
          {getMessage('resetExtension')}
        </button>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<OptionsWrapper />);

const ResetExtensionConfirmation: FC = () => {
  const { t } = useTranslation();
  return <>{t('resetExtensionConfirmation')}</>;
};

let resetting = false;
async function handleReset(customAlert: AlertFn, confirm: ConfirmFn) {
  if (resetting) return;
  resetting = true;

  const confirmed = await confirm({
    title: getMessage('actionConfirmation'),
    children: <ResetExtensionConfirmation />
  });
  if (confirmed) {
    (async () => {
      try {
        await clearStorage();
        browser.runtime.reload();
      } catch (err: any) {
        await customAlert({
          title: getMessage('error'),
          children: err.message
        });
      }
    })();
  }

  resetting = false;
}
