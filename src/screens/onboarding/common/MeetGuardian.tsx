import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useGuardianPings } from 'app/hooks/useGuardianAvailability';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { CheckboxRow } from 'components/ui/Checkbox';
import { ListGroup } from 'components/ui/ListGroup';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { Skeleton } from 'components/ui/Skeleton';
import { StatusBadge } from 'components/ui/StatusBadge';
import { outlineSurfaceClassName } from 'components/ui/surfaces';
import { TextAction } from 'components/ui/TextAction';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';
import { MeetGuardianProgress, NO_GUARDIAN_ID } from 'screens/onboarding/types';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';
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

/** What every operator guarantees, in the order the card lists them; each drawn with a check. */
const GUARDIAN_GUARANTEE_KEYS: readonly string[] = [
  'meetGuardianCannotMoveFunds',
  'meetGuardianBacksUpState',
  'meetGuardianCanSwitch'
];

/** One line about each built-in operator; an operator without one gets the generic line. */
const OPERATOR_BIO_KEYS: Readonly<Record<string, string>> = {
  'open-zeppelin': 'guardianBioOpenZeppelin',
  gateway: 'guardianBioGateway',
  'lambda-class': 'guardianBioLambdaClass',
  kodax: 'guardianBioKoda'
};

export interface MeetGuardianScreenProps {
  /** The ticks and the locked operator, owned by the flow so the picker round trip keeps them. */
  progress: MeetGuardianProgress;
  onProgressChange: React.Dispatch<React.SetStateAction<MeetGuardianProgress>>;
  /** The operator Continue picked, or the no-guardian sentinel from the private-account link. */
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  /** "Choose a different Guardian": the host pushes the full picker. */
  onChooseDifferent?: () => void;
  /** Dev-gated: offer a fully private account with no guardian co-signer. */
  showNoGuardianOption?: boolean;
}

/**
 * The create flow's guardian step. The fastest reachable operator leads the page, under a "Your
 * Guardian" header whose "What is a Guardian?" opens the explainer sheet; the three facts about a
 * private account follow, and Continue opens once all three are ticked. The operator is chosen once, when every
 * operator has answered its first ping, so the card does not change under the user while later
 * rounds refresh the number on it. An operator that later goes offline closes Continue and says
 * so on the card. "Choose a different Guardian" is offered while the first round is out, beside the
 * chosen operator and when none answers; a network with no operator at all says so and offers
 * nothing to pick.
 */
