import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useGuardianAvailability } from 'app/hooks/useGuardianAvailability';
import { usePageActive } from 'app/layouts/page-active';
import { Button } from 'components/Button';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { TextAction } from 'components/ui/TextAction';
import { TextField } from 'components/ui/TextField';
import { pingGuardianEndpointLatency } from 'lib/miden/guardian/availability';
import { USER_ENDPOINT_CHECK_TIMEOUT_MS } from 'lib/miden/guardian/operator-map';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { isValidGuardianUrl, sameGuardianEndpoint, sanitizeGuardianUrl } from 'lib/settings/helpers';
import type { GuardianOption } from 'lib/shared/types';

import { guardianOperatorCard } from './guardian-operator-card';
import { GuardianInfoDrawer } from './GuardianInfoDrawer';

export type { GuardianOption };

export interface ChooseGuardianScreenProps {
  onSubmit?: (payload: { guardianId: string; guardianEndpoint: string }) => void;
  // The account's current Guardian. The listed operator matching it is pre-selected and badged
  // as current; an endpoint no listed operator matches (a custom Guardian) pre-selects nothing,
  // so Continue waits for a pick or a custom URL. An offline pre-selection is never replaced by
  // another operator.
  currentEndpoint: string;
  // When true, show a "custom Guardian URL" field below the provider grid.
  allowCustomEndpoint?: boolean;
  // Submission error from the caller, rendered above the Continue button in the pinned
  // footer - not in the scrolling body - so it is capped there and scrolls within its
  // own box rather than growing the footer and pushing Continue off screen (#463).
  error?: string | null;
  // The pushed page's header back action.
  onBack: () => void;
}

