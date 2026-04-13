import React, { FC } from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { PRIMARY_HEX } from 'utils/brand-colors';

type PrivateDataPermissionBannerProps = {
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
  isPublicAccount: boolean;
};

const PrivateDataPermissionBanner: FC<PrivateDataPermissionBannerProps> = ({
  privateDataPermission,
  allowedPrivateData,
  isPublicAccount
}) => {
  const { t } = useTranslation();

  const checkboxIcon = <Icon name={IconName.CheckboxCircle} size="sm" fill={PRIMARY_HEX} className="shrink-0 mr-3" />;
  return (
    <div className={classNames('w-full', 'flex flex-col')}>
      <div className={classNames('flex', 'mb-4')}>
        <p className="text-sm">
          {isPublicAccount ? t('publicAccountAccessRequest') : t('privateAccountAccessRequest')}
        </p>
      </div>
      {!isPublicAccount && (
        <PrivateDataAccess privateDataPermission={privateDataPermission} allowedPrivateData={allowedPrivateData} />
      )}
      {isPublicAccount && (
        <>
          <div className={classNames('flex', 'mb-4')}>
            {checkboxIcon}
            <p className="text-sm">{t('balanceAccess')}</p>
          </div>
          <div className={classNames('flex', 'mb-4')}>
            {checkboxIcon}
            <p className="text-sm">{t('sendTransactionRequests')}</p>
          </div>
          <div className={classNames('flex')}>
            {checkboxIcon}
            <p className="text-sm">{t('fundsStayInWallet')}</p>
          </div>
        </>
      )}
    </div>
  );
};

type PrivateDataAccessProps = {
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
};

const PrivateDataAccess: FC<PrivateDataAccessProps> = ({ privateDataPermission, allowedPrivateData }) => {
  const { t } = useTranslation();

  const allowedPrivateDataToString = (data: AllowedPrivateData): string => {
    const parts: string[] = [];
    if (data & AllowedPrivateData.Assets) parts.push('Assets');
    if (data & AllowedPrivateData.Notes) parts.push('Notes');
    if (data & AllowedPrivateData.Storage) parts.push('Storage');
    return parts.join(', ');
  };

  const allowedPrivateDataList = allowedPrivateDataToString(allowedPrivateData);
  const privateDataPermissionText =
    privateDataPermission === PrivateDataPermission.Auto
      ? t('privateDataAccessAuto')
      : t('privateDataAccessUponRequest');

  return (
    <>
      <p className="text-base font-semibold">{privateDataPermissionText}</p>
      {privateDataPermission === PrivateDataPermission.Auto && (
        <div className={classNames('flex', 'flex-col')}>
          <p className="text-sm">{t('accessWillBeGranted')}</p>
          <p className="text-sm font-Í›bold">{allowedPrivateDataList}</p>
        </div>
      )}
      {privateDataPermission === PrivateDataPermission.UponRequest && (
        <div className={classNames('flex', 'flex-col')}>
          <p className="text-sm">{t('confirmationRequired')}</p>
        </div>
      )}
    </>
  );
};

export default PrivateDataPermissionBanner;
