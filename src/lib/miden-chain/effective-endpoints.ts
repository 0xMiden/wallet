import { Endpoint } from '@miden-sdk/miden-sdk/lazy';

import {
  DEFAULT_NETWORK,
  MIDEN_EXPLORER_ENDPOINTS,
  MIDEN_FAUCET_API_ENDPOINTS,
  MIDEN_FAUCET_ENDPOINTS,
  MIDEN_GUARDIAN_ENDPOINTS,
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_NETWORK_NAME,
  MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS,
  MIDEN_PROVING_ENDPOINTS
} from 'lib/miden-chain/networks-config';
import { getStorageProvider } from 'lib/platform/storage-adapter';

/** Single storage key holding the whole override object. Presence = override active. */
export const ENDPOINT_OVERRIDE_STORAGE_KEY = 'endpoint_overrides';

export interface EndpointOverride {
  rpcUrl: string;
  proverUrl: string;
  noteTransportUrl: string;
  faucetUrl: string;
  faucetApiUrl: string;
  explorerUrl: string;
  guardianUrl: string; // '' = no custom guardian
  allowNoGuardian: boolean; // dev-only: expose a "No guardian" card in onboarding
  networkName: MIDEN_NETWORK_NAME; // the "network id": drives NetworkId + endpoint-default seeding
  presetName: string; // 'testnet'|'devnet'|'localnet'|'custom' — UI dropdown seed only
}

// Build-time NTL env override (mirrors the precedence in constants.getNoteTransportUrl).
const NOTE_TRANSPORT_ENV_OVERRIDE = process.env.MIDEN_NOTE_TRANSPORT_URL || '';

// null = no override active → getters fall back to build defaults keyed by DEFAULT_NETWORK.
let overrideCache: EndpointOverride | null = null;

export function getActiveOverride(): EndpointOverride | null {
  return overrideCache;
}

export function getEffectiveNetworkName(): MIDEN_NETWORK_NAME {
  return overrideCache?.networkName ?? DEFAULT_NETWORK;
}

export function getEffectiveRpcUrl(): string {
  return overrideCache?.rpcUrl || MIDEN_NETWORK_ENDPOINTS.get(getEffectiveNetworkName())!;
}

export function getEffectiveRpcEndpoint(): Endpoint {
  return new Endpoint(getEffectiveRpcUrl());
}

export function getEffectiveProverUrl(): string | undefined {
  return overrideCache?.proverUrl || MIDEN_PROVING_ENDPOINTS.get(getEffectiveNetworkName());
}

export function getEffectiveNoteTransportUrl(): string | undefined {
  return (
    overrideCache?.noteTransportUrl ||
    NOTE_TRANSPORT_ENV_OVERRIDE ||
    MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(getEffectiveNetworkName())
  );
}

export function getEffectiveFaucetUrl(): string {
  return (
    overrideCache?.faucetUrl ||
    MIDEN_FAUCET_ENDPOINTS.get(getEffectiveNetworkName()) ||
    MIDEN_FAUCET_ENDPOINTS.get(DEFAULT_NETWORK)!
  );
}

export function getEffectiveFaucetApiUrl(): string {
  return (
    overrideCache?.faucetApiUrl ||
    MIDEN_FAUCET_API_ENDPOINTS.get(getEffectiveNetworkName()) ||
    MIDEN_FAUCET_API_ENDPOINTS.get(DEFAULT_NETWORK)!
  );
}

export function getEffectiveExplorerUrl(): string | undefined {
  return overrideCache?.explorerUrl || MIDEN_EXPLORER_ENDPOINTS.get(getEffectiveNetworkName());
}

export function getEffectiveGuardianUrl(): string {
  return overrideCache?.guardianUrl ?? '';
}

/** Dev-only: whether onboarding should offer a "No guardian" account option. */
export function getEffectiveAllowNoGuardian(): boolean {
  return overrideCache?.allowNoGuardian ?? false;
}

