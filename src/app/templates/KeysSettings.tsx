import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import GuardianReplaceHotKey from 'app/templates/GuardianReplaceHotKey';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

const KeysSettings: FC = () => {
  const { t } = useTranslation();
  const currentAccountType = useWalletStore(s => s.currentAccount?.type);
  const currentAccountHotPublicKey = useWalletStore(s => s.currentAccount?.hotPublicKey);
  const seedPhraseStatus = useWalletStore(s => s.seedPhraseStatus);
  // Recovery actions (rotate guardian, replace hot key) are cold-signed. An
  // account with no local cold key (seed removed, or a hot-key-only import)
  // gets a seed phrase prompt for the one transaction instead of being hidden.
  const isGuardian = currentAccountType === WalletType.Guardian;
  const hasActivatedHotKey = Boolean(currentAccountHotPublicKey);

  const rows = [
    {
      titleI18nKey: 'revealPrivateKey',
      path: isGuardian ? '/settings/reveal-hot-key' : '/settings/reveal-private-key',
      testId: 'keys-reveal-private-key',
      show: isGuardian ? hasActivatedHotKey : seedPhraseStatus === 'stored'
    },
    { titleI18nKey: 'rotateGuardian', path: '/rotate-guardian', testId: 'keys-rotate-guardian', show: isGuardian }
  ].filter(row => row.show);

  return (
    <SubPageLayout data-testid="keys-settings">
      {rows.length > 0 && (
        <SubPageSection>
          <ListGroup>
            {rows.map(row => (
              <ListRow
                key={row.titleI18nKey}
                title={t(row.titleI18nKey)}
                // No haptic here: ListRow fires one on every tap.
                onClick={() => navigate(row.path)}
                chevron
                data-testid={row.testId}
              />
            ))}
          </ListGroup>
        </SubPageSection>
      )}

      {isGuardian && <GuardianReplaceHotKey />}
    </SubPageLayout>
  );
};

export default KeysSettings;
