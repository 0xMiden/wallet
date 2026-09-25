import React, { FC, useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { AlertSheet } from 'components/ui/AlertSheet';
import { ButtonVariant } from 'components/ui/Button';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { dispatchAlertClose, dispatchConfirmClose, useModalsParams } from 'lib/ui/dialog';

/**
 * Renders what `useConfirm()` and `useAlert()` ask, as bottom sheets (`AlertSheet`). Each sheet
 * publishes its E2E screen-key segment (`drawer:confirm`, `drawer:alert`) while open.
 */
const Dialogs: FC = () => {
  const { t } = useTranslation();
  const { alertParams, confirmParams } = useModalsParams();

  const handleCancel = useCallback(() => {
    dispatchConfirmClose(false);
  }, []);

  const handleConfirm = useCallback(() => {
    dispatchConfirmClose(true);
  }, []);

  // Handle mobile back button/gesture to close dialogs
  useMobileBackHandler(
    () => {
      if (confirmParams.isOpen) {
        dispatchConfirmClose(false);
        return true;
      }
      if (alertParams.isOpen) {
        dispatchAlertClose();
        return true;
      }
      return false;
    },
    [confirmParams.isOpen, alertParams.isOpen],
    { overlay: true }
  );

  return (
    <>
      <AlertSheet
        open={confirmParams.isOpen}
        title={confirmParams.title}
        actionLabel={confirmParams.confirmLabel ?? t('ok')}
        actionVariant={confirmParams.destructive ? ButtonVariant.Destructive : ButtonVariant.Primary}
        onAction={handleConfirm}
        onCancel={handleCancel}
        cancelLabel={t('cancel')}
        actionTestId="confirmation-modal-confirm"
        cancelTestId="confirmation-modal-cancel"
        screenKey="confirm"
      >
        {confirmParams.children}
      </AlertSheet>
      <AlertSheet
        open={alertParams.isOpen}
        title={alertParams.title}
        actionLabel={t('ok')}
        onAction={dispatchAlertClose}
        screenKey="alert"
      >
        {alertParams.children}
      </AlertSheet>
    </>
  );
};

export default Dialogs;
