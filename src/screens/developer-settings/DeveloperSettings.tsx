import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Checkbox } from 'components/Checkbox';
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
import { isExtension } from 'lib/platform';
import { reloadEndpointOverridesInSW, selectIsIdle, useWalletStore } from 'lib/store';
import { useConfirm } from 'lib/ui/dialog';
import { goBack, navigate } from 'lib/woozie';

import { CUSTOM_PRESET, ENDPOINT_PRESETS, NETWORK_ID_OPTIONS, presetToOverride } from './preset';

/**
 * Enum values (`'testnet'`, `'devnet'`, …) displayed as tab titles — capitalized for display
 * only. Every caller passes a non-empty `MIDEN_NETWORK_NAME` value, so no empty-string guard.
 */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

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
  const confirm = useConfirm();
  const initial = useMemo<EndpointOverride>(
    () => getActiveOverride() ?? buildDefaultOverrideFor(getEffectiveNetworkName()),
    []
  );
  const [form, setForm] = useState<EndpointOverride>(initial);
  const [saving, setSaving] = useState(false);
  // No wallet registered yet, i.e. this screen is reachable but we're still pre-onboarding.
  // `handleSave`'s SW nudge is only safe to send in this state — see its comment.
  const noWalletYet = useWalletStore(selectIsIdle);

  const presetTabs = useMemo(
    () =>
      [
        ...ENDPOINT_PRESETS.map(preset => ({ id: preset, title: capitalize(preset) })),
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
    // On the extension, the service worker is a separate JS realm with its own
    // module-level override cache and a create-once Miden client singleton, so
    // applyEndpointOverride's write doesn't reach it — nudge it to re-hydrate
    // and rebuild before navigating away. Mobile/desktop share this realm, so
    // the override above already took effect and this is a no-op.
    // Only nudge pre-wallet (onboarding): this screen is also reachable read-write
    // from a live, unlocked wallet (it's gated on `!locked`, not `!ready` — see
    // PageRouter), and disposing the SW's Miden client mid-session would tear down
    // an in-progress sync/tx. Once a wallet exists, an override change here still
    // applies to this realm but requires an explicit reload to reach the SW,
    // unchanged from before this nudge existed.
    if (isExtension() && noWalletYet) await reloadEndpointOverridesInSW();
    setSaving(false);
    navigate('/');
  };

  const handleReset = async () => {
    // Destructive: wipes the wallet DB and clears the vault/keys. Gate behind an
    // explicit confirmation (shared app-wide confirm dialog, see options.tsx's
    // "Reset Wallet" for the same pattern) so a single stray tap can't wipe the wallet.
    const confirmed = await confirm({
      title: t('actionConfirmation'),
      children: t('devEndpointResetConfirm')
    });
    if (!confirmed) return;

    hapticMedium();
    await clearEndpointOverride();
    await resetStorageDestructive();
    // Pair the wipe with a reload so no stale in-memory state (e.g. the resolver's
    // override cache) can survive it — mirrors the canonical reset in src/options.tsx.
    if (isExtension()) {
      // Dynamic import: `webextension-polyfill` throws at module-evaluation time when
      // `chrome.runtime.id` is absent, so it must not be a top-level import — this
      // screen is statically imported by PageRouter and evaluates on every platform
      // (desktop has no vite alias for it, unlike mobile). Mirrors src/lib/miden/reset.ts.
      const browser = (await import('webextension-polyfill')).default;
      browser.runtime.reload();
    } else {
      try {
        // mobile/desktop: no background worker to resync with, just reload in place.
        window.location.reload();
      } catch {
        // window.location.reload can't be relied on in every embedding (and can't be
        // mocked in jsdom, since `window.location` is a non-configurable getter) —
        // the storage wipe above already succeeded either way.
        // no-op
      }
    }
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
            tabs={NETWORK_ID_OPTIONS.map(network => ({
              id: network,
              title: capitalize(network),
              active: form.networkName === network
            }))}
            onTabChange={
              readOnly
                ? undefined
                : index => {
                    const network = NETWORK_ID_OPTIONS[index];
                    if (network) setForm(prev => ({ ...prev, networkName: network, presetName: CUSTOM_PRESET }));
                  }
            }
          />
        </div>

        <button
          type="button"
          disabled={readOnly}
          data-testid="dev-allow-no-guardian"
          onClick={
            readOnly
              ? undefined
              : () =>
                  setForm(prev => ({
                    ...prev,
                    allowNoGuardian: !prev.allowNoGuardian,
                    presetName: CUSTOM_PRESET
                  }))
          }
          className="flex items-center justify-between gap-3 text-left"
        >
          <span className="text-sm font-medium text-heading-gray">{t('devAllowNoGuardian')}</span>
          <Checkbox value={form.allowNoGuardian} />
        </button>
      </div>

      <div className="px-4 pb-8 pt-4 mt-auto flex flex-col items-center gap-3">
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
