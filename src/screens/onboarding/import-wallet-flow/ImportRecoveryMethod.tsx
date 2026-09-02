import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { Input } from 'components/Input';
import { DEFAULT_NETWORK, GUARDIAN_OPTIONS, getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import { isValidGuardianUrl, sanitizeGuardianUrl } from 'lib/settings/helpers';
import { cn } from 'lib/ui/util';

import { GuardianProbeState } from '../types';

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
  onRetryProbe?: () => void;
  // Restore scans public accounts unconditionally and guardian accounts
  // against the submitted endpoint; an empty payload means the user has no
  // guardian (skip).
  onSubmit: (payload: { guardianEndpoint?: string }) => void;
}

export const ImportRecoveryMethodScreen: React.FC<ImportRecoveryMethodScreenProps> = ({
  isError,
  probe,
  onRetryProbe,
  onSubmit
}) => {
  const { t } = useTranslation();

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

  const showError = Boolean(isError) && !dirty;

  const sanitizedEndpoint = sanitizeGuardianUrl(endpointInput);
  // While probing, only a user who explicitly picked an endpoint (via the
  // escape hatch) may continue — their choice wins and the probe is ignored.
  const canContinue = isValidGuardianUrl(sanitizedEndpoint) && (!isProbing || userOverrodeEndpoint);

  const handleContinue = () => {
    hapticLight();
    onSubmit({ guardianEndpoint: sanitizedEndpoint });
  };

  const handleSkipGuardian = () => {
    hapticLight();
    onSubmit({});
  };

  const handleToggleCustom = () => {
    hapticLight();
    // Opening the escape hatch during a probe IS the manual choice: the
    // prefilled endpoint is valid, so Continue must work right away instead of
    // demanding a redundant preset click or keystroke.
    if (isProbing) setUserOverrodeEndpoint(true);
    setIsCustomizing(prev => !prev);
    setDirty(true);
  };

  const handleSelectPreset = (endpoint: string) => {
    hapticLight();
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

  // The preset grid + endpoint readout + URL input. Always on for the classic
  // (no-probe / no-match) screen; behind the "use a custom one instead"
  // disclosure once a guardian has been detected.
  const renderEndpointPicker = (showPresets: boolean) => (
    <>
      {showPresets && (
        <div className="grid grid-cols-3 gap-2">
          {guardianPresets.map(provider => {
            const isActive = !isCustomizing && sanitizedEndpoint === provider.endpoint;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => handleSelectPreset(provider.endpoint)}
                className={cn(
                  'flex flex-col items-start p-2 rounded-lg bg-white text-left border-2 transition-colors',
                  isActive ? 'border-primary-500' : 'border-grey-200'
                )}
              >
                <span className="text-xs font-semibold text-heading-gray leading-tight">{provider.name}</span>
                <span className="text-[10px] text-grey-600 mt-0.5">{provider.location}</span>
              </button>
            );
          })}
        </div>
      )}
      {isCustomizing && (
        <Input
          id="guardian-endpoint-input"
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
    <button
      type="button"
      onClick={handleToggleCustom}
      className="flex items-center gap-1 text-sm text-primary-500 font-medium self-start"
    >
      <span>{label}</span>
      <Icon name={isCustomizing ? IconName.ChevronUp : IconName.ChevronDown} size="sm" />
    </button>
  );

  const renderEndpointReadout = () => (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-grey-600">{t('guardianEndpoint')}</span>
      <span className="text-sm font-inter break-all">{endpointInput}</span>
    </div>
  );

  const renderGuardianBody = () => {
    if (isProbing) {
      return (
        <>
          <div className="flex items-center gap-2" data-testid="guardian-probe-spinner">
            <span className="w-4 h-4 rounded-full border-2 border-grey-200 border-t-primary-500 animate-spin" />
            <span className="text-sm text-grey-600">{t('detectingGuardian')}</span>
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

    // Once the user overrides, the detected banner must go: headlining
    // "found your guardian: B" while Continue submits their manual pick A
    // would contradict the endpoint actually used.
    if (detected && !userOverrodeEndpoint) {
      return (
        <>
          <div className="flex flex-col gap-1" data-testid="guardian-detected">
            <span className="text-sm font-semibold">{t('guardianDetectedTitle', { name: detectedName })}</span>
            {detected.option && <span className="text-xs text-grey-600">{detected.option.location}</span>}
            {probeMatchCount > 1 && <span className="text-xs text-grey-600">{t('guardianDetectedMultiple')}</span>}
          </div>
          {!isCustomizing && renderEndpointReadout()}
          {renderCustomToggle(t('useCustomGuardianInstead'))}
          {renderEndpointPicker(isCustomizing)}
        </>
      );
    }

    return (
      <>
        {probeFinishedWithoutMatch && (
          <div className="flex flex-col gap-1" data-testid="guardian-not-detected">
            <span className="text-sm text-grey-600">{t('guardianNotDetected')}</span>
            {probeFailureCount > 0 && (
              <span className="text-xs text-grey-600">
                {t('guardianProbePartialFailure', { count: probeFailureCount })}
              </span>
            )}
            {onRetryProbe && (
              <button
                type="button"
                onClick={() => {
                  hapticLight();
                  onRetryProbe();
                }}
                className="text-sm text-primary-500 font-medium self-start"
              >
                {t('retryGuardianDetection')}
              </button>
            )}
          </div>
        )}
        {renderEndpointPicker(true)}
        {!isCustomizing && renderEndpointReadout()}
        {renderCustomToggle(t('useDifferentGuardian'))}
      </>
    );
  };

  return (
    <div
      className="flex-1 flex flex-col items-center bg-transparent pt-6 h-full px-4 text-heading-gray gap-6"
      data-testid="import-recovery-method"
    >
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-semibold text-2xl lh-title">{t('guardianEndpointStepTitle')}</h1>
        <p className="text-xs text-center lh-title px-4">{t('guardianEndpointStepDescription')}</p>
      </div>

      <div className="flex flex-col w-full">
        <div className="flex flex-col p-4 rounded-lg bg-white mb-2">
          <div className="flex flex-col gap-2">
            {renderGuardianBody()}
            {showError && <p className="text-red-500 text-xs mt-1">{t('noAccountsFoundForSeed')}</p>}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 self-center w-full mt-auto">
        <Button
          data-testid="recovery-method-continue"
          title={t('continue')}
          onClick={handleContinue}
          disabled={!canContinue}
          className="text-base"
        />
        <Button
          data-testid="recovery-method-skip-guardian"
          title={t('noGuardianSkip')}
          variant={ButtonVariant.Secondary}
          onClick={handleSkipGuardian}
          className="text-base"
        />
      </div>
    </div>
  );
};
