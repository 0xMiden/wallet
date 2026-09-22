import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { navigate } from 'lib/woozie';

// The Recovery Phrase section: one page that holds the reveal and the removal,
// the same shape as Keys. Both rows need a stored phrase, and the Settings menu
// hides the section row itself once the phrase is gone, so no row is gated here.
const ROWS = [
  { titleI18nKey: 'revealRecoveryPhrase', path: '/settings/reveal-seed-phrase', testId: 'recovery-phrase-reveal' },
  { titleI18nKey: 'removeSeedPhrase', path: '/settings/remove-seed-phrase', testId: 'recovery-phrase-remove' }
];

const RecoveryPhraseSettings: FC = () => {
  const { t } = useTranslation();

  return (
    <SubPageLayout data-testid="recovery-phrase-settings">
      <SubPageSection>
        <ListGroup>
          {ROWS.map(row => (
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
    </SubPageLayout>
  );
};

export default RecoveryPhraseSettings;
