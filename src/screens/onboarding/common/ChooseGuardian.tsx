import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useGuardianAvailability } from 'app/hooks/useGuardianAvailability';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { StatusBadge } from 'components/ui/StatusBadge';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { TextField } from 'components/ui/TextField';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
import type { GuardianOption } from 'lib/shared/types';
import { NO_GUARDIAN_ID } from 'screens/onboarding/types';

import { GuardianInfoDrawer } from './GuardianInfoDrawer';
import { OnboardingStepLayout } from './OnboardingStepLayout';

export type { GuardianOption };

export interface ChooseGuardianScreenProps {
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  // Highlight (and default-skip) the option matching this endpoint — used by
  // GuardianSettings to mark the user's currently-active guardian.
  currentEndpoint?: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  // When true, hide the page-level header (title/description/learn-more) so the
  // host screen can supply its own framing.
  hideHeader?: boolean;
  // When true, show a "custom Guardian URL" field below the provider grid.
  allowCustomEndpoint?: boolean;
  // Dev-gated (onboarding only): show a selectable "No guardian" card that
  // creates a private single-key account with no guardian co-signer.
  showNoGuardianOption?: boolean;
  // Submission error from the caller, rendered above the Continue button in the pinned
  // footer - not in the scrolling body - so it is capped there and scrolls within its
  // own box rather than growing the footer and pushing Continue off screen (#463).
  error?: string | null;
  // Renders the picker as a pushed page (Rotate Guardian): a header with this
  // back action and the title, instead of an onboarding step's 28px heading.
  onBack?: () => void;
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({
  onSubmit,
  currentEndpoint,
  title,
  description,
  submitLabel,
  hideHeader = false,
  allowCustomEndpoint = false,
  showNoGuardianOption = false,
  error = null,
  onBack
}) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  // Providers that run a Guardian on the active network, resolved to their
  // endpoint on it.
  const options = useMemo(() => getGuardianOptionsForNetwork(), []);

  // Liveness ping per provider so an operator that's down right now is marked
  // offline on its card. An offline card is NOT selectable: an account created
  // against a down operator fails deep in the pipeline, after the user has
  // already backed up a seed phrase and set a password. An endpoint with no
  // verdict yet stays selectable — blocking on a pending ping would make every
  // card dead for the first round trip.
  const endpoints = useMemo(() => options.map(o => o.endpoint), [options]);
  const availability = useGuardianAvailability(endpoints);
  const isOfflineEndpoint = (endpoint: string) => availability[endpoint] === 'offline';

  // In the switch context (GuardianSettings passes `currentEndpoint`) pre-select
  // the CURRENT operator, so the user has to deliberately pick a different one to
  // switch — never nudge them onto another operator by default. In the create
  // flow (no `currentEndpoint`) default to the first provider.
  const defaultId = useMemo(() => {
    if (currentEndpoint) {
      // Sanitized on both sides: a stored endpoint can differ from the option's
      // literal by a trailing slash (RotateGuardian compares them the same way).
      const current = options.find(o => sanitizeGuardianUrl(o.endpoint) === sanitizeGuardianUrl(currentEndpoint));
      if (current) return current.id;
    }
    return options[0]?.id ?? '';
  }, [currentEndpoint, options]);

  // The user's explicit pick, null until they make one. Until then the intent is
  // `defaultId`, so a `currentEndpoint` that resolves after mount (async store
  // hydration) still updates the highlighted card.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const intendedId = pickedId ?? defaultId;

  // The selection Continue will act on. `intendedId` is the intent; the
  // verdicts land AFTER it is known (the map starts empty and re-probes every
  // 30 s), so an intent can point at a card that has since gone offline.
  // Derived rather than stored, so a card that comes back online is simply
  // selected again, and a mid-screen outage cannot submit.
  //
  // - Create flow (no `currentEndpoint`): fall to the first online provider —
  //   the default was only ever "the first one", so the first live one is the
  //   same rule applied to the cards the user can actually pick.
  // - Switch flow: fall to NOTHING. The pre-selected card is the operator the
  //   account is on, and the whole offline-rotation flow starts because that
  //   operator is down. Picking a replacement for the user would nudge them
  //   onto an operator by default, which the pre-selection rule exists to
  //   prevent.
  const intended = options.find(o => o.id === intendedId);
  const effectiveSelectedId =
    intendedId === NO_GUARDIAN_ID
      ? NO_GUARDIAN_ID
      : intended && !isOfflineEndpoint(intended.endpoint)
        ? intended.id
        : currentEndpoint
          ? ''
          : (options.find(o => !isOfflineEndpoint(o.endpoint))?.id ?? '');

  // The group fires the selection haptic, once per real change.
  const handleSelect = (id: string) => {
    setPickedId(id);
    setIsCustom(false);
  };

  // Continue has something to submit: a custom URL (validated on tap), the
  // no-guardian sentinel, or a provider not reported offline. It is dead when
  // every provider is offline, or in the switch flow when the operator the
  // account is on is offline and nothing else is picked; each card says why.
  const canContinue = isCustom || effectiveSelectedId !== '';

