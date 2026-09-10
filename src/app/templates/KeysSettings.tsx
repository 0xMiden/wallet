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
  const seedPhraseStatus = useWalletStore(s => s.seedPhraseStatus);
  // Recovery actions (rotate guardian, replace hot key) are cold-signed. A
  // hot-key-only import carries no coldPublicKey and no seed to re-derive one
  // from, so offering them would dead-end in a seed prompt that must reject.
  const hasColdKey = useWalletStore(s => Boolean(s.currentAccount?.coldPublicKey));
  const isGuardian = currentAccountType === WalletType.Guardian;
  const hasActivatedHotKey = Boolean(currentAccountHotPublicKey);

  const rows = [
    { titleI18nKey: 'revealPrivateKey', path: '/settings/reveal-private-key', show: seedPhraseStatus === 'stored' },
    { titleI18nKey: 'revealHotKey', path: '/settings/reveal-hot-key', show: isGuardian && hasActivatedHotKey },
    { titleI18nKey: 'rotateGuardian', path: '/rotate-guardian', show: isGuardian && hasColdKey }
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

      {isGuardian && hasColdKey && (
        <>
          <hr />
          <GuardianReplaceHotKey />
        </>
      )}
      {isGuardian && !hasColdKey && <p className="text-sm text-grey-600">{t('recoveryActionsRequireRecoveryKey')}</p>}
    </div>
  );
};

export default KeysSettings;
