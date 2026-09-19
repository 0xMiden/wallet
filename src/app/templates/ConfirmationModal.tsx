import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import ModalWithTitle, { ModalWithTitleProps } from 'app/templates/ModalWithTitle';
import { Button, ButtonVariant } from 'components/Button';

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
        <div className="flex gap-2.5">
          <Button
            variant={ButtonVariant.Secondary}
            className="flex-1"
            onClick={onRequestClose}
            data-testid="confirmation-modal-cancel"
          >
            {t('cancel')}
          </Button>
          <Button type="button" className="flex-1" onClick={onConfirm} data-testid="confirmation-modal-confirm">
            {t('ok')}
          </Button>
        </div>
      </>
    </ModalWithTitle>
  );
};

export default ConfirmationModal;
