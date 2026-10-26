import React, { useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import FormCheckbox from 'app/atoms/FormCheckbox';

type PrivateDataPermissionCheckboxProps = {
  setChecked: (isChecked: boolean) => void;
};

const PrivateDataPermissionCheckbox: React.FC<PrivateDataPermissionCheckboxProps> = ({ setChecked }) => {
  const { t } = useTranslation();

  const [confirmPrivateDataPermission, setConfirmPrivateDataPermission] = useState(false);

  const handlePopupModeChange = (evt: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmPrivateDataPermission(evt.target.checked);
    setChecked(evt.target.checked);
  };

  return (
    <div className={classNames('w-full', 'mb-4', 'flex flex-col')}>
      <label className="leading-tight flex flex-col" htmlFor="confirmPrivateDataPermission">
        <span className="mt-1 text-sm text-ink" style={{ maxWidth: '90%' }}>
          {t('confirmPrivateDataPermissionDescription')}
        </span>
      </label>
      <FormCheckbox
        checked={confirmPrivateDataPermission}
        onChange={handlePopupModeChange}
        name="confirmPrivateDataPermission"
        label={t('confirmRisk')}
        containerClassName="mb-4"
      />
    </div>
  );
};

export default PrivateDataPermissionCheckbox;
