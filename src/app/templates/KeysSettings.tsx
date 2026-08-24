import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import GuardianReplaceHotKey from 'app/templates/GuardianReplaceHotKey';
import { hapticLight } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

const KeysSettings: FC = () => {
  const { t } = useTranslation();
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const currentAccountHotPublicKey = useWalletStore(s => s.currentAccount?.hotPublicKey);
  const isGuardian = currentAccountType === WalletType.Guardian;
  const hasActivatedHotKey = Boolean(currentAccountHotPublicKey);

  const rows = [
    { titleI18nKey: 'revealPrivateKey', path: '/settings/reveal-private-key', show: true },
    { titleI18nKey: 'revealHotKey', path: '/settings/reveal-hot-key', show: isGuardian && hasActivatedHotKey },
    { titleI18nKey: 'rotateGuardian', path: '/rotate-guardian', show: isGuardian }
  ].filter(row => row.show);

  const openPage = (path: string) => {
    hapticLight();
    navigate(path);
  };

  return (
    <div className="w-full flex flex-col gap-6 pb-6">
      {rows.map(row => (
        <button key={row.titleI18nKey} type="button" onClick={() => openPage(row.path)} className="w-full">
          <div className="flex items-center justify-between text-heading-gray">
            <span className="font-medium text-base">{t(row.titleI18nKey)}</span>
            <Icon name={IconName.ChevronRightLucide} className="w-5 h-5 stroke-black" fill="none" />
          </div>
        </button>
      ))}

      {isGuardian && (
        <>
          <hr />
          <GuardianReplaceHotKey />
        </>
      )}
    </div>
  );
};

export default KeysSettings;
