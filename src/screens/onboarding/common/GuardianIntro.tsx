import React from 'react';

import { useTranslation } from 'react-i18next';

import guardianIntroRobot from 'app/icons/onboarding/guardian-intro-robot.png';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Card } from 'components/ui/Card';
import { FactRow, IconCircle } from 'components/ui/FactRow';

import { OnboardingStepLayout } from './OnboardingStepLayout';

interface GuardianIntroPoint {
  /** Stable id, for test hooks: `recover`, `funds`, `switch`. */
  id: string;
  icon: IconName;
  /** The point's tint and glyph colour: a flow accent, so the three read apart. */
  tone: string;
  titleKey: string;
  bodyKey: string;
}

/** What a Guardian does for the user, before any operator is named. */
export const GUARDIAN_INTRO_POINTS: readonly GuardianIntroPoint[] = [
  {
    id: 'recover',
    icon: IconName.Refresh,
    tone: 'bg-accent-receive-tint text-accent-receive',
    titleKey: 'guardianIntroRecoverTitle',
    bodyKey: 'guardianIntroRecoverBody'
  },
  {
    id: 'funds',
    icon: IconName.Lock,
    tone: 'bg-accent-send-tint text-accent-send',
    titleKey: 'guardianIntroFundsTitle',
    bodyKey: 'guardianIntroFundsBody'
  },
  {
    id: 'switch',
    icon: IconName.Switch,
    tone: 'bg-accent-swap-tint text-accent-swap',
    titleKey: 'guardianIntroSwitchTitle',
    bodyKey: 'guardianIntroSwitchBody'
  }
];

export interface GuardianIntroScreenProps {
  onContinue?: () => void;
}

/**
 * The create flow's first guardian screen: what a Guardian is, as an illustration and three benefits,
 * each on its own outlined card. The next screen names the operator that will do it.
 */
export const GuardianIntroScreen: React.FC<GuardianIntroScreenProps> = ({ onContinue }) => {
  const { t } = useTranslation();

  return (
    <OnboardingStepLayout
      data-testid="onboarding-guardian-intro"
      title={t('guardianIntroTitle')}
      description={t('guardianIntroDescription')}
      footer={
        <Button
          className="max-w-none"
          data-testid="guardian-intro-continue"
          title={t('continue')}
          onClick={onContinue}
        />
      }
    >
      <img src={guardianIntroRobot} alt="" aria-hidden="true" className="mx-auto h-[154px] w-auto shrink-0" />

      <ul className="flex shrink-0 flex-col gap-2.5">
        {GUARDIAN_INTRO_POINTS.map(point => (
          <Card asChild key={point.id} surface="outline" padding="none" className="px-4">
            <li data-testid={`guardian-intro-point-${point.id}`}>
              <FactRow
                leading={
                  <IconCircle size="lg" className={point.tone}>
                    <Icon name={point.icon} fill="currentColor" />
                  </IconCircle>
                }
                title={t(point.titleKey)}
                description={t(point.bodyKey)}
              />
            </li>
          </Card>
        ))}
      </ul>
    </OnboardingStepLayout>
  );
};

export default GuardianIntroScreen;
