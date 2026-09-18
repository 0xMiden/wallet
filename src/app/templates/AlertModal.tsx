import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import ModalWithTitle, { ModalWithTitleProps } from 'app/templates/ModalWithTitle';
import { Button } from 'components/Button';

export type AlertModalProps = ModalWithTitleProps;

const AlertModal: FC<AlertModalProps> = props => {
  const { t } = useTranslation();
  const { onRequestClose, children, ...restProps } = props;

  return (
    <ModalWithTitle {...restProps} onRequestClose={onRequestClose}>
      <div className="flex flex-col">
        <div className="mb-8">{children}</div>
        <div className="flex justify-center">
          <Button type="button" className="w-full" onClick={onRequestClose}>
            {t('ok')}
          </Button>
        </div>
      </div>
    </ModalWithTitle>
  );
};

export default AlertModal;