/**
 * Effective-network default guardian endpoint (custom override first), or '' if
 * none. Non-throwing (mirrors the old `DEFAULT_GUARDIAN_ENDPOINT` const's
 * semantics — a last-resort fallback — but keyed off the effective network
 * rather than the build's `DEFAULT_NETWORK`, so an endpoint override with no
 * custom guardian URL doesn't silently fall back to the build network's
 * guardian). Use `getDefaultGuardianEndpoint()` (constants.ts) instead at
 * Guardian create/import entry points, where an unsupported network should
 * fail loudly rather than resolve to ''.
 */
export function getEffectiveDefaultGuardianEndpoint(): string {
  const custom = getEffectiveGuardianUrl();
  if (custom) return custom;
  return MIDEN_GUARDIAN_ENDPOINTS.get(getEffectiveNetworkName())?.[0] ?? '';
}

/** All fields prefilled from a known network's build defaults. */
export function buildDefaultOverrideFor(network: MIDEN_NETWORK_NAME): EndpointOverride {
  return {
    rpcUrl: MIDEN_NETWORK_ENDPOINTS.get(network) ?? '',
    proverUrl: MIDEN_PROVING_ENDPOINTS.get(network) ?? '',
    noteTransportUrl: MIDEN_NOTE_TRANSPORT_LAYER_ENDPOINTS.get(network) ?? '',
    faucetUrl: MIDEN_FAUCET_ENDPOINTS.get(network) ?? '',
    faucetApiUrl: MIDEN_FAUCET_API_ENDPOINTS.get(network) ?? '',
    explorerUrl: MIDEN_EXPLORER_ENDPOINTS.get(network) ?? '',
    guardianUrl: MIDEN_GUARDIAN_ENDPOINTS.get(network)?.[0] ?? '',
    allowNoGuardian: false,
    networkName: network,
    presetName: network
  };
}

function isEndpointOverride(value: unknown): value is EndpointOverride {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'rpcUrl' in value &&
    'proverUrl' in value &&
    'noteTransportUrl' in value &&
    'faucetUrl' in value &&
    'faucetApiUrl' in value &&
    'explorerUrl' in value &&
    'guardianUrl' in value &&
    'networkName' in value &&
    'presetName' in value &&
    typeof value.rpcUrl === 'string' &&
    typeof value.networkName === 'string'
  );
}

/**
 * Load the persisted override into the sync cache.
 *
 * No-op when the build sets `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES` — a separate
 * flag from `MIDEN_E2E_TEST` on purpose. `MIDEN_E2E_TEST` only means "install
 * the test hooks"; while it also pinned the endpoints, no E2E run could ever
 * exercise the developer endpoint-override flow, because the persisted override
 * was discarded on every load. The E2E build scripts set this flag so the
 * existing suites keep talking to their build-baked network, and a suite that
 * wants to cover overrides can build with the hooks on and this flag off. Unset
 * (every production build) it has no effect.
 */
export async function loadEndpointOverrides(): Promise<void> {
  if (process.env.MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES === 'true') {
    overrideCache = null;
    return;
  }
  try {
    const storage = getStorageProvider();
    const items = await storage.get([ENDPOINT_OVERRIDE_STORAGE_KEY]);
    const raw = items[ENDPOINT_OVERRIDE_STORAGE_KEY];
    overrideCache = isEndpointOverride(raw) ? raw : null;
  } catch {
    overrideCache = null;
  }
}

export async function applyEndpointOverride(override: EndpointOverride): Promise<void> {
  overrideCache = override;
  await getStorageProvider().set({ [ENDPOINT_OVERRIDE_STORAGE_KEY]: override });
}

export async function clearEndpointOverride(): Promise<void> {
  overrideCache = null;
  await getStorageProvider().remove([ENDPOINT_OVERRIDE_STORAGE_KEY]);
}

export async function isEndpointOverrideActive(): Promise<boolean> {
  const items = await getStorageProvider().get([ENDPOINT_OVERRIDE_STORAGE_KEY]);
  return items[ENDPOINT_OVERRIDE_STORAGE_KEY] != null;
}