  const handleContinue = () => {
    // Custom mode first, because it is the mode the SCREEN is in — the cards and
    // the no-guardian sentinel are all just a stale `pickedId` underneath it
    // (`handleSelect` clears `isCustom`, but nothing clears `pickedId`). Read
    // in the other order, a user who picked "No guardian" and then opened the
    // custom field got their typed URL silently discarded and a guardian-less
    // account instead. No caller passes both affordances today, which is what
    // makes this a latent trap rather than a live bug: one prop combination away.
    if (isCustom) {
      const sanitized = sanitizeGuardianUrl(customUrl);
      if (!isValidGuardianUrl(sanitized)) {
        setCustomError(t('invalidUrl'));
        return;
      }
      setCustomError(null);
      onSubmit?.({ guardianId: 'custom', guardianEndpoint: sanitized });
      return;
    }
    if (effectiveSelectedId === NO_GUARDIAN_ID) {
      onSubmit?.({ guardianId: NO_GUARDIAN_ID, guardianEndpoint: '' });
      return;
    }
    // Continue is disabled while nothing is selectable (`canContinue`), so a click
    // lands here with a selectable id and this guard only narrows the type. No
    // `?? options[0]` fallback: it would submit an offline operator, or in the
    // switch flow one the user did not pick.
    const selected = options.find(o => o.id === effectiveSelectedId);
    if (!selected) return;
    onSubmit?.({ guardianId: selected.id, guardianEndpoint: selected.endpoint });
  };

  const items: ChoiceCardItem[] = options.map(option => {
    const isDefault = option.id === defaultId;
    const isCurrent =
      currentEndpoint != null && sanitizeGuardianUrl(option.endpoint) === sanitizeGuardianUrl(currentEndpoint);
    const isOffline = isOfflineEndpoint(option.endpoint);
    return {
      id: option.id,
      title: option.name,
      subtitle: t('guardianCardMeta', { operator: option.operatedBy, location: option.location }),
      leading: <GuardianLogoTile guardianId={option.id} />,
      // "Current" (the switch flow) or "Default" (the create flow), and the offline verdict beside it,
      // never instead of it: the card most likely to be offline is the one the account is on, and
      // that is exactly when the user needs to see which operator they are leaving.
      badge:
        isCurrent || isDefault || isOffline ? (
          <>
            {isCurrent ? (
              <Pill size="xs" tone="inactive">
                {t('currentLabel')}
              </Pill>
            ) : isDefault ? (
              <Pill size="xs" tone="inactive">
                {t('default')}
              </Pill>
            ) : null}
            {isOffline && <StatusBadge status="offline" data-testid="guardian-offline-banner" />}
          </>
        ) : undefined,
      // A down operator cannot be chosen: an account created against it fails deep in the
      // pipeline, after the user has already backed up a seed phrase and set a password.
      disabled: isOffline,
      data: { 'data-guardian-endpoint': option.endpoint }
    };
  });

  if (showNoGuardianOption) {
    items.push({
      id: NO_GUARDIAN_ID,
      title: t('noGuardianOptionTitle'),
      subtitle: t('noGuardianOptionSubtitle'),
      'data-testid': 'choose-no-guardian'
    });
  }

  const learnMore = (
    <TextAction onClick={() => setIsInfoOpen(true)} className="-mx-1">
      {t('learnMoreAboutGuardian')}
    </TextAction>
  );

  const body = (
    <>
      {/* `isCustom` overrides the cards, matching what Continue will submit: while the custom field
          is the live choice no card may report itself checked. */}
      <ChoiceCardGroup
        items={items}
        value={isCustom || effectiveSelectedId === '' ? null : effectiveSelectedId}
        onChange={handleSelect}
        aria-label={title ?? t('chooseYourGuardian')}
      />

      {allowCustomEndpoint && (
        <div className="flex flex-col items-start gap-2">
          <TextAction
            onClick={() => {
              setIsCustom(prev => !prev);
              setCustomError(null);
            }}
            // A disclosure control: it shows and hides the field below.
            aria-expanded={isCustom}
            aria-controls="custom-guardian-endpoint"
            className="-mx-1"
          >
            {t('useCustomGuardianUrl')}
          </TextAction>
          {isCustom && (
            <TextField
              id="custom-guardian-endpoint"
              containerClassName="w-full"
              value={customUrl}
              placeholder="https://"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              error={customError ?? undefined}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
              onChange={event => {
                setCustomUrl(event.target.value);
                if (customError) setCustomError(null);
              }}
            />
          )}
        </div>
      )}
    </>
  );

  const footer = (
    <>
      {error && (
        <Notice tone="negative" role="alert" className="max-h-24 overflow-y-auto select-text break-words">
          {error}
        </Notice>
      )}
      <Button
        className="max-w-none"
        data-testid="choose-guardian-continue"
        title={submitLabel ?? t('continue')}
        onClick={handleContinue}
        disabled={!canContinue}
      />
    </>
  );

  return (
    <>
      {onBack ? (
        // A pushed page (Rotate Guardian): the title is the header's, and the explainer opens the body.
        <SubPageLayout
          data-testid="onboarding-choose-guardian"
          title={title ?? t('chooseYourGuardian')}
          onBack={onBack}
          footer={footer}
          footerLayout="stack"
        >
          {!hideHeader && (
            <div className="flex flex-col items-start gap-1 px-1">
              <p className="text-explainer text-muted">{description ?? t('chooseGuardianDescription')}</p>
              {learnMore}
            </div>
          )}
          {body}
        </SubPageLayout>
      ) : (
        <OnboardingStepLayout
          data-testid="onboarding-choose-guardian"
          title={hideHeader ? undefined : (title ?? t('chooseYourGuardian'))}
          description={hideHeader ? undefined : (description ?? t('chooseGuardianDescription'))}
          aside={hideHeader ? undefined : learnMore}
          footer={footer}
        >
          {body}
        </OnboardingStepLayout>
      )}

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </>
  );
};

export default ChooseGuardianScreen;
