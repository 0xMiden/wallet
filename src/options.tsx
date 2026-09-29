import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

/* eslint-disable import/first, import/order -- Buffer polyfill above must run before any module that uses Buffer at import time. */

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
import { resetStorageDestructive } from 'lib/miden/reset';
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
            'text-pure-white',
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

  try {
    const confirmed = await confirm({
      title: getMessage('actionConfirmation'),
      children: <ResetExtensionConfirmation />,
      confirmLabel: getMessage('resetExtension'),
      destructive: true
    });
    if (!confirmed) return;

    // resetStorageDestructive's caller contract: report a rejected wipe and then reload, and report a reload
    // that cannot start. The key-value clear comes first, so a partial wipe leaves no vault. The reload does
    // not depend on the page staying open: the tab can close while the report is up, and nothing after its
    // await runs then, so pagehide reloads too, and whichever comes first is the one reload.
    let reloaded = false;
    const reloadOnce = () => {
      browser.runtime.reload();
      reloaded = true;
    };
    try {
      await resetStorageDestructive();
    } catch (err) {
      console.warn('[options] Could not wipe the wallet storage', err);
      window.addEventListener('pagehide', reloadOnce, { once: true });
      try {
        await customAlert({ title: getMessage('error'), children: getMessage('resetDidNotFinish') });
      } finally {
        window.removeEventListener('pagehide', reloadOnce);
      }
    }
    // A listener reload that threw left the flag down, so this one retries and reports.
    if (!reloaded) {
      try {
        reloadOnce();
      } catch (err) {
        await customAlert({
          title: getMessage('error'),
          children: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } finally {
    resetting = false;
  }
}