export const MeetGuardianScreen: React.FC<MeetGuardianScreenProps> = ({
  progress,
  onProgressChange,
  onSubmit,
  onChooseDifferent,
  showNoGuardianOption = false
}) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const { checked, chosenId } = progress;
  const allChecked = MEET_GUARDIAN_POINTS.every(point => checked[point.id]);

  // Providers that run a Guardian on the active network, resolved to their endpoint on it.
  const options = useMemo(() => getGuardianOptionsForNetwork(), []);
  const endpoints = useMemo(() => options.map(option => option.endpoint), [options]);
  const verdicts = useGuardianPings(endpoints);

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

  const chosen = options.find(option => option.id === chosenId) ?? null;

  // Locked in once, on the first full round: the ranking is that moment's measurement. A re-probe can
  // take the operator offline, but never swaps it for another while the user reads about it. A choice
  // that matches no operator here counts as none, and the fastest is locked in as an auto-pick.
  useEffect(() => {
    if (chosen !== null || !allSettled || fastest === null) return;
    onProgressChange(prev =>
      options.some(option => option.id === prev.chosenId)
        ? prev
        : { ...prev, chosenId: fastest.id, pickedByUser: false }
    );
  }, [chosen, allSettled, fastest, options, onProgressChange]);
  const chosenVerdict = chosen ? verdicts[chosen.endpoint] : undefined;
  const chosenOnline = chosenVerdict?.status === 'online';
  // No operator on this network at all is terminal, not a round still out: the picker would be empty too.
  const noOperators = options.length === 0;
  const noneReachable = noOperators || (allSettled && fastest === null && chosen === null);

  const handleContinue = () => {
    if (!chosen || !chosenOnline) return;
    onSubmit?.({ guardianId: chosen.id, guardianEndpoint: chosen.endpoint });
  };

  const handleNoGuardian = () => onSubmit?.({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });

  const bioKey = chosen ? OPERATOR_BIO_KEYS[chosen.id] : undefined;

  const openInfo = () => {
    hapticLight();
    setIsInfoOpen(true);
  };

  const chooseDifferent = noOperators ? null : (
    <TextAction className="-mx-1 self-start" data-testid="meet-guardian-choose-different" onClick={onChooseDifferent}>
      {t('chooseDifferentGuardian')}
    </TextAction>
  );

  return (
    <OnboardingStepLayout
      data-testid="onboarding-meet-guardian"
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
      {/* The Guardian leads the page, there from the start, and the facts that explain it follow.
          Both blocks keep their full height so the body scrolls rather than squashing them. */}
      <section data-testid="meet-guardian-section" className="flex shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-label text-muted">{t('meetGuardianYourGuardian')}</h2>
          <TextAction
            className="-mx-1 inline-flex items-center gap-1.5"
            data-testid="meet-guardian-info"
            onClick={openInfo}
          >
            <Icon name={IconName.Information} size="sm" fill="currentColor" />
            {t('whatIsAGuardian')}
          </TextAction>
        </div>

        {chosen ? (
          <div data-testid="meet-guardian-card" className="flex flex-col" aria-busy={chosenVerdict === undefined}>
            <div className="flex items-center gap-3">
              <GuardianLogoTile guardianId={chosen.id} />
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <span className="truncate text-title-page text-ink" data-testid="meet-guardian-name">
                  {chosen.name}
                </span>
                {/* "Fastest" is true of the operator locked in here, not of one picked in the full picker. */}
                {!(progress.pickedByUser && options.length > 1) && (
                  <Pill size="sm" tone="positive" data-testid="meet-guardian-fastest">
                    {options.length > 1
                      ? t('meetGuardianFastestOf', { operators: String(options.length) })
                      : t('meetGuardianOnlyOperator')}
                  </Pill>
                )}
              </div>
              {/* Nothing once it answers. A card kept from before the picker has no verdict yet, so it says
                  it is checking (Continue waits for the answer); a later round that loses the operator shows
                  offline, which is why Continue closed. */}
              {chosenVerdict === undefined ? (
                <StatusBadge status="checking" live data-testid="meet-guardian-checking-status" />
              ) : chosenVerdict.status === 'offline' ? (
                <StatusBadge status="offline" live data-testid="meet-guardian-offline" />
              ) : null}
            </div>

            <p className="mt-2.5 text-caption-heading text-muted">{t(bioKey ?? 'guardianBioGeneric')}</p>

            {/* What every operator guarantees, in an outlined list with a positive disc per line. */}
            <ul
              data-testid="meet-guardian-guarantees"
              className={cn('mt-3.5 flex flex-col rounded-2xl px-3 py-1', outlineSurfaceClassName)}
            >
              {GUARDIAN_GUARANTEE_KEYS.map(key => (
                <li
                  key={key}
                  className="relative flex items-center gap-2.5 py-2.5 before:absolute before:top-0 before:right-0 before:left-7.5 before:h-px before:bg-hairline first:before:hidden"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center rounded-full bg-positive-tint text-positive-tint-ink"
                  >
                    <Icon name={IconName.Checkmark} size="xs" fill="currentColor" />
                  </span>
                  <span className="text-value text-ink">{t(key)}</span>
                </li>
              ))}
            </ul>

            {/* The change action closes the section: a full-width row, ruled off from the checklist. */}
            {!noOperators && (
              <button
                type="button"
                data-testid="meet-guardian-choose-different"
                onClick={() => {
                  hapticLight();
                  onChooseDifferent?.();
                }}
                className="mt-1.5 flex min-h-12 w-full items-center justify-between border-b border-hairline text-action text-accent-tint-ink transition-opacity active:opacity-70"
              >
                {t('chooseDifferentGuardian')}
                <Icon name={IconName.ChevronRight} size="sm" fill="currentColor" />
              </button>
            )}
          </div>
        ) : noneReachable ? (
          <div className="flex flex-col gap-3">
            <Notice tone="negative" role="status" data-testid="meet-guardian-none-reachable">
              {t('meetGuardianNoneReachable')}
            </Notice>
            {chooseDifferent}
          </div>
        ) : (
          <div data-testid="meet-guardian-checking" className="flex flex-col gap-3" aria-busy>
            <div className="flex items-center gap-3">
              <Skeleton className="size-12 rounded-xl" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-40" />
              </div>
            </div>
            <span className="text-caption text-muted">{t('meetGuardianChecking')}</span>
            {chooseDifferent}
          </div>
        )}
      </section>

      {/* Plain rows on the page, like the testnet notice before it; the hairlines start after the box. */}
      <ListGroup surface="plain" className="shrink-0 [&>*]:before:left-9">
        {MEET_GUARDIAN_POINTS.map(point => (
          <CheckboxRow
            key={point.id}
            data-testid={`onboarding-meet-guardian-check-${point.id}`}
            checked={Boolean(checked[point.id])}
            onCheckedChange={value =>
              onProgressChange(prev => ({ ...prev, checked: { ...prev.checked, [point.id]: value } }))
            }
            title={t(point.titleKey)}
            description={t(point.bodyKey)}
          />
        ))}
      </ListGroup>

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </OnboardingStepLayout>
  );
};

export default MeetGuardianScreen;
