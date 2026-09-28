import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useGuardianPings } from 'app/hooks/useGuardianAvailability';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { Card } from 'components/ui/Card';
import { CheckboxRow } from 'components/ui/Checkbox';
import { ListGroup } from 'components/ui/ListGroup';
import { Notice } from 'components/ui/Notice';
import { Skeleton } from 'components/ui/Skeleton';
import { StatusBadge } from 'components/ui/StatusBadge';
import { TextAction } from 'components/ui/TextAction';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { MeetGuardianProgress, NO_GUARDIAN_ID } from 'screens/onboarding/types';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';
import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MeetGuardianPoint {
  /** Stable id, for test hooks: `local-state`, `seed-phrase`, `guardian`. */
  id: string;
  titleKey: string;
  bodyKey: string;
}

/** The three facts the step asks the user to tick before Continue opens. */
export const MEET_GUARDIAN_POINTS: readonly MeetGuardianPoint[] = [
  { id: 'local-state', titleKey: 'meetGuardianLocalStateTitle', bodyKey: 'meetGuardianLocalStateBody' },
  { id: 'seed-phrase', titleKey: 'meetGuardianSeedPhraseTitle', bodyKey: 'meetGuardianSeedPhraseBody' },
  { id: 'guardian', titleKey: 'meetGuardianProtectsTitle', bodyKey: 'meetGuardianProtectsBody' }
];

export interface MeetGuardianScreenProps {
  /** The ticks and the locked operator, owned by the flow so the picker round trip keeps them. */
  progress: MeetGuardianProgress;
  onProgressChange: React.Dispatch<React.SetStateAction<MeetGuardianProgress>>;
  /** The operator Continue picked, or the no-guardian sentinel from the private-account link. */
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  /** The card's Change action: the host pushes the full picker. */
  onChooseDifferent?: () => void;
  /** Dev-gated: offer a fully private account with no guardian co-signer. */
  showNoGuardianOption?: boolean;
}

/**
 * The create flow's guardian step. The fastest reachable operator leads the page on one card: its
 * name, a Change action that opens the full picker, one sentence for what it does, and a "What is a
 * Guardian?" footer that opens the explainer sheet. The three facts about a private account follow,
 * and Continue opens once all three are ticked and the chosen operator has answered online. The
 * operator is chosen once, when every operator has answered its first ping, so the card does not
 * switch operator under the user while later rounds re-check the chosen one. An operator that later
 * goes offline closes Continue and says so on the card.
 * The same card says so when none answers, still offering Change; a network with no operator at all
 * says so and offers nothing to pick.
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
      {/* The Guardian leads the page as one outlined card: who it is and how to change it, then one
          sentence for what it does and does not do. The facts that explain the account follow. */}
      <section data-testid="meet-guardian-section" className="flex shrink-0 flex-col gap-3">
        {/* One card in every state: while the round is out it holds the operator's shape (the logo row,
            the sentence's two lines), so the checklist below barely moves when the operator lands, and
            when none answers its row carries the notice instead. Only the row's content and the sentence
            change between states; the Change action and the footer link keep their place in the tree,
            so a press or focus on either survives the round settling whichever way it goes. */}
        <Card
          surface="outline"
          padding="none"
          data-testid={chosen ? 'meet-guardian-card' : noneReachable ? undefined : 'meet-guardian-checking'}
          aria-busy={!noneReachable && chosenVerdict === undefined}
          className="flex flex-col overflow-hidden"
        >
          <div className="flex items-center gap-3 px-4 py-3.5">
            {chosen ? (
              <GuardianLogoTile guardianId={chosen.id} />
            ) : noneReachable ? null : (
              <Skeleton className="size-12 rounded-xl" />
            )}
            {noneReachable ? (
              <Notice
                tone="negative"
                role="status"
                className="min-w-0 flex-1"
                data-testid="meet-guardian-none-reachable"
              >
                {t('meetGuardianNoneReachable')}
              </Notice>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                {chosen ? (
                  // max-w-full: in an items-start column a truncating span is otherwise as wide as its text.
                  <span className="max-w-full truncate text-row-title text-ink" data-testid="meet-guardian-name">
                    {chosen.name}
                  </span>
                ) : (
                  <Skeleton className="h-4 w-32" />
                )}
                {/* The operator's state takes the label's place until it answers: checking while the card
                    waits on its verdict (Continue waits too), offline if a later round loses it. */}
                {!chosen ? (
                  <span className="text-caption text-muted">{t('meetGuardianChecking')}</span>
                ) : chosenVerdict === undefined ? (
                  <StatusBadge status="checking" live data-testid="meet-guardian-checking-status" />
                ) : chosenVerdict.status === 'offline' ? (
                  <StatusBadge status="offline" live data-testid="meet-guardian-offline" />
                ) : (
                  <span className="text-caption-heading text-muted" data-testid="meet-guardian-header">
                    {t('meetGuardianYourGuardian')}
                  </span>
                )}
              </div>
            )}
            {!noOperators && (
              <TextAction className="-mr-1" data-testid="meet-guardian-choose-different" onClick={onChooseDifferent}>
                {t('meetGuardianChange')}
              </TextAction>
            )}
          </div>
          {/* The sentence once the operator lands; its two lines' placeholder until then. */}
          {!noneReachable && (
            <div className="border-t border-hairline px-4 py-3">
              {chosen ? (
                <p className="text-caption-heading text-muted" data-testid="meet-guardian-summary">
                  {t('meetGuardianSummary', { name: chosen.name })}
                </p>
              ) : (
                <div className="flex w-full flex-col gap-1.5 py-1" aria-hidden>
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3.5 w-2/3" />
                </div>
              )}
            </div>
          )}
          {/* The card's footer: the explainer link on the card's `fill` well under a hairline, there from
              the start like the header link it replaces, so it reads the same while checking. */}
          <div className="border-t border-hairline bg-fill px-3" data-testid="meet-guardian-footer">
            <TextAction data-testid="meet-guardian-info" onClick={() => setIsInfoOpen(true)}>
              {t('whatIsAGuardian')}
            </TextAction>
          </div>
        </Card>
      </section>

      {/* Plain rows on the page, like the testnet notice before it; the hairlines start after the box. */}
      <ListGroup surface="plain" insetHairlines className="shrink-0">
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
