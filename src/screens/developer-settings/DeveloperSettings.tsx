import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Checkbox } from 'components/Checkbox';
import { TabPicker } from 'components/TabPicker';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout, SubPageSection } from 'components/ui/SubPageLayout';
import { TextField } from 'components/ui/TextField';
import { clearSyncFuseForEndpointChange } from 'lib/miden/front/sync-fuse';
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

  const color = status === 'reachable' ? 'text-positive-ink' : status === 'error' ? 'text-negative-ink' : 'text-muted';
  const labelKey =
    status === 'pending'
      ? 'devEndpointChecking'
      : status === 'reachable'
        ? 'devEndpointReachable'
        : 'devEndpointNoResponse';

  return <p className={`px-1 font-sans text-[13px] leading-[17px] ${color}`}>{t(labelKey)}</p>;
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
    // Every fuse conclusion was earned against the node this just stopped pointing at.
    // Mobile and desktop are exactly the realms that own the idle loop, so a fused
    // wallet repointed at a working RPC would otherwise probe once per 30 min — and the
    // successful sync that puts the fuse out is the thing it stops giving itself the
    // chance to observe (#777).
    clearSyncFuseForEndpointChange();
    // The native asset and its base fee belong to the node too. The caches drop
    // themselves on the next read (`invalidateOnEndpointChange`), but dropping them
    // notifies nobody — and `useVerificationBaseFee` only re-reads when discovery
    // EMITS. Without a discovery to emit, every mounted screen goes on gating sends and
    // claims on the previous chain's fee until something else happens to ask. Priming
    // here is that discovery.
    //
    // Imported lazily: `native-asset` reads the effective endpoints, so a static import
    // adds this screen to that module cycle. Same reason `native-asset` defers its own
    // `lib/miden/metadata` import.
    void import('lib/miden-chain/native-asset')
      .then(({ primeNativeAssetId }) => primeNativeAssetId())
      .catch(err => console.warn('native-asset prime after endpoint change failed', err));
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
      children: t('devEndpointResetConfirm'),
      confirmLabel: t('reset'),
      destructive: true
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

  const actionButton = 'flex-1 max-w-none';

  return (
    <SubPageLayout
      title={t('developerSettingsTitle')}
      onBack={() => goBack()}
      data-testid="developer-settings"
      footerLayout="stack"
      footer={
        readOnly ? (
          // Destructive: it wipes the wallet and starts onboarding over.
          <Button
            className={actionButton}
            variant={ButtonVariant.Destructive}
            title={t('devEndpointResetAndReonboard')}
            data-testid="dev-endpoints-reset"
            onClick={handleReset}
          />
        ) : (
          <>
            <Button
              className={actionButton}
              variant={ButtonVariant.Primary}
              title={t('devEndpointSaveContinue')}
              isLoading={saving}
              data-testid="dev-endpoints-save"
              onClick={handleSave}
            />
            <Button
              className={actionButton}
              variant={ButtonVariant.Secondary}
              title={t('devEndpointResetDefaults')}
              data-testid="dev-endpoints-reset-defaults"
              onClick={handleResetToDefaults}
            />
          </>
        )
      }
    >
      <SubPageSection title={t('developerSettingsWarningTitle')} description={t('developerSettingsWarning')} />

      {!readOnly && (
        <SubPageSection title={t('devEndpointPreset')}>
          <TabPicker tabs={presetTabs} onTabChange={applyPreset} />
        </SubPageSection>
      )}

      <SubPageSection className="gap-4">
        {FIELDS.map(field => (
          <div key={field.key} className="flex flex-col gap-1">
            <TextField
              label={t(field.labelKey)}
              data-testid={`dev-endpoint-${field.key}`}
              value={form[field.key]}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={readOnly}
              className="font-mono select-text"
              onChange={e => setField(field.key, e.target.value)}
            />
            <HealthNote url={form[field.key]} kind={field.health} />
          </div>
        ))}
      </SubPageSection>

      <SubPageSection title={t('devEndpointNetworkId')}>
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
      </SubPageSection>

      <ListGroup>
        <ListRow
          title={t('devAllowNoGuardian')}
          disabled={readOnly}
          data-testid="dev-allow-no-guardian"
          onClick={() =>
            setForm(prev => ({
              ...prev,
              allowNoGuardian: !prev.allowNoGuardian,
              presetName: CUSTOM_PRESET
            }))
          }
          trailing={<Checkbox value={form.allowNoGuardian} />}
        />
      </ListGroup>
    </SubPageLayout>
  );
};

export default DeveloperSettings;
