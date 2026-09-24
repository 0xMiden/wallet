import React, { useEffect, useMemo, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useGuardianProbe } from 'app/hooks/useGuardianAvailability';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { Card } from 'components/ui/Card';
import { CheckboxRow } from 'components/ui/Checkbox';
import { ListGroup } from 'components/ui/ListGroup';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { Skeleton } from 'components/ui/Skeleton';
import { StatusBadge } from 'components/ui/StatusBadge';
import { TextAction } from 'components/ui/TextAction';
import { usePreset } from 'lib/animation';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { cn } from 'lib/ui/util';
import { NO_GUARDIAN_ID } from 'screens/onboarding/types';

import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MeetGuardianPoint {
  /** Stable id, for test hooks: `local-state`, `seed-phrase`, `guardian`. */
  id: string;
  titleKey: string;
  bodyKey: string;
}

/** The three facts the step asks the user to tick before a guardian is offered. */
export const MEET_GUARDIAN_POINTS: readonly MeetGuardianPoint[] = [
  { id: 'local-state', titleKey: 'meetGuardianLocalStateTitle', bodyKey: 'meetGuardianLocalStateBody' },
  { id: 'seed-phrase', titleKey: 'meetGuardianSeedPhraseTitle', bodyKey: 'meetGuardianSeedPhraseBody' },
  { id: 'guardian', titleKey: 'meetGuardianProtectsTitle', bodyKey: 'meetGuardianProtectsBody' }
];

/** What every operator guarantees, in the order the card lists them. */
const GUARDIAN_GUARANTEES: readonly { key: string; tone: 'cannot' | 'can' }[] = [
  { key: 'meetGuardianCannotMoveFunds', tone: 'cannot' },
  { key: 'meetGuardianCanSwitch', tone: 'can' }
];

/** One line about each built-in operator; an operator without one gets the generic line. */
const OPERATOR_BIO_KEYS: Readonly<Record<string, string>> = {
  'open-zeppelin': 'guardianBioOpenZeppelin',
  gateway: 'guardianBioGateway',
  'lambda-class': 'guardianBioLambdaClass',
  kodax: 'guardianBioKoda'
};

export interface MeetGuardianScreenProps {
  /** The operator Continue picked, or the no-guardian sentinel from the private-account link. */
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  /** "Choose a different Guardian": the host pushes the full picker. */
  onChooseDifferent?: () => void;
  /** Dev-gated: offer a fully private account with no guardian co-signer. */
  showNoGuardianOption?: boolean;
}

/**
 * The create flow's guardian step. The user ticks the three facts about a private account (the
 * same checklist the test-network notice uses); once all three are ticked the card of the fastest
 * reachable operator appears and Continue opens. The operator is chosen once, when every
 * operator has answered its first ping, so the card does not change under the user while later
 * rounds refresh the number on it. An operator that later goes offline closes Continue and says
 * so on the card; "Choose a different Guardian" is always there.
 */
