import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useGuardianOptions } from 'app/hooks/useGuardianOptions';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/Button';
import { GuardianLogoTile } from 'components/GuardianLogoTile';
import { Card } from 'components/ui/Card';
import { ChoiceCardGroup, ChoiceCardItem } from 'components/ui/ChoiceCard';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { Spinner } from 'components/ui/Spinner';
import { TextAction } from 'components/ui/TextAction';
import { TextField } from 'components/ui/TextField';
import type { GuardianProbeMatch } from 'lib/miden/guardian/discover';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { isValidGuardianUrl, sameGuardianEndpoint, sanitizeGuardianUrl } from 'lib/settings/helpers';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';
import { ReusedPhraseNotice } from '../common/ReusedPhrase';
import { GuardianProbeState, WalletType } from '../types';

/**
 * How long the "detecting your guardian" state stays modal before the manual
 * escape hatch appears. The probe itself self-resolves well inside 20s (8s per
 * request, at most two sequential requests per task), so this only matters for
 * a user who already knows their operator and doesn't want to wait.
 */
const PROBE_ESCAPE_HATCH_MS = 10_000;

/** The name the screen gives an operator: the built-in's name, else the endpoint's host. */
function operatorName(match: GuardianProbeMatch | undefined): string {
  if (!match) return '';
  if (match.option) return match.option.name;
  try {
    return new URL(match.endpoint).hostname;
  } catch {
    return match.endpoint;
  }
}

export interface ImportRecoveryMethodScreenProps {
  /** The last lookup failure's display text; `undefined`/`null` for none. */
  error?: string | null;
  errorId?: UserErrorId | null;
  /** Guardian auto-detection progress. Omitted => classic manual picker. */
  probe?: GuardianProbeState;
  /**
   * Hot-key import: a pasted hot key only ever belongs to a Guardian multisig
   * account, so the public-account option is hidden and Guardian stays pinned.
   */
  guardianOnly?: boolean;
  /**
   * The network the recovery restores into, whose operators are offered. Omitted => the effective network; a host
   * that switches network only when it registers names it.
   */
  network?: MIDEN_NETWORK_NAME;
  onRetryProbe?: () => void;
  /**
   * Starts a NEW account from the phrase already entered, offered only where a lookup found nothing.
   * Omitted by hosts that cannot create one (a password reset, an invite-only network); a hot-key
   * import never offers it, having no phrase.
   */
  onCreateNew?: () => void;
  onSubmit: (payload: { walletType: WalletType; guardianEndpoint?: string }) => void;
}

