import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useGuardianPings } from 'app/hooks/useGuardianAvailability';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { Skeleton } from 'components/ui/Skeleton';
import { StatusBadge } from 'components/ui/StatusBadge';
import { TextAction } from 'components/ui/TextAction';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { ResolvedGuardianOption } from 'lib/miden-chain/networks-config';
import { MeetGuardianProgress, NO_GUARDIAN_ID } from 'screens/onboarding/types';

import { GuardianProviderSheet, guardianOperatorCopy } from './GuardianProviderSheet';
import { OnboardingStepLayout } from './OnboardingStepLayout';

export interface MeetGuardianScreenProps {
  /** The locked operator, owned by the flow so leaving the step and coming back keeps it. */
  progress: MeetGuardianProgress;
  onProgressChange: React.Dispatch<React.SetStateAction<MeetGuardianProgress>>;
  /** The operator Continue picked, or the no-guardian sentinel from the private-account link. */
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  /** Dev-gated: offer a fully private account with no guardian co-signer. */
  showNoGuardianOption?: boolean;
}

/**
 * The create flow's guardian step, after the intro said what a Guardian is: who will be the user's. The
 * fastest reachable operator leads the page on its own, its logo centred on rings, its name, its status,
 * one sentence on who runs it and its region; Continue names it, and Change provider opens the operator
 * sheet. The operator is chosen once, when every operator has answered its first ping, so the page does
 * not switch operator under the user while later rounds re-check the chosen one. An operator that later
 * goes offline closes Continue and says so in its status. When none answers the page says so and still
 * offers Change provider; a network with no operator at all says so and offers nothing to pick.
 */
export const MeetGuardianScreen: React.FC<MeetGuardianScreenProps> = ({
  progress,
  onProgressChange,
  onSubmit,
  showNoGuardianOption = false
}) => {
  const { t } = useTranslation();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const { chosenId } = progress;

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
      options.some(option => option.id === prev.chosenId) ? prev : { ...prev, chosenId: fastest.id }
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

  // A pick from the sheet replaces the chosen operator; like the lock-in, a later probe round never swaps it.
  const handlePick = (id: string) =>
    onProgressChange(prev => (prev.chosenId === id ? prev : { ...prev, chosenId: id }));

  const copy = chosen ? guardianOperatorCopy(chosen.id) : undefined;

  return (
    <OnboardingStepLayout
      data-testid="onboarding-meet-guardian"
      title={t('chooseYourGuardian')}
      footer={
        <>
          <Button
            className="max-w-none"
            data-testid="meet-guardian-continue"
            title={chosen ? t('meetGuardianContinueWith', { name: chosen.name }) : t('continue')}
            onClick={handleContinue}
            disabled={!chosenOnline}
          />
          {!noOperators && (
            <TextAction
              className="self-center"
              data-testid="meet-guardian-choose-different"
              onClick={() => setIsSheetOpen(true)}
            >
              {t('meetGuardianChangeProvider')}
            </TextAction>
          )}
          {showNoGuardianOption && (
            <TextAction className="self-center" data-testid="meet-guardian-no-guardian" onClick={handleNoGuardian}>
              {t('meetGuardianFullyPrivateInstead')}
            </TextAction>
          )}
        </>
      }
    >
      {noneReachable ? (
        <Notice tone="negative" role="status" data-testid="meet-guardian-none-reachable">
          {t('meetGuardianNoneReachable')}
        </Notice>
      ) : (
        // One block in every state: while the round is out it holds the operator's shape (the logo, the
        // name, the sentence), so nothing below moves when the operator lands.
        <section
          data-testid={chosen ? 'meet-guardian-card' : 'meet-guardian-checking'}
          aria-busy={chosenVerdict === undefined}
          className="flex shrink-0 flex-col items-center gap-1 text-center"
        >
          {/* On a short screen (an iPhone SE) the rings tighten so the region still shows above the CTA. */}
          <div
            aria-hidden
            className="grid size-55 place-items-center rounded-full bg-fill/40 [@media(max-height:700px)]:size-42"
          >
            <div className="grid size-43 place-items-center rounded-full bg-fill/70 [@media(max-height:700px)]:size-34">
              {chosen ? (
                <GuardianLogoTile guardianId={chosen.id} size="spotlight" />
              ) : (
                <Skeleton className="size-23 rounded-3xl" />
              )}
            </div>
          </div>

          {chosen ? (
            <h2 className="mt-1 text-hero-value text-ink" data-testid="meet-guardian-name">
              {chosen.name}
            </h2>
          ) : (
            <Skeleton className="mt-2 h-8 w-36" />
          )}

          {/* The operator's state: checking while its verdict is out (Continue waits too), offline if a
              later round loses it. */}
          {!chosen ? (
            <span className="text-caption text-muted">{t('meetGuardianChecking')}</span>
          ) : chosenVerdict === undefined ? (
            <StatusBadge status="checking" live data-testid="meet-guardian-checking-status" />
          ) : chosenVerdict.status === 'offline' ? (
            <StatusBadge status="offline" live data-testid="meet-guardian-offline" />
          ) : (
            <StatusBadge status="online" live data-testid="meet-guardian-online" />
          )}

          {chosen ? (
            <p
              className="mt-2 max-w-80 text-body font-semibold text-balance text-muted face-heading"
              data-testid="meet-guardian-summary"
            >
              {copy ? t(copy.aboutKey) : chosen.operatedBy}
            </p>
          ) : (
            <div className="mt-2 flex w-full flex-col items-center gap-1.5" aria-hidden>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {chosen && (
            <Pill size="sm" tone="muted" className="mt-2" data-testid="meet-guardian-region">
              {t('meetGuardianRegion')}
              <span className="ml-1 text-ink">{chosen.location}</span>
            </Pill>
          )}
        </section>
      )}

      <GuardianProviderSheet
        open={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        options={options}
        verdicts={verdicts}
        fastestId={fastest?.id ?? null}
        value={chosen?.id ?? null}
        onPick={handlePick}
      />
    </OnboardingStepLayout>
  );
};

export default MeetGuardianScreen;