export const MeetGuardianScreen: React.FC<MeetGuardianScreenProps> = ({
  onSubmit,
  onChooseDifferent,
  showNoGuardianOption = false
}) => {
  const { t } = useTranslation();
  const reveal = usePreset('reveal');
  const [checked, setChecked] = useState<Readonly<Record<string, boolean>>>({});
  const allChecked = MEET_GUARDIAN_POINTS.every(point => checked[point.id]);

  // Providers that run a Guardian on the active network, resolved to their endpoint on it.
  const options = useMemo(() => getGuardianOptionsForNetwork(), []);
  const endpoints = useMemo(() => options.map(option => option.endpoint), [options]);
  const verdicts = useGuardianProbe(endpoints);

  const allSettled = options.length > 0 && options.every(option => verdicts[option.endpoint] !== undefined);
  const fastest = useMemo(() => {
    let best: { option: ResolvedGuardianOption; latencyMs: number } | null = null;
    for (const option of options) {
      const verdict = verdicts[option.endpoint];
      if (verdict?.status !== 'online') continue;
      if (best === null || verdict.latencyMs < best.latencyMs) best = { option, latencyMs: verdict.latencyMs };
    }
    return best?.option ?? null;
  }, [options, verdicts]);

  // Locked in once, on the first full round: a re-probe refreshes the latency on the card and can
  // take the operator offline, but never swaps it for another while the user reads about it.
  const [chosenId, setChosenId] = useState<string | null>(null);
  useEffect(() => {
    if (chosenId !== null || !allSettled || fastest === null) return;
    setChosenId(fastest.id);
  }, [chosenId, allSettled, fastest]);

  const chosen = options.find(option => option.id === chosenId) ?? null;
  const chosenVerdict = chosen ? verdicts[chosen.endpoint] : undefined;
  const chosenOnline = chosenVerdict?.status === 'online';
  const noneReachable = allSettled && fastest === null && chosen === null;

  const handleContinue = () => {
    if (!chosen || !chosenOnline) return;
    onSubmit?.({ guardianId: chosen.id, guardianEndpoint: chosen.endpoint });
  };

  const handleNoGuardian = () => onSubmit?.({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });

  const bioKey = chosen ? OPERATOR_BIO_KEYS[chosen.id] : undefined;

  return (
    <OnboardingStepLayout
      data-testid="onboarding-meet-guardian"
      heading="hero"
      inset="px-6"
      title={t('setUpYourAccount')}
      description={t('setUpYourAccountDescription')}
      footer={
        <>
          <Button
            className="max-w-none"
            data-testid="meet-guardian-continue"
            title={t('continue')}
            onClick={handleContinue}
            disabled={!allChecked || !chosenOnline}
          />
          {showNoGuardianOption && allChecked && (
            <TextAction className="self-center" data-testid="meet-guardian-no-guardian" onClick={handleNoGuardian}>
              {t('meetGuardianFullyPrivateInstead')}
            </TextAction>
          )}
        </>
      }
    >
      {/* Both blocks keep their full height so the body scrolls rather than squashing them. */}
      <ListGroup className="shrink-0">
        {MEET_GUARDIAN_POINTS.map(point => (
          <CheckboxRow
            key={point.id}
            data-testid={`onboarding-meet-guardian-check-${point.id}`}
            checked={Boolean(checked[point.id])}
            onCheckedChange={value => setChecked(prev => ({ ...prev, [point.id]: value }))}
            title={t(point.titleKey)}
            description={t(point.bodyKey)}
          />
        ))}
      </ListGroup>

      {/* The card unfolds under the list once the last fact is ticked, and folds away if one is unticked. */}
      <AnimatePresence initial={false}>
        {allChecked && (
          <motion.div key="guardian" className="shrink-0 overflow-hidden" {...reveal}>
            {chosen ? (
              <Card data-testid="meet-guardian-card" className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <GuardianLogoTile guardianId={chosen.id} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-caption text-muted">
                      {options.length > 1
                        ? t('meetGuardianFastestOf', { operators: String(options.length) })
                        : t('meetGuardianOnlyOperator')}
                    </span>
                    <span className="truncate text-row-title text-ink" data-testid="meet-guardian-name">
                      {chosen.name}
                    </span>
                  </div>
                  {chosenVerdict?.status === 'online' ? (
                    <Pill size="xs" tone="positive" live data-testid="meet-guardian-latency">
                      {t('meetGuardianLatencyMs', { ms: String(chosenVerdict.latencyMs) })}
                    </Pill>
                  ) : (
                    <StatusBadge status="offline" live data-testid="meet-guardian-offline" />
                  )}
                </div>

                <ul className="flex flex-col gap-2">
                  {GUARDIAN_GUARANTEES.map(guarantee => (
                    <li key={guarantee.key} className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-4.5 shrink-0 items-center justify-center',
                          guarantee.tone === 'can' ? 'text-positive-ink' : 'text-accent-tint-ink'
                        )}
                      >
                        <Icon
                          name={guarantee.tone === 'can' ? IconName.Checkmark : IconName.Close}
                          size="xs"
                          fill="currentColor"
                        />
                      </span>
                      <span className="text-caption text-ink">{t(guarantee.key)}</span>
                    </li>
                  ))}
                </ul>

                <p className="text-caption text-muted">
                  {bioKey
                    ? t(bioKey, { operators: String(options.length) })
                    : t('guardianBioGeneric', { operators: String(options.length) })}
                </p>

                <TextAction
                  className="-mx-1 self-start"
                  data-testid="meet-guardian-choose-different"
                  onClick={onChooseDifferent}
                >
                  {t('chooseDifferentGuardian')}
                </TextAction>
              </Card>
            ) : noneReachable ? (
              <Notice tone="negative" role="status" data-testid="meet-guardian-none-reachable">
                {t('meetGuardianNoneReachable')}
              </Notice>
            ) : (
              <Card data-testid="meet-guardian-checking" className="flex flex-col gap-3" aria-busy="true">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-12 rounded-xl bg-fill-pressed" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-32 bg-fill-pressed" />
                    <Skeleton className="h-4 w-40 bg-fill-pressed" />
                  </div>
                </div>
                <span className="text-caption text-muted">{t('meetGuardianChecking')}</span>
              </Card>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </OnboardingStepLayout>
  );
};

export default MeetGuardianScreen;
