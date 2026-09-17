import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { CircleButton } from 'components/CircleButton';

/** The send steps' leading back button, styled like ScreenHeader's so the flow matches the review screen.
 *  CircleButton plays the tap haptic. */
export const StepBackButton: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 pt-4">
      <CircleButton
        icon={IconName.BackArrow}
        color="currentColor"
        size="sm"
        onClick={onBack}
        aria-label={t('back')}
        data-testid="send-step-back"
        className="border border-border-card text-primary-500"
      />
    </div>
  );
};
