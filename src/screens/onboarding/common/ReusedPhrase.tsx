import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { CheckboxConsent } from 'components/ui/Checkbox';
import { Notice } from 'components/ui/Notice';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface ReusedPhraseNoticeProps {
  acknowledged: boolean;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  /** A line above the warning, for a host whose action only sometimes creates an account. */
  lead?: React.ReactNode;
}

/** The reused-phrase warning and the tick that must come before an account is created from an entered phrase. */
export const ReusedPhraseNotice: React.FC<ReusedPhraseNoticeProps> = ({ acknowledged, onAcknowledgedChange, lead }) => {
  const { t } = useTranslation();
  return (
    <>
      <Notice tone="warning" data-testid="reused-phrase-warning">
        <span className="flex flex-col items-start gap-1">
          {lead && <span>{lead}</span>}
          <span>{t('reusedPhraseWarning')}</span>
        </span>
      </Notice>
      <CheckboxConsent
        checked={acknowledged}
        onCheckedChange={onAcknowledgedChange}
        data-testid="reused-phrase-acknowledge"
      >
        {t('reusedPhraseAcknowledge')}
      </CheckboxConsent>
    </>
  );
};

export interface ReusedPhraseScreenProps {
  onSubmit?: () => void;
}

/**
 * Between "no backup found" and the create flow: the phrase the user entered is about to seed a NEW
 * account, so say that this is not a recovery and that a phrase used elsewhere is only as safe as its
 * weakest holder. Continue waits for the tick.
 */
export const ReusedPhraseScreen: React.FC<ReusedPhraseScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <OnboardingStepLayout
      data-testid="reused-phrase"
      title={t('reusedPhraseTitle')}
      description={t('reusedPhraseNotRecovery')}
      footer={
        <Button
          className="max-w-none"
          data-testid="reused-phrase-continue"
          title={t('continue')}
          onClick={onSubmit}
          disabled={!acknowledged}
        />
      }
    >
      <ReusedPhraseNotice acknowledged={acknowledged} onAcknowledgedChange={setAcknowledged} />
      <p className="text-explainer text-muted">{t('reusedPhraseStaysOnDevice')}</p>
    </OnboardingStepLayout>
  );
};