export const ImportRecoveryMethodScreen: React.FC<ImportRecoveryMethodScreenProps> = ({
  error,
  errorId = 'raw_import_recovery_lookup_failed',
  probe,
  guardianOnly = false,
  network,
  onRetryProbe,
  onCreateNew,
  onSubmit
}) => {
  const { t } = useTranslation();

  // The first entry of the list discovery probes (the network's operators, then its own custom Guardian), as it stood
  // when the screen opened: a document that lands later must not rewrite a field the user may already have read. A
  // network with none starts on the public account.
  const [defaultEndpoint] = useState<string>(() => getGuardianOptionsForNetwork(network)[0]?.endpoint ?? '');
  const guardianIsDefault = defaultEndpoint !== '';
  const [selected, setSelected] = useState<WalletType>(
    guardianIsDefault || guardianOnly ? WalletType.Guardian : WalletType.OnChain
  );
  const [endpointInput, setEndpointInput] = useState<string>(defaultEndpoint);
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [escapeHatchVisible, setEscapeHatchVisible] = useState(false);
  // Once the user picks an endpoint themselves, a probe result that lands
  // afterwards must not silently overwrite their choice — and Continue must
  // work immediately, without waiting for the probe to settle.
  const [userOverrodeEndpoint, setUserOverrodeEndpoint] = useState(false);
  // A public import creates an account from the phrase when none exists, so it waits for this tick.
  const [reusedPhraseAcknowledged, setReusedPhraseAcknowledged] = useState(false);

  // 'idle' is NOT in-flight: it is the initial / post-reset state, and treating
  // it as probing would pin a spinner that nothing ever resolves. Only an
  // actually running probe blocks the screen.
  const isProbing = probe?.status === 'probing';
  const detected = probe?.status === 'done' ? probe.result.best : undefined;
  const probeMatchCount = probe?.status === 'done' ? probe.result.matches.length : 0;
  const probeFailureCount = probe?.status === 'done' ? probe.result.failures.length : 0;
  const probeFinishedWithoutMatch = (probe?.status === 'done' && !probe.result.best) || probe?.status === 'error';
  // What the lookup established, for a probe that ended with no winner. Only a run in which EVERY Guardian
  // answered, and none knew the account, is "not found": a Guardian that failed to answer may hold the
  // backup, so any failure (or a probe that errored) leaves the answer unknown.
  const lookupVerdict: 'no-backup' | 'uncertain' | 'ambiguous' | null = !probeFinishedWithoutMatch
    ? null
    : probe?.status === 'error'
      ? 'uncertain'
      : probe?.status === 'done' && probe.result.matches.length > 0
        ? 'ambiguous'
        : probeFailureCount > 0
          ? 'uncertain'
          : 'no-backup';
  // An operator that knows the account but serves a state the chain has moved past (#1648): the
  // account left it, most often for a guardian the probe cannot enumerate, so only the user can
  // name the current one. Shown only when nothing current was found.
  const staleOperator =
    probe?.status === 'done' && !probe.result.best
      ? probe.result.matches.find(match => match.holdsCurrentState === false)
      : undefined;

  // Adopt the detected endpoint unless the user already chose one.
  useEffect(() => {
    if (!detected || userOverrodeEndpoint) return;
    setEndpointInput(detected.endpoint);
  }, [detected, userOverrodeEndpoint]);

  // A stale operator opens the URL field, empty: the prefilled default is a listed operator, and
  // the one piece of evidence the probe has says the account is not at the listed ones. The user
  // can still pick a preset through the toggle below the field.
  const staleEndpoint = staleOperator?.endpoint;
  useEffect(() => {
    if (!staleEndpoint || userOverrodeEndpoint) return;
    setIsCustomizing(true);
    setEndpointInput('');
  }, [staleEndpoint, userOverrodeEndpoint]);

  // Escape hatch while probing, so nobody is stuck behind a spinner.
  useEffect(() => {
    if (!isProbing) return;
    setEscapeHatchVisible(false);
    const timer = setTimeout(() => setEscapeHatchVisible(true), PROBE_ESCAPE_HATCH_MS);
    return () => clearTimeout(timer);
  }, [isProbing]);

  const showError = Boolean(error) && !dirty && selected === WalletType.Guardian;

  const sanitizedEndpoint = sanitizeGuardianUrl(endpointInput);
  const canContinue =
    (selected === WalletType.OnChain && reusedPhraseAcknowledged) ||
    // While probing, only a user who explicitly picked an endpoint (via the
    // escape hatch) may continue — their choice wins and the probe is ignored.
    (selected === WalletType.Guardian && isValidGuardianUrl(sanitizedEndpoint) && (!isProbing || userOverrodeEndpoint));

  const handleContinue = () => {
    if (selected === WalletType.OnChain) {
      onSubmit({ walletType: WalletType.OnChain });
      return;
    }
    onSubmit({ walletType: WalletType.Guardian, guardianEndpoint: sanitizedEndpoint });
  };

  const handleSelectGuardian = () => {
    setSelected(WalletType.Guardian);
    setDirty(true);
  };

  const handleSelectOnChain = () => {
    setSelected(WalletType.OnChain);
    setDirty(true);
    setIsCustomizing(false);
  };

  const handleToggleCustom = () => {
    // Opening the escape hatch during a probe IS the manual choice: the
    // prefilled endpoint is valid, so Continue must work right away instead of
    // demanding a redundant preset click or keystroke.
    if (isProbing) setUserOverrodeEndpoint(true);
    setIsCustomizing(prev => !prev);
    setDirty(true);
  };

  const handleSelectPreset = (endpoint: string) => {
    setUserOverrodeEndpoint(true);
    setEndpointInput(endpoint);
    setIsCustomizing(false);
    setDirty(true);
  };

  // Guardian providers that run on the recovery's network, resolved to their
  // endpoint on it.
  const guardianPresets = useGuardianOptions(network);

  const detectedName = useMemo(() => operatorName(detected), [detected]);
  const staleOperatorName = useMemo(() => operatorName(staleOperator), [staleOperator]);

  const options: ChoiceCardItem<WalletType>[] = useMemo(
    () =>
      [
        {
          id: WalletType.Guardian,
          title: t('importViaGuardian'),
          subtitle: t('importViaGuardianDescription'),
          badge: guardianIsDefault ? (
            <Pill size="xs" tone="selected" data-testid="default-badge">
              {t('default')}
            </Pill>
          ) : undefined
        },
        {
          id: WalletType.OnChain,
          title: t('importPublicAccount'),
          subtitle: t('importPublicAccountDescription')
        }
      ].filter(option => !guardianOnly || option.id === WalletType.Guardian),
    [t, guardianOnly, guardianIsDefault]
  );

  const presetItems: ChoiceCardItem[] = guardianPresets.map(provider => ({
    id: provider.id,
    title: provider.name,
    subtitle: provider.location,
    leading: <GuardianLogoTile guardianId={provider.id} />
  }));
  const activePreset = isCustomizing
    ? null
    : (guardianPresets.find(provider => sameGuardianEndpoint(sanitizedEndpoint, provider.endpoint))?.id ?? null);

  const renderEndpointPicker = (showPresets: boolean) => (
    <>
      {showPresets && (
        <ChoiceCardGroup
          items={presetItems}
          value={activePreset}
          onChange={id => {
            const provider = guardianPresets.find(p => p.id === id);
            if (provider) handleSelectPreset(provider.endpoint);
          }}
          aria-label={t('guardianEndpoint')}
        />
      )}
      {isCustomizing && (
        <TextField
          id="guardian-endpoint-input"
          label={t('guardianEndpoint')}
          value={endpointInput}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={defaultEndpoint}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          onChange={event => {
            setUserOverrodeEndpoint(true);
            setEndpointInput(event.target.value);
            setDirty(true);
          }}
        />
      )}
    </>
  );

  const renderCustomToggle = (label: string) => (
    <TextAction onClick={handleToggleCustom} aria-expanded={isCustomizing} className="-mx-1 gap-1 self-start">
      <span>{label}</span>
      <Icon name={isCustomizing ? IconName.ChevronUp : IconName.ChevronDown} size="sm" fill="currentColor" />
    </TextAction>
  );

  const renderEndpointReadout = () =>
    endpointInput ? (
      <DetailCard>
        <DetailRow label={t('guardianEndpoint')} stacked>
          <span className="break-all">{endpointInput}</span>
        </DetailRow>
      </DetailCard>
    ) : null;

  // The way out of "nothing found", set apart from Continue (the recovery) and named for what it does.
  const renderCreateNewOffer = () =>
    onCreateNew && !guardianOnly ? (
      <TextAction data-testid="create-account-with-phrase" onClick={onCreateNew} className="-mx-1 self-start">
        {t('createAccountWithPhrase')}
      </TextAction>
    ) : null;

  const renderGuardianBody = () => {
    if (isProbing) {
      return (
        <>
          <div className="flex items-center gap-2 px-1" data-testid="guardian-probe-spinner">
            <Spinner size="sm" />
            <span className="font-sans text-[15px] leading-[22px] text-muted">{t('detectingGuardian')}</span>
          </div>
          {escapeHatchVisible && (
            <>
              {renderCustomToggle(t('useCustomGuardianInstead'))}
              {isCustomizing && renderEndpointPicker(true)}
            </>
          )}
        </>
      );
    }

    if (detected && !userOverrodeEndpoint) {
      return (
        <>
          <Card padding="row" data-testid="guardian-detected" className="flex items-center gap-3">
            <GuardianLogoTile guardianId={detected.option?.id} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-heading text-base leading-5 font-bold text-ink">
                {t('guardianDetectedTitle', { name: detectedName })}
              </span>
              {detected.option && (
                <span className="font-sans text-[13px] leading-[17px] text-muted">{detected.option.location}</span>
              )}
              {probeMatchCount > 1 && (
                <span className="font-sans text-[13px] leading-[17px] text-muted">{t('guardianDetectedMultiple')}</span>
              )}
            </span>
          </Card>
          {!isCustomizing && renderEndpointReadout()}
          {renderCustomToggle(t('useCustomGuardianInstead'))}
          {renderEndpointPicker(isCustomizing)}
        </>
      );
    }

    return (
      <>
        {lookupVerdict === 'no-backup' && (
          <Notice data-testid="guardian-no-backup" title={t('guardianNoBackupFoundTitle')}>
            {t('guardianNoBackupFoundBody')}
          </Notice>
        )}
        {lookupVerdict === 'no-backup' && renderCreateNewOffer()}
        {(lookupVerdict === 'uncertain' || lookupVerdict === 'ambiguous') && (
          <Notice
            data-testid={
              lookupVerdict === 'uncertain'
                ? 'guardian-lookup-uncertain'
                : staleOperator
                  ? 'guardian-state-behind-chain'
                  : 'guardian-not-detected'
            }
          >
            <span className="flex flex-col items-start gap-1">
              <span>
                {lookupVerdict === 'uncertain'
                  ? t('guardianLookupUncertain')
                  : staleOperator
                    ? t('guardianStateBehindChain', { name: staleOperatorName })
                    : t('guardianNotDetected')}
              </span>
              {onRetryProbe && (
                <TextAction onClick={onRetryProbe} className="-mx-1">
                  {t('retryGuardianDetection')}
                </TextAction>
              )}
            </span>
          </Notice>
        )}
        {renderEndpointPicker(true)}
        {!isCustomizing && renderEndpointReadout()}
        {renderCustomToggle(t('useDifferentGuardian'))}
      </>
    );
  };

  return (
    <OnboardingStepLayout
      data-testid="import-recovery-method"
      title={t('importRecoveryMethodTitle')}
      description={t('chooseRecoveryMethodDescription')}
      footer={
        <Button
          className="max-w-none"
          data-testid="recovery-method-continue"
          title={t('continue')}
          onClick={handleContinue}
          disabled={!canContinue}
        />
      }
    >
      <ChoiceCardGroup
        items={options}
        value={selected}
        onChange={id => (id === WalletType.Guardian ? handleSelectGuardian() : handleSelectOnChain())}
        aria-label={t('importRecoveryMethodTitle')}
      />

      {selected === WalletType.OnChain && (
        <div className="flex flex-col gap-3">
          <ReusedPhraseNotice
            lead={t('publicImportMayCreate')}
            acknowledged={reusedPhraseAcknowledged}
            onAcknowledgedChange={setReusedPhraseAcknowledged}
          />
        </div>
      )}

      {/* The guardian's details belong to the Guardian choice, so they open under the cards while it
          is the one chosen. */}
      {selected === WalletType.Guardian && (
        <div className="flex flex-col gap-3">
          {renderGuardianBody()}
          {showError && (
            <Notice errorId={errorId} tone="negative" role="alert">
              {error}
            </Notice>
          )}
          {showError && errorId === 'guardianAccountNotFound' && renderCreateNewOffer()}
        </div>
      )}
    </OnboardingStepLayout>
  );
};
