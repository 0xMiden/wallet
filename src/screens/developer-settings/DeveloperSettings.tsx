import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Input } from 'components/Input';
import { ScreenHeader } from 'components/ScreenHeader';
import { TabPicker } from 'components/TabPicker';
import { resetStorageDestructive } from 'lib/miden/reset';
import {
  applyEndpointOverride,
  buildDefaultOverrideFor,
  clearEndpointOverride,
  EndpointOverride,
  getActiveOverride,
  getEffectiveNetworkName
} from 'lib/miden-chain/effective-endpoints';
import { EndpointHealthKind, useEndpointHealth } from 'lib/miden-chain/endpoint-health';
import { hapticMedium } from 'lib/mobile/haptics';
import { goBack, navigate } from 'lib/woozie';

import { CUSTOM_PRESET, ENDPOINT_PRESETS, presetToOverride } from './preset';

type UrlFieldKey =
  | 'rpcUrl'
  | 'proverUrl'
  | 'noteTransportUrl'
  | 'faucetUrl'
  | 'faucetApiUrl'
  | 'explorerUrl'
  | 'guardianUrl';

interface FieldSpec {
  key: UrlFieldKey;
  labelKey: string;
  health: EndpointHealthKind;
}

const FIELDS: FieldSpec[] = [
  { key: 'rpcUrl', labelKey: 'devEndpointRpc', health: 'reachability' },
  { key: 'proverUrl', labelKey: 'devEndpointProver', health: 'reachability' },
  { key: 'noteTransportUrl', labelKey: 'devEndpointNoteTransport', health: 'reachability' },
  { key: 'faucetUrl', labelKey: 'devEndpointFaucet', health: 'reachability' },
  { key: 'faucetApiUrl', labelKey: 'devEndpointFaucetApi', health: 'faucet-api' },
  { key: 'explorerUrl', labelKey: 'devEndpointExplorer', health: 'reachability' },
  { key: 'guardianUrl', labelKey: 'devEndpointGuardian', health: 'reachability' }
];

interface HealthNoteProps {
  url: string;
  kind: EndpointHealthKind;
}

/** Debounced, per-field reachability note rendered below a URL input. Renders nothing until a probe starts. */
const HealthNote: React.FC<HealthNoteProps> = ({ url, kind }) => {
  const { t } = useTranslation();
  const status = useEndpointHealth(url, kind);
  if (status === 'idle') return null;

  const color = status === 'reachable' ? 'text-green-600' : status === 'error' ? 'text-red-500' : 'text-text-muted';
  const labelKey =
    status === 'pending'
      ? 'devEndpointChecking'
      : status === 'reachable'
        ? 'devEndpointReachable'
        : 'devEndpointNoResponse';

  return <p className={`text-xs mt-1 ${color}`}>{t(labelKey)}</p>;
};

export interface DeveloperSettingsProps {
  /** Read-only mode (Settings, post-onboarding): inputs disabled, no preset picker, single reset action. */
  readOnly?: boolean;
}

/**
 * Advanced endpoint override editor. Reused in two modes: edit (reachable during onboarding via
 * the 7-tap logo unlock on Welcome) and read-only (post-onboarding, from Settings, only shown
 * when an override is active).
 */
const DeveloperSettings: React.FC<DeveloperSettingsProps> = ({ readOnly = false }) => {
  const { t } = useTranslation();
  const initial = useMemo<EndpointOverride>(
    () => getActiveOverride() ?? buildDefaultOverrideFor(getEffectiveNetworkName()),
    []
  );
  const [form, setForm] = useState<EndpointOverride>(initial);
  const [saving, setSaving] = useState(false);

  const presetTabs = useMemo(
    () =>
      [
        ...ENDPOINT_PRESETS.map(preset => ({ id: preset, title: preset })),
        { id: CUSTOM_PRESET, title: t('devEndpointCustom') }
      ].map(tab => ({ ...tab, active: form.presetName === tab.id })),
    [form.presetName, t]
  );

  const applyPreset = (index: number) => {
    // `presetTabs` is every known preset followed by one trailing "Custom" tab, so an index
    // past the end of `ENDPOINT_PRESETS` is always that trailing tab.
    const network = ENDPOINT_PRESETS[index];
    if (network) {
      setForm(presetToOverride(network));
      return;
    }
    setForm(prev => ({ ...prev, presetName: CUSTOM_PRESET }));
  };

  const setField = (key: UrlFieldKey, value: string) =>
    setForm(prev => ({ ...prev, [key]: value, presetName: CUSTOM_PRESET }));

  const handleSave = async () => {
    setSaving(true);
    await applyEndpointOverride(form);
    setSaving(false);
    navigate('/');
  };

  const handleReset = async () => {
    hapticMedium();
    await clearEndpointOverride();
    await resetStorageDestructive();
    navigate('/');
  };

  const handleResetToDefaults = () => setForm(buildDefaultOverrideFor(getEffectiveNetworkName()));

  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg">
      <ScreenHeader
        title={t('developerSettingsTitle')}
        backLabel={t('back')}
        onBack={() => goBack()}
        className="mx-4 shrink-0"
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-4 flex flex-col gap-5">
        <div className="w-full bg-surface-input rounded-10 px-4 py-3">
          <div className="text-base font-bold font-heading leading-tight text-black">
            {t('developerSettingsWarningTitle')}
          </div>
          <div className="text-xs mt-1 text-text-muted">{t('developerSettingsWarning')}</div>
        </div>

        {!readOnly && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-heading-gray">{t('devEndpointPreset')}</span>
            <TabPicker tabs={presetTabs} onTabChange={applyPreset} />
          </div>
        )}

        {FIELDS.map(field => (
          <div key={field.key} className="flex flex-col">
            <Input
              label={t(field.labelKey)}
              data-testid={`dev-endpoint-${field.key}`}
              value={form[field.key]}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={readOnly}
              inputClassName="font-mono text-xs select-text"
              onChange={e => setField(field.key, e.target.value)}
            />
            <HealthNote url={form[field.key]} kind={field.health} />
          </div>
        ))}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-heading-gray">{t('devEndpointNetworkId')}</span>
          <TabPicker
            tabs={ENDPOINT_PRESETS.map(network => ({
              id: network,
              title: network,
              active: form.networkName === network
            }))}
            onTabChange={
              readOnly
                ? undefined
                : index => {
                    const network = ENDPOINT_PRESETS[index];
                    if (network) setForm(prev => ({ ...prev, networkName: network, presetName: CUSTOM_PRESET }));
                  }
            }
          />
        </div>
      </div>

      <div className="px-4 pb-8 pt-4 mt-auto flex flex-col gap-3">
        {readOnly ? (
          <Button
            className="w-full justify-center"
            variant={ButtonVariant.Secondary}
            title={t('devEndpointResetAndReonboard')}
            data-testid="dev-endpoints-reset"
            onClick={handleReset}
          />
        ) : (
          <>
            <Button
              className="w-full justify-center"
              variant={ButtonVariant.Primary}
              title={t('devEndpointSaveContinue')}
              isLoading={saving}
              data-testid="dev-endpoints-save"
              onClick={handleSave}
            />
            <Button
              className="w-full justify-center"
              variant={ButtonVariant.Ghost}
              title={t('devEndpointResetDefaults')}
              data-testid="dev-endpoints-reset-defaults"
              onClick={handleResetToDefaults}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default DeveloperSettings;
