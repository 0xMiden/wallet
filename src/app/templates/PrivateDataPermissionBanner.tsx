import React, { FC } from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { formatAllowedPrivateData, grantsStandingPrivateDataAccess } from 'lib/dapp-browser/private-data-scope';
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

/**
 * The extension popup's half of the connect prompt's private-data section.
 *
 * Both the scope list and the "does this grant standing access?" test come from
 * `lib/dapp-browser/private-data-scope`, the same helpers the mobile
 * `DappConfirmationModal` and the desktop overlay use, so the three surfaces
 * cannot describe one grant differently. This file used to carry its own copy of
 * the formatter and branch on `privateDataPermission === Auto` alone, which
 * disagreed with the other two on the reachable `Auto` + `AllowedPrivateData.None`
 * request (`dapp.ts` defaults the mask to `None`): the popup promised standing
 * access to an empty list, while the handlers in `lib/miden/back/dapp.ts` — which
 * require a non-empty category bit — actually prompt every time.
 */
const PrivateDataAccess: FC<PrivateDataAccessProps> = ({ privateDataPermission, allowedPrivateData }) => {
  const { t } = useTranslation();

  const grantsStandingAccess = grantsStandingPrivateDataAccess(privateDataPermission, allowedPrivateData);
  const allowedPrivateDataList = formatAllowedPrivateData(allowedPrivateData);

  return (
    <>
      <p className="text-base font-semibold">
        {grantsStandingAccess ? t('privateDataAccessAuto') : t('privateDataAccessUponRequest')}
      </p>
      {grantsStandingAccess ? (
        <div className={classNames('flex', 'flex-col')}>
          <p className="text-sm">{t('accessWillBeGranted')}</p>
          <p className="text-sm font-bold">{allowedPrivateDataList}</p>
        </div>
      ) : (
        <div className={classNames('flex', 'flex-col')}>
          <p className="text-sm">{t('confirmationRequired')}</p>
        </div>
      )}
    </>
  );
};

export default PrivateDataPermissionBanner;
