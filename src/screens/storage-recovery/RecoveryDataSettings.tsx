import React, { useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/ui/Button';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';

import { RecoveryDataFlow } from './RecoveryDataFlow';

export const RecoveryDataSettings: React.FC = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'export' | 'import'>();
  const close = useCallback(() => setMode(undefined), []);
  if (mode) return <RecoveryDataFlow mode={mode} onClose={close} />;

  return (
    <SubPageLayout data-testid="recovery-data-settings">
      <SubPageSection description={t('recoveryDataDescription')}>
        <Button title={t('recoveryDataExport')} onClick={() => setMode('export')} />
        <Button variant={ButtonVariant.Secondary} title={t('recoveryDataImport')} onClick={() => setMode('import')} />
      </SubPageSection>
    </SubPageLayout>
  );
};
