import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import LocaleSelect from './LocaleSelect';

const LanguageSettings: FC = () => {
  const { t } = useTranslation();

  return (
    <div className="w-full max-w-sm mx-auto my-8">
      <div className="border border-border-card rounded-5 p-4">
        <div className="flex flex-col mb-3">
          <span className="font-medium text-sm text-[#0F131A]">{t('language')}</span>
          <span className="text-xs text-[#555D6D] mt-1">{t('languageAndCountry')}</span>
        </div>
        <LocaleSelect />
      </div>
    </div>
  );
};

export default LanguageSettings;
