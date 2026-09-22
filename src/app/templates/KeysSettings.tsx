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
  // Replacing the hot key is cold-signed. An account with no local cold key
  // (seed removed, or a hot-key-only import) gets a seed phrase prompt for the
  // one transaction instead of being hidden.
  //
  // Guardian rotation is NOT a row here: it is the CTA of Guardian Settings, and
  // a second entry point on a keys page is one more place to reach a recovery
  // action from. The cold key is not revealed either: nothing can import it, so
  // showing it gives the user nothing to do with it.
  const isGuardian = currentAccountType === WalletType.Guardian;
  const hasActivatedHotKey = Boolean(currentAccountHotPublicKey);

  const rows = [
    {
      titleI18nKey: 'revealPrivateKey',
      path: isGuardian ? '/settings/reveal-hot-key' : '/settings/reveal-private-key',
      testId: 'keys-reveal-private-key',
      show: isGuardian ? hasActivatedHotKey : seedPhraseStatus === 'stored'
    }
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
