import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import Logo from 'app/atoms/Logo';

import pkg from '../../../package.json';
import MenuItem from './MenuItem';

const About: FC = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center mt-4">
      <div className="flex flex-col items-center justify-center">
        <Logo style={{ height: 60, filter: '' }} />

        <div className="text-center">
          <h4 className="text-xl font-semibold">{t('appName')}</h4>
          <p className="text-sm text-gray-200">{t('versionLabel', { version: pkg.version })}</p>
        </div>
      </div>

      <div className="flex flex-col w-full py-2">
        {/* eslint-disable i18next/no-literal-string */}
        {[
          { key: 'website', link: 'https://miden.xyz' },
          { key: 'twitter', link: 'https://x.com/0xMiden' },
          { key: 'privacyPolicy', link: 'https://miden.fi/privacy' },
          { key: 'termsOfUse', link: 'https://miden.fi/terms' }
        ]
          /* eslint-enable i18next/no-literal-string */
          .map(({ key, link }) => {
            return <MenuItem key={key} slug={link} titleI18nKey={key} testID={''} linksOutsideOfWallet={true} />;
          })}
      </div>
    </div>
  );
};

export default About;
