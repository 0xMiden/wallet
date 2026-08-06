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
} from 'lib/miden-chain/constants';
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

/** Load the persisted override into the sync cache. No-op under E2E builds. */
export async function loadEndpointOverrides(): Promise<void> {
  if (process.env.MIDEN_E2E_TEST === 'true') {
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
