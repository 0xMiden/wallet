import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import FormSecondaryButton from 'app/atoms/FormSecondaryButton';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import ModalWithTitle, { ModalWithTitleProps } from 'app/templates/ModalWithTitle';

export type ConfirmationModalProps = ModalWithTitleProps & {
  onConfirm: () => void;
};

const ConfirmationModal: FC<ConfirmationModalProps> = props => {
  const { t } = useTranslation();
  const { onRequestClose, children, onConfirm, ...restProps } = props;

  return (
    <ModalWithTitle {...restProps} onRequestClose={onRequestClose}>
      <>
        <div className="mb-8">{children}</div>
        <div className="flex justify-end">
          <FormSecondaryButton className="mr-3" onClick={onRequestClose} data-testid="confirmation-modal-cancel">
            {t('cancel')}
          </FormSecondaryButton>
          <FormSubmitButton type="button" onClick={onConfirm} data-testid="confirmation-modal-confirm">
            {t('ok')}
          </FormSubmitButton>
        </div>
      </>
    </ModalWithTitle>
  );
};

export default ConfirmationModal;
