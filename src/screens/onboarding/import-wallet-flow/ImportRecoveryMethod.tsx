import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

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
import { DEFAULT_NETWORK, GUARDIAN_OPTIONS, getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';
import { GuardianProbeState, WalletType } from '../types';

/**
 * How long the "detecting your guardian" state stays modal before the manual
 * escape hatch appears. The probe itself self-resolves well inside 20s (8s per
 * request, at most two sequential requests per task), so this only matters for
 * a user who already knows their operator and doesn't want to wait.
 */
const PROBE_ESCAPE_HATCH_MS = 10_000;

export interface ImportRecoveryMethodScreenProps {
  isError?: boolean;
  /** Guardian auto-detection progress. Omitted => classic manual picker. */
  probe?: GuardianProbeState;
  /**
   * Hot-key import: a pasted hot key only ever belongs to a Guardian multisig
   * account, so the public-account option is hidden and Guardian stays pinned.
   */
  guardianOnly?: boolean;
  onRetryProbe?: () => void;
  onSubmit: (payload: { walletType: WalletType; guardianEndpoint?: string }) => void;
}

export const ImportRecoveryMethodScreen: React.FC<ImportRecoveryMethodScreenProps> = ({
  isError,
  probe,
  guardianOnly = false,
  onRetryProbe,
  onSubmit
}) => {
  const { t } = useTranslation();

  const [selected, setSelected] = useState<WalletType>(WalletType.Guardian);
  const [endpointInput, setEndpointInput] = useState<string>(GUARDIAN_OPTIONS[0]!.endpoint.get(DEFAULT_NETWORK)!);
  const [isCustomizing, setIsCustomizing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [escapeHatchVisible, setEscapeHatchVisible] = useState(false);
  // Once the user picks an endpoint themselves, a probe result that lands
  // afterwards must not silently overwrite their choice — and Continue must
  // work immediately, without waiting for the probe to settle.
  const [userOverrodeEndpoint, setUserOverrodeEndpoint] = useState(false);

  // 'idle' is NOT in-flight: it is the initial / post-reset state, and treating
  // it as probing would pin a spinner that nothing ever resolves. Only an
  // actually running probe blocks the screen.
  const isProbing = probe?.status === 'probing';
  const detected = probe?.status === 'done' ? probe.result.best : undefined;
  const probeMatchCount = probe?.status === 'done' ? probe.result.matches.length : 0;
  const probeFailureCount = probe?.status === 'done' ? probe.result.failures.length : 0;
  const probeFinishedWithoutMatch = (probe?.status === 'done' && !probe.result.best) || probe?.status === 'error';

  // Adopt the detected endpoint unless the user already chose one.
  useEffect(() => {
    if (!detected || userOverrodeEndpoint) return;
    setEndpointInput(detected.endpoint);
  }, [detected, userOverrodeEndpoint]);

  // Escape hatch while probing, so nobody is stuck behind a spinner.
  useEffect(() => {
    if (!isProbing) return;
    setEscapeHatchVisible(false);
    const timer = setTimeout(() => setEscapeHatchVisible(true), PROBE_ESCAPE_HATCH_MS);
    return () => clearTimeout(timer);
  }, [isProbing]);

  const showError = Boolean(isError) && !dirty && selected === WalletType.Guardian;

  const sanitizedEndpoint = sanitizeGuardianUrl(endpointInput);
  const canContinue =
    selected === WalletType.OnChain ||
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

  // Guardian providers that run on the active network, resolved to their
  // endpoint on it.
  const guardianPresets = useMemo(() => getGuardianOptionsForNetwork(), []);

  const detectedName = useMemo(() => {
    if (!detected) return '';
    if (detected.option) return detected.option.name;
    try {
      return new URL(detected.endpoint).hostname;
    } catch {
      return detected.endpoint;
    }
  }, [detected]);

  const options: ChoiceCardItem<WalletType>[] = useMemo(
    () =>
      [
        {
          id: WalletType.Guardian,
          title: t('importViaGuardian'),
          subtitle: t('importViaGuardianDescription'),
          badge: (
            <Pill size="xs" tone="selected" data-testid="default-badge">
              {t('default')}
            </Pill>
          )
        },
        {
          id: WalletType.OnChain,
          title: t('importPublicAccount'),
          subtitle: t('importPublicAccountDescription')
        }
      ].filter(option => !guardianOnly || option.id === WalletType.Guardian),
    [t, guardianOnly]
  );

  const presetItems: ChoiceCardItem[] = guardianPresets.map(provider => ({
    id: provider.id,
    title: provider.name,
    subtitle: provider.location,
    leading: <GuardianLogoTile guardianId={provider.id} />
  }));
  const activePreset = isCustomizing
    ? null
    : (guardianPresets.find(provider => sanitizedEndpoint === provider.endpoint)?.id ?? null);

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
          placeholder={GUARDIAN_OPTIONS[0]!.endpoint.get(DEFAULT_NETWORK)}
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

  const renderEndpointReadout = () => (
    <DetailCard>
      <DetailRow label={t('guardianEndpoint')} stacked>
        <span className="break-all">{endpointInput}</span>
      </DetailRow>
    </DetailCard>
  );

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
        {probeFinishedWithoutMatch && (
          <Notice data-testid="guardian-not-detected">
            <span className="flex flex-col items-start gap-1">
              <span>{t('guardianNotDetected')}</span>
              {probeFailureCount > 0 && <span>{t('guardianProbePartialFailure', { count: probeFailureCount })}</span>}
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

      {/* The guardian's details belong to the Guardian choice, so they open under the cards while it
          is the one chosen. */}
      {selected === WalletType.Guardian && (
        <div className="flex flex-col gap-3">
          {renderGuardianBody()}
          {showError && (
            <Notice tone="negative" role="alert">
              {t('guardianAccountNotFound')}
            </Notice>
          )}
        </div>
      )}
    </OnboardingStepLayout>
  );
};
