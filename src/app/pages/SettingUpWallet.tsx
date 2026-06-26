import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';

/**
 * Shown in the side panel during the onboarding → panel handoff: the panel is
 * opened (within the user gesture) before `registerWallet()` finishes, so for
 * a few seconds there is no account yet. This placeholder keeps the panel from
 * flashing its own Welcome until the backend reports the new wallet Ready.
 */
const SettingUpWallet: FC = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-4 px-6 text-center">
      <Spinner />
      <p className="text-text-muted text-sm">{t('settingUpWallet')}</p>
    </div>
  );
};

export default SettingUpWallet;
