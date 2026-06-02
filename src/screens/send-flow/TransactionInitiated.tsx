import React, { HTMLAttributes, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Message } from 'components/Message';

import { SendFlowAction, SendFlowActionId } from './types';

export interface TransactionInitiatedProps extends HTMLAttributes<HTMLDivElement> {
  onAction?: (action: SendFlowAction) => void;
}

export const TransactionInitiated: React.FC<TransactionInitiatedProps> = ({ className, onAction, ...props }) => {
  const { t } = useTranslation();

  const onDoneClick = useCallback(() => onAction?.({ id: SendFlowActionId.Finish }), [onAction]);

  return (
    <div {...props} className={classNames('flex-1 flex flex-col p-4 ', className)}>
      <div className="flex-1 flex flex-col justify-center md:w-[460px] md:mx-auto">
        <Message
          className="flex-1"
          title={t('transactionInitiated')}
          description={t('transactionWillProceedInBackground')}
          icon={IconName.CheckboxCircleFill}
          iconBackgroundClassName="rounded-full bg-gradient-to-t from-white to-surface-secondary"
        />
        <Button title={t('done')} className="mt-8" variant={ButtonVariant.Primary} onClick={onDoneClick} />
      </div>
    </div>
  );
};
