import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import guardianIntroLock from 'app/icons/onboarding/guardian-intro-lock.png';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { Card } from 'components/ui/Card';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { Pill } from 'components/ui/Pill';
import { cn } from 'lib/ui/util';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';
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
    icon: IconName.PhoneRestore,
    tone: 'bg-accent-receive-tint text-accent-receive',
    titleKey: 'guardianIntroRecoverTitle',
    bodyKey: 'guardianIntroRecoverBody'
  },
  {
    id: 'funds',
    icon: IconName.LockFilled,
    tone: 'bg-accent-send-tint text-accent-send',
    titleKey: 'guardianIntroFundsTitle',
    bodyKey: 'guardianIntroFundsBody'
  },
  {
    id: 'switch',
    icon: IconName.SwitchArrows,
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
 * each on its own outlined card, with the fuller explainer one tap away. The next screen names the
 * operator that will do it.
 */
export const GuardianIntroScreen: React.FC<GuardianIntroScreenProps> = ({ onContinue }) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  return (
    <OnboardingStepLayout
      data-testid="onboarding-guardian-intro"
      title={t('guardianIntroTitle')}
      description={t('guardianIntroDescription')}
      // The title's line box sits 8px above its letters; this puts the letters where the Testnet notice's pill starts.
      headingClassName="pt-2"
      aside={
        // The same pill as the test-network notice: brand dot, label, info glyph at the far end.
        <Pill
          className="w-full"
          data-testid="guardian-intro-more-about"
          aria-haspopup="dialog"
          aria-expanded={isInfoOpen}
          onClick={() => setIsInfoOpen(true)}
          icon={<span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent-primary" />}
          trailingIcon={<Icon name={IconName.Information} size="xs" fill="currentColor" className="text-muted" />}
        >
          {t('guardianIntroMoreAbout')}
        </Pill>
      }
      footer={
        <Button
          className="max-w-none"
          data-testid="guardian-intro-continue"
          title={t('continue')}
          onClick={onContinue}
        />
      }
    >
      {/* The stage and the benefits sit 12px apart rather than the step's 20px, so the step fits one screen. */}
      <div className="flex shrink-0 flex-col gap-3">
        {/* A soft stage under the illustration, so the robot stands on its floor instead of floating. */}
        <div className="relative flex h-[184px] shrink-0 items-end justify-center overflow-hidden rounded-2xl bg-fill">
          <img src={guardianIntroLock} alt="" aria-hidden="true" className="h-[180px] w-auto" />
        </div>

        <ul className="flex shrink-0 flex-col gap-2">
          {GUARDIAN_INTRO_POINTS.map(point => (
            <Card
              asChild
              key={point.id}
              surface="outline"
              padding="none"
              // Half the row's 12px icon gap and 2px less padding top and bottom, so the step fits one screen.
              className="px-4 [&>[data-slot=fact-row]]:gap-1.5 [&>[data-slot=fact-row]]:py-3"
            >
              <li data-testid={`guardian-intro-point-${point.id}`}>
                <FactRow
                  leading={
                    <IconCircle size="lg" className={cn('h-10 w-10 [&>svg]:h-5 [&>svg]:w-5', point.tone)}>
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
      </div>

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </OnboardingStepLayout>
  );
};

export default GuardianIntroScreen;
