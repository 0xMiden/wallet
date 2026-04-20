import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import Alert from 'app/atoms/Alert';
import { NotEnoughFundsError, ZeroBalanceError, ZeroTEZBalanceError } from 'app/defaults';

type SendErrorAlertProps = {
  type: 'submit' | 'estimation';
  error: Error;
};

const SendErrorAlert: FC<SendErrorAlertProps> = ({ type, error }) => {
  const { t } = useTranslation();
  const symbol = 'MDN';

  return (
    <Alert
      type={type === 'submit' ? 'error' : 'warn'}
      title={(() => {
        switch (true) {
          case error instanceof ZeroTEZBalanceError:
            return `${t('notEnoughCurrencyFunds', { currency: 'ꜩ' })} `;

          case error instanceof NotEnoughFundsError:
            return `${t('notEnoughFunds')} `;

          default:
            return t('failed');
        }
      })()}
      description={(() => {
        switch (true) {
          case error instanceof ZeroBalanceError:
            return t('yourBalanceIsZero');

          case error instanceof ZeroTEZBalanceError:
            return t('mainAssetBalanceIsZero');

          case error instanceof NotEnoughFundsError:
            return t('minimalFeeGreaterThanBalanceVerbose', { gasTokenSymbol: symbol });

          default:
            return (
              <>
                {t(type === 'submit' ? 'unableToSendTransactionAction' : 'unableToEstimateTransactionAction')}
                <br />
                {t('thisMayHappenBecause')}
                <ul className="mt-1 ml-2 text-xs list-disc list-inside">
                  <li>{t('minimalFeeGreaterThanBalanceVerbose', { gasTokenSymbol: symbol })}</li>
                  <li>{t('networkOrOtherIssue')}</li>
                </ul>
              </>
            );
        }
      })()}
      autoFocus
      className={classNames('mt-6 mb-4')}
    />
  );
};

export default SendErrorAlert;