export const ChooseGuardianScreen: React.FC<ChooseGuardianScreenProps> = ({
  onSubmit,
  currentEndpoint,
  allowCustomEndpoint = false,
  error = null,
  onBack
}) => {
  const { t } = useTranslation();
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [checkingCustom, setCheckingCustom] = useState(false);
  // Numbers the custom-URL checks. Editing the URL, leaving custom mode, leaving the
  // page or unmounting advances it, so a verdict that lands later belongs to a URL no
  // longer on screen and is dropped instead of submitting it.
  const customCheck = useRef(0);
  const abandonCustomCheck = useCallback(() => {
    customCheck.current++;
    setCheckingCustom(false);
  }, []);
  useEffect(
    () => () => {
      customCheck.current++;
    },
    []
  );
  // A page being left stays mounted through its exit animation, so leaving is not an unmount.
  const pageActive = usePageActive();
  useEffect(() => {
    if (!pageActive) abandonCustomCheck();
  }, [pageActive, abandonCustomCheck]);

  // Providers that run a Guardian on the active network, resolved to their
  // endpoint on it.
  const options = useMemo(() => getGuardianOptionsForNetwork(), []);

  // Liveness ping per provider so an operator that's down right now is marked
  // offline on its card. An offline card is NOT selectable: a switch to a down
  // operator fails after review and fresh authentication. An endpoint with no
  // verdict yet stays selectable — blocking on a pending ping would make every
  // card dead for the first round trip.
  const endpoints = useMemo(() => options.map(o => o.endpoint), [options]);
  const availability = useGuardianAvailability(endpoints);
  const isOfflineEndpoint = (endpoint: string) => availability[endpoint] === 'offline';

  // Pre-select the CURRENT operator, so the user has to deliberately pick a different one to
  // switch, never nudging them onto another operator by default. An account on a custom
  // Guardian has no listed operator to pre-select, so nothing is (#1083). Compared as
  // endpoints: a stored endpoint can differ from the option's literal by host case, an explicit
  // default port, or trailing slash (RotateGuardian compares them the same way).
  const currentId = useMemo(
    () => options.find(o => sameGuardianEndpoint(o.endpoint, currentEndpoint))?.id ?? '',
    [currentEndpoint, options]
  );

  // The user's explicit pick, null until they make one. Until a pick the intent is
  // `currentId`, so a `currentEndpoint` that changes after mount (the network default giving
  // way to the account's endpoint) still updates the highlighted card.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const intendedId = pickedId ?? currentId;

  // The selection Continue will act on. `intendedId` is the intent; the
  // verdicts land AFTER it is known (the map starts empty and re-probes every
  // 30 s), so an intent can point at a card that has since gone offline.
  // Derived rather than stored, so a card that comes back online is simply
  // selected again, and a mid-screen outage cannot submit.
  //
  // An intent that is offline falls to NOTHING, never to another operator. A pre-selected card
  // is the operator the account is on, and the whole offline-rotation flow starts because that
  // operator is down; picking a replacement would nudge the user onto an operator by default.
  // An explicit pick that goes offline is the same: the user chose that operator, so the
  // card's offline badge says why it is not selected (#1083).
  const intended = options.find(o => o.id === intendedId);
  const effectiveSelectedId = intended && !isOfflineEndpoint(intended.endpoint) ? intended.id : '';

  // The group fires the selection haptic, once per real change.
  const handleSelect = (id: string) => {
    setPickedId(id);
    setIsCustom(false);
    abandonCustomCheck();
  };

  // The listed operator Continue would submit, if the selection is one.
  const selected = options.find(o => o.id === effectiveSelectedId);

  // Continue has something to submit: a custom URL (validated on tap) or a provider not
  // reported offline. It is dead when every provider is offline, when the user's own pick is
  // offline, or when the current operator is offline or is not a listed provider and nothing
  // else is picked; the offline card explains itself, only where one is offline.
  const canContinue = isCustom || effectiveSelectedId !== '';

  const handleContinue = () => {
    // Custom mode first, because it is the mode the SCREEN is in: the cards are just a stale
    // `pickedId` underneath it (`handleSelect` clears `isCustom`, but nothing clears `pickedId`).
    if (isCustom) {
      if (checkingCustom) return;
      const sanitized = sanitizeGuardianUrl(customUrl);
      if (!isValidGuardianUrl(sanitized)) {
        setCustomError(t('invalidUrl'));
        return;
      }
      setCustomError(null);
      // Refused here, before review and signing, unless a live Guardian answers the
      // GET /pubkey ping the cards use (#1084). Checked once, so on the user-endpoint
      // deadline rather than the repeating card probe's 5 s.
      const check = ++customCheck.current;
      setCheckingCustom(true);
      const settle = (latency: number | null) => {
        if (check !== customCheck.current) return;
        setCheckingCustom(false);
        if (latency === null) {
          setCustomError(t('customGuardianUnreachable'));
          return;
        }
        onSubmit?.({ guardianId: 'custom', guardianEndpoint: sanitized });
      };
      // Defensive, as in useGuardianAvailability: the ping cannot reject, but should it ever,
      // the rejection reads as no Guardian answering rather than leaving Continue busy.
      void pingGuardianEndpointLatency(sanitized, USER_ENDPOINT_CHECK_TIMEOUT_MS).then(settle, () => settle(null));
      return;
    }
    // Continue is disabled while nothing is selectable (`canContinue`), so a click
    // lands here with a submittable id and this guard narrows the type. No
    // `?? options[0]` fallback: it would submit an offline operator, or one the user did not pick.
    if (!selected) return;
    onSubmit?.({ guardianId: selected.id, guardianEndpoint: selected.endpoint });
  };

  const items: ChoiceCardItem[] = options.map(option => {
    const isCurrent = sameGuardianEndpoint(option.endpoint, currentEndpoint);
    // "Current" stays beside the offline verdict: the card most likely to be offline is the one the
    // account is on, and that is exactly when the user needs to see which operator they are leaving.
    const tag = isCurrent ? t('currentLabel') : undefined;
    return guardianOperatorCard({
      option,
      subtitle: t('guardianCardMeta', { operator: option.operatedBy, location: option.location }),
      tag,
      offline: isOfflineEndpoint(option.endpoint)
    });
  });

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
        onReselect={handleSelect}
        aria-label={t('chooseYourGuardian')}
      />

      {allowCustomEndpoint && (
        <div className="flex flex-col items-start gap-2">
          <TextAction
            onClick={() => {
              setIsCustom(prev => !prev);
              setCustomError(null);
              abandonCustomCheck();
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
                abandonCustomCheck();
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
        title={t('continue')}
        onClick={handleContinue}
        disabled={!canContinue}
        isLoading={checkingCustom}
      />
    </>
  );

  return (
    <>
      {/* The title is the header's; the explainer opens the body. */}
      <SubPageLayout
        data-testid="onboarding-choose-guardian"
        title={t('chooseYourGuardian')}
        onBack={onBack}
        footer={footer}
        footerLayout="stack"
      >
        <div className="flex flex-col items-start gap-1 px-1">
          <p className="text-explainer text-muted">{t('chooseGuardianDescription')}</p>
          {learnMore}
        </div>
        {body}
      </SubPageLayout>

      <GuardianInfoDrawer open={isInfoOpen} onOpenChange={setIsInfoOpen} />
    </>
  );
};

export default ChooseGuardianScreen;
