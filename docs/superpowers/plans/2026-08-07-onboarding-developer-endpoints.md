# Onboarding Developer Endpoint Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an advanced user override every network endpoint from a hidden "Developer Settings" screen reached by tapping the Bread logo 7× on the onboarding Welcome screen, persisted so the fresh wallet is built on the chosen endpoints; read-only + reset-to-defaults afterward in Settings.

**Architecture:** A new `effective-endpoints.ts` resolver holds a sync in-memory override cache (null = build defaults) plus async `loadEndpointOverrides()` (called at both bootstrap points: SW `start()` and the frontend `MidenProvider` gate). Existing `constants.ts` getters delegate to the resolver so their consumers become override-aware for free; the handful of direct `MAP.get(DEFAULT_NETWORK)` reads are repointed to resolver getters. A full-screen `/developer-settings` route hosts the form (preset segmented control + per-field URL inputs + non-blocking health notes), reused read-only from Settings.

**Tech Stack:** TypeScript, React, Zustand, woozie router, Jest + React Testing Library, Tailwind (theme-var tokens), i18n (react-i18next + `public/_locales/en/en.json`), Capacitor/extension/Tauri storage adapter.

## Global Constraints

- Node >= 22 (`source ~/.nvm/nvm.sh && nvm use 22` before yarn).
- **No `any`, no `as`** — concrete types only (repo style). Prettier: 120 cols, single quotes, semicolons, trailing commas.
- **All user-facing strings via `t('key')`** with keys in `public/_locales/en/en.json` (flat `"key": "value"`); CI `yarn lint:i18n` fails on bare JSX literals.
- **Coverage gate: 95% branches/functions/lines/statements** (`jest.config.ts`, `collectCoverageFrom` = all `src/**/*.{ts,tsx}`). Every new `.ts/.tsx` ships with tests or it reports 0% and fails CI. Run `yarn test:coverage` before the final commit.
- **E2E must not break:** with no `endpoint_overrides` key, every resolver getter must return exactly today's build-token value (pure-refactor invariant). `loadEndpointOverrides()` is a **no-op under `process.env.MIDEN_E2E_TEST === 'true'`** (safeguard). Preserve the `MIDEN_NOTE_TRANSPORT_URL` env override precedence.
- **Never `git push`; never amend; single-line commit messages; no `Co-Authored-By`.**
- Path aliases in imports: `lib/…`, `app/…`, `components/…`, `screens/…`, `utils/…` (not deep relative paths).
- Run a single test file with `yarn test <path>` (arg is a filename regex).

**Deferred (explicitly out of scope for v1, flagged for user sign-off):** dynamic app theming based on the override (the `isDevnet` accent-color ripple in `brand-colors.ts` / `Settings.tsx` / `icons/v2`). The accent color stays keyed to the build network; only functional endpoint + `NetworkId` resolution is dynamic. Live re-pointing of an existing wallet (post-onboarding is reset-only).

---

## File Structure

**New files:**
- `src/lib/miden-chain/effective-endpoints.ts` — override type, storage key, sync cache, load/apply/clear, effective getters.
- `src/lib/miden-chain/effective-endpoints.test.ts` — resolver unit tests.
- `src/lib/miden-chain/endpoint-health.ts` — `probeEndpointHealth(url, kind)` + `useEndpointHealth` hook.
- `src/lib/miden-chain/endpoint-health.test.ts` — health probe/hook tests.
- `src/screens/developer-settings/DeveloperSettings.tsx` — the full-screen form (edit + read-only modes).
- `src/screens/developer-settings/DeveloperSettings.test.tsx` — screen component tests.
- `src/screens/developer-settings/preset.ts` — preset → field-values mapping helper (pure, testable).
- `src/screens/developer-settings/preset.test.ts` — preset helper tests.

**Modified files:**
- `src/lib/miden-chain/constants.ts` — getters delegate to resolver (`getRpcEndpoint`, `getNetworkId`, `getDefaultGuardianEndpoint`, `getGuardianOptionsForNetwork`, `getExplorerTxUrl`); no behavior change when no override.
- `src/lib/miden-chain/faucet.ts`, `faucet-api.ts` — delegate to resolver getters.
- `src/lib/miden-chain/native-asset.ts` — cache keys keyed on effective network name.
- `src/lib/miden/sdk/miden-client-interface.ts` — repoint the 4 direct RPC/prover/NTL reads.
- `src/lib/miden/transaction/index.ts` (L445, L713), `src/lib/miden/back/simulate-custom-tx.ts` (L86) — repoint direct RPC reads.
- `src/lib/miden/back/main.ts` — `await loadEndpointOverrides()` in `start()`.
- `src/lib/miden/front/provider.tsx` — load overrides in the readiness gate; `sdkConfig` via resolver.
- `src/screens/onboarding/common/Welcome.tsx` — 7-tap unlock on the logo + text-selection prevention.
- `src/app/PageRouter.tsx` — register `/developer-settings`.
- `src/app/pages/Settings.tsx` — hidden-unless-override "Network endpoints" entry (read-only) + reset.
- `public/_locales/en/en.json` — new i18n keys.
- `CHANGELOG.md` — one-liner under the current `(TBD)` section.

---

## Task 1: Effective-endpoints resolver

**Files:**
- Create: `src/lib/miden-chain/effective-endpoints.ts`
- Test: `src/lib/miden-chain/effective-endpoints.test.ts`

**Interfaces:**
- Consumes: build maps + `DEFAULT_NETWORK` + `MIDEN_NETWORK_NAME` from `lib/miden-chain/constants`; `getStorageProvider` from `lib/platform/storage-adapter`; `Endpoint` from `@miden-sdk/miden-sdk/lazy`.
- Produces (used by later tasks): `EndpointOverride` (interface), `ENDPOINT_OVERRIDE_STORAGE_KEY: string`, `getEffectiveNetworkName(): MIDEN_NETWORK_NAME`, `getEffectiveRpcUrl(): string`, `getEffectiveRpcEndpoint(): Endpoint`, `getEffectiveProverUrl(): string | undefined`, `getEffectiveNoteTransportUrl(): string | undefined`, `getEffectiveFaucetUrl(): string`, `getEffectiveFaucetApiUrl(): string`, `getEffectiveExplorerUrl(): string | undefined`, `getEffectiveGuardianUrl(): string`, `buildDefaultOverrideFor(network): EndpointOverride`, `getActiveOverride(): EndpointOverride | null`, `loadEndpointOverrides(): Promise<void>`, `applyEndpointOverride(o): Promise<void>`, `clearEndpointOverride(): Promise<void>`, `isEndpointOverrideActive(): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/miden-chain/effective-endpoints.test.ts
import { MIDEN_NETWORK_NAME, MIDEN_NETWORK_ENDPOINTS } from './constants';

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      Object.assign(mockKvStore, obj);
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete mockKvStore[k];
    }
  }),
  StorageProvider: class {}
}));

function loadModule(): typeof import('./effective-endpoints') {
  let mod!: typeof import('./effective-endpoints');
  jest.isolateModules(() => {
    mod = require('./effective-endpoints');
  });
  return mod;
}

beforeEach(() => {
  for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
  delete process.env.MIDEN_E2E_TEST;
});

describe('effective-endpoints resolver', () => {
  it('returns build defaults when no override is loaded', () => {
    const m = loadModule();
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(m.getEffectiveNetworkName()));
    expect(m.getActiveOverride()).toBeNull();
  });

  it('applies and persists an override, then reads it back on reload', async () => {
    const m = loadModule();
    const override = m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    override.rpcUrl = 'https://custom.example/rpc';
    await m.applyEndpointOverride(override);
    expect(m.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect(m.getEffectiveNetworkName()).toBe(MIDEN_NETWORK_NAME.DEVNET);

    const m2 = loadModule(); // fresh module = cache reset
    expect(m2.getActiveOverride()).toBeNull();
    await m2.loadEndpointOverrides();
    expect(m2.getEffectiveRpcUrl()).toBe('https://custom.example/rpc');
    expect(await m2.isEndpointOverrideActive()).toBe(true);
  });

  it('clear() removes the override and reverts to defaults', async () => {
    const m = loadModule();
    await m.applyEndpointOverride(m.buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET));
    await m.clearEndpointOverride();
    expect(m.getActiveOverride()).toBeNull();
    expect(await m.isEndpointOverrideActive()).toBe(false);
  });

  it('loadEndpointOverrides is a no-op under MIDEN_E2E_TEST', async () => {
    mockKvStore['endpoint_overrides'] = { rpcUrl: 'https://should.ignore/rpc' };
    process.env.MIDEN_E2E_TEST = 'true';
    const m = loadModule();
    await m.loadEndpointOverrides();
    expect(m.getActiveOverride()).toBeNull();
    expect(m.getEffectiveRpcUrl()).toBe(MIDEN_NETWORK_ENDPOINTS.get(m.getEffectiveNetworkName()));
  });

  it('note-transport env override wins over the per-network default but loses to an explicit override', () => {
    process.env.MIDEN_NOTE_TRANSPORT_URL = 'http://env.local/ntl';
    const m = loadModule();
    expect(m.getEffectiveNoteTransportUrl()).toBe('http://env.local/ntl');
    delete process.env.MIDEN_NOTE_TRANSPORT_URL;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden-chain/effective-endpoints.test.ts`
Expected: FAIL — cannot find module `./effective-endpoints`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/miden-chain/effective-endpoints.ts
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

/** Load the persisted override into the sync cache. No-op under E2E builds. */
export async function loadEndpointOverrides(): Promise<void> {
  if (process.env.MIDEN_E2E_TEST === 'true') {
    overrideCache = null;
    return;
  }
  try {
    const storage = getStorageProvider();
    const items = await storage.get([ENDPOINT_OVERRIDE_STORAGE_KEY]);
    const stored = items[ENDPOINT_OVERRIDE_STORAGE_KEY] as EndpointOverride | undefined;
    overrideCache = stored ?? null;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/miden-chain/effective-endpoints.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden-chain/effective-endpoints.ts src/lib/miden-chain/effective-endpoints.test.ts
git commit -m "feat(dev-endpoints): effective-endpoints resolver with override cache"
```

---

## Task 2: Delegate constants.ts getters to the resolver

Make the already-function getters read effective values, so every existing consumer becomes override-aware without edits. Verify the pure-refactor invariant (no override ⇒ identical output).

**Files:**
- Modify: `src/lib/miden-chain/constants.ts` (`getNetworkId` ~251, `getRpcEndpoint` ~274, `getDefaultGuardianEndpoint` ~240, `getGuardianOptionsForNetwork` ~178, `getExplorerTxUrl` ~79)
- Modify: `src/lib/miden-chain/faucet.ts`, `src/lib/miden-chain/faucet-api.ts`
- Modify: `src/lib/miden-chain/native-asset.ts` (cache keys ~10-11)
- Test: `src/lib/miden-chain/constants.delegation.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 getters. Produces: no new symbols (same signatures, override-aware behavior). Import direction is constants → effective-endpoints inside function bodies only (no module-eval cycle: effective-endpoints reads constants' maps only inside its own function bodies).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/miden-chain/constants.delegation.test.ts
import {
  applyEndpointOverride,
  buildDefaultOverrideFor,
  clearEndpointOverride
} from './effective-endpoints';
import { getExplorerTxUrl, getGuardianOptionsForNetwork, MIDEN_NETWORK_NAME } from './constants';

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => Object.assign(mockKvStore, obj),
    remove: async (keys: string[]) => keys.forEach(k => delete mockKvStore[k])
  }),
  StorageProvider: class {}
}));

afterEach(async () => {
  await clearEndpointOverride();
  for (const k of Object.keys(mockKvStore)) delete mockKvStore[k];
});

describe('constants getters delegate to the override', () => {
  it('getGuardianOptionsForNetwork appends a Custom option when a guardian override is set', async () => {
    const override = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET);
    override.guardianUrl = 'https://custom.guardian.example';
    await applyEndpointOverride(override);
    const options = getGuardianOptionsForNetwork();
    const custom = options.find(o => o.id === 'custom');
    expect(custom?.endpoint).toBe('https://custom.guardian.example');
  });

  it('getExplorerTxUrl uses the effective explorer', async () => {
    const override = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.TESTNET);
    override.explorerUrl = 'https://scan.example';
    await applyEndpointOverride(override);
    expect(getExplorerTxUrl('0xabc')).toBe('https://scan.example/tx/0xabc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden-chain/constants.delegation.test.ts`
Expected: FAIL — no `custom` option; explorer uses build default.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/miden-chain/constants.ts`, add near the other imports (top of file, after line 1):

```ts
import {
  getEffectiveExplorerUrl,
  getEffectiveGuardianUrl,
  getEffectiveNetworkName,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
```

Replace `getExplorerTxUrl` (lines 79-82) with:

```ts
export function getExplorerTxUrl(txHash: string, network: string = getEffectiveNetworkName()): string | undefined {
  const base = network === getEffectiveNetworkName() ? getEffectiveExplorerUrl() : MIDEN_EXPLORER_ENDPOINTS.get(network);
  return base ? `${base}/tx/${txHash}` : undefined;
}
```

Replace the body of `getGuardianOptionsForNetwork` (lines 178-200) so it defaults to the effective network and appends a Custom option:

```ts
export function getGuardianOptionsForNetwork(
  network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()
): ResolvedGuardianOption[] {
  const options = GUARDIAN_OPTIONS.filter(o => o.endpoint.has(network)).map(o => ({
    id: o.id,
    name: o.name,
    operatedBy: o.operatedBy,
    location: o.location,
    endpoint: o.endpoint.get(network)!
  }));

  // Localnet E2E only: expose a second guardian instance (container at :3001).
  if (network === MIDEN_NETWORK_NAME.LOCALNET && process.env.MIDEN_E2E_TEST === 'true') {
    options.push({
      id: 'open-zeppelin-b',
      name: 'OpenZeppelin B',
      operatedBy: 'Open-Zeppelin',
      location: 'US-EAST',
      endpoint: 'http://localhost:3001'
    });
  }

  // Developer override: a custom guardian URL is offered as an extra selectable option.
  const customGuardian = getEffectiveGuardianUrl();
  if (customGuardian && !options.some(o => o.endpoint === customGuardian)) {
    options.push({
      id: 'custom',
      name: 'Custom',
      operatedBy: 'Custom',
      location: '—',
      endpoint: customGuardian
    });
  }

  return options;
}
```

Replace `getDefaultGuardianEndpoint` (lines 240-246) with:

```ts
export function getDefaultGuardianEndpoint(): string {
  const custom = getEffectiveGuardianUrl();
  if (custom) return custom;
  const network = getEffectiveNetworkName();
  const endpoints = MIDEN_GUARDIAN_ENDPOINTS.get(network);
  if (!endpoints || endpoints.length === 0) {
    throw new Error(`Guardian is not available on network "${network}": no Guardian endpoint is configured.`);
  }
  return endpoints[0]!;
}
```

Replace `getNetworkId` (lines 251-265) so it switches on the effective network:

```ts
export function getNetworkId(): NetworkId {
  const network: string = getEffectiveNetworkName();
  switch (network) {
    /* c8 ignore start */
    case MIDEN_NETWORK_NAME.MAINNET:
      return NetworkId.mainnet();
    case MIDEN_NETWORK_NAME.DEVNET:
      return NetworkId.devnet();
    /* c8 ignore stop */
    case MIDEN_NETWORK_NAME.TESTNET:
    case MIDEN_NETWORK_NAME.LOCALNET:
    default:
      return NetworkId.testnet();
  }
}
```

Replace `getRpcEndpoint` (lines 274-277) with:

```ts
export function getRpcEndpoint(): Endpoint {
  return new Endpoint(getEffectiveRpcUrl());
}
```

In `src/lib/miden-chain/faucet.ts`, replace the whole file with:

```ts
import { getEffectiveFaucetUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_FAUCET_ENDPOINTS } from './constants';

import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

export function getFaucetUrl(networkId: string): string {
  if (networkId === getEffectiveNetworkName()) return getEffectiveFaucetUrl();
  return MIDEN_FAUCET_ENDPOINTS.get(networkId) ?? getEffectiveFaucetUrl();
}
```

In `src/lib/miden-chain/faucet-api.ts`, replace `getFaucetApiUrl` (lines 13-15) with:

```ts
export function getFaucetApiUrl(networkId: string = getEffectiveNetworkName()): string {
  if (networkId === getEffectiveNetworkName()) return getEffectiveFaucetApiUrl();
  return MIDEN_FAUCET_API_ENDPOINTS.get(networkId) ?? getEffectiveFaucetApiUrl();
}
```
and add to its imports (line 1 area):
```ts
import { getEffectiveFaucetApiUrl, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
```

In `src/lib/miden-chain/native-asset.ts`, replace lines 10-11 (cache keys) so they use the effective network name (keeps keys correct across an override):

```ts
const ID_CACHE_KEY = `native_asset_id:v2:${getEffectiveNetworkName()}`;
const META_CACHE_KEY = `native_asset_meta:v2:${getEffectiveNetworkName()}`;
```
and add to its imports (line 6 area):
```ts
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
```
> Note: these are module-eval'd consts read once at import. Because `loadEndpointOverrides()` runs at bootstrap **before** `native-asset` is first imported by a consumer, and this file is imported lazily via `getRpcEndpoint()` paths, the effective name is correct. If a stale-key edge case appears, convert to functions in a follow-up — not needed for v1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/lib/miden-chain/constants.delegation.test.ts src/lib/miden-chain/constants.test.ts`
Expected: PASS. (`constants.test.ts` continues to pass, proving the no-override invariant. If a `constants.test.ts` case mocks `IS_GUARDIAN_SUPPORTED`, it is unaffected — that const is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden-chain/constants.ts src/lib/miden-chain/faucet.ts src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/native-asset.ts src/lib/miden-chain/constants.delegation.test.ts
git commit -m "feat(dev-endpoints): constants getters delegate to effective-endpoints resolver"
```

---

## Task 3: Repoint direct map-read consumers

Repoint the sites that read `MIDEN_NETWORK_ENDPOINTS.get(...)`/`MIDEN_PROVING_ENDPOINTS.get(...)`/`getNoteTransportUrl(...)` directly (they bypass the delegating getters).

**Files:**
- Modify: `src/lib/miden/sdk/miden-client-interface.ts` (imports L30-34; create() L204/205/214; L349; L499)
- Modify: `src/lib/miden/transaction/index.ts` (import L17; L445; L713)
- Modify: `src/lib/miden/back/simulate-custom-tx.ts` (import L7; L86)
- Test: `src/lib/miden/sdk/miden-client-interface.endpoints.test.ts` (new, focused)

**Interfaces:** Consumes Task 1 getters. Produces: no new symbols.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/miden/sdk/miden-client-interface.endpoints.test.ts
import { applyEndpointOverride, buildDefaultOverrideFor } from 'lib/miden-chain/effective-endpoints';
import {
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

const mockKvStore: Record<string, unknown> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in mockKvStore) out[k] = mockKvStore[k];
      return out;
    },
    set: async (obj: Record<string, unknown>) => Object.assign(mockKvStore, obj),
    remove: async (keys: string[]) => keys.forEach(k => delete mockKvStore[k])
  }),
  StorageProvider: class {}
}));

// Guards the invariant that the resolver is the single source the client reads from.
describe('client endpoint resolution honors the override', () => {
  it('effective getters reflect a saved override', async () => {
    const o = buildDefaultOverrideFor(MIDEN_NETWORK_NAME.DEVNET);
    o.rpcUrl = 'https://c/rpc';
    o.proverUrl = 'https://c/prover';
    o.noteTransportUrl = 'https://c/ntl';
    await applyEndpointOverride(o);
    expect(getEffectiveRpcUrl()).toBe('https://c/rpc');
    expect(getEffectiveProverUrl()).toBe('https://c/prover');
    expect(getEffectiveNoteTransportUrl()).toBe('https://c/ntl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/sdk/miden-client-interface.endpoints.test.ts`
Expected: PASS already for the getter assertions (they come from Task 1) — this test locks the contract the repoints must honor. If it errors on import resolution, that's the real failure to fix. (This task is primarily mechanical repointing verified by the full suite in Step 4.)

- [ ] **Step 3: Write minimal implementation**

In `src/lib/miden/sdk/miden-client-interface.ts`, change the import block (L30-34) from the constants tokens to the resolver getters:

```ts
// remove DEFAULT_NETWORK, MIDEN_NETWORK_ENDPOINTS, MIDEN_PROVING_ENDPOINTS, getNoteTransportUrl
// from the 'lib/miden-chain/constants' import, and add:
import {
  getEffectiveNoteTransportUrl,
  getEffectiveNetworkName,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
```

In `create()` (L193-214) replace:
```ts
    const network = DEFAULT_NETWORK;
```
with
```ts
    const network = getEffectiveNetworkName();
```
and the client options:
```ts
      rpcUrl: getEffectiveRpcUrl(),
      noteTransportUrl: getEffectiveNoteTransportUrl(),
      ...
      proverUrl: getEffectiveProverUrl(),
```
(`return new MidenClientInterface(midenClient, network)` stays — `network` is now the effective name.)

At L349 replace `midenRpcEndpoint: MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!` with:
```ts
        midenRpcEndpoint: getEffectiveRpcUrl()
```

At L499 replace `WasmWebClient.createClient(MIDEN_NETWORK_ENDPOINTS.get(this.network)!)` with:
```ts
    const inner = await WasmWebClient.createClient(getEffectiveRpcUrl());
```

In `src/lib/miden/transaction/index.ts`: change import L17 to
```ts
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
```
and at L445 and L713 replace `WasmWebClient.createClient(MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!)` with:
```ts
    const client = await WasmWebClient.createClient(getEffectiveRpcUrl());
```
(indentation matches each site).

In `src/lib/miden/back/simulate-custom-tx.ts`: change import L7 to
```ts
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
```
and at L86 replace `MIDEN_NETWORK_ENDPOINTS.get(DEFAULT_NETWORK)!` with `getEffectiveRpcUrl()`.

> Leave `src/app/pages/Explore.tsx:171` unchanged: it hardcodes `MIDEN_NETWORK_NAME.DEVNET` and its caller is commented out (dead). Repointing would change behavior on non-devnet builds for no benefit.

- [ ] **Step 4: Run tests + typecheck to verify no regression**

Run: `yarn test src/lib/miden/sdk/miden-client-interface.endpoints.test.ts && yarn test src/lib/miden/sdk && yarn ts`
Expected: PASS; `yarn ts` reports no type errors (no dangling `DEFAULT_NETWORK`/`MIDEN_NETWORK_ENDPOINTS` references in the edited files).

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden/sdk/miden-client-interface.ts src/lib/miden/transaction/index.ts src/lib/miden/back/simulate-custom-tx.ts src/lib/miden/sdk/miden-client-interface.endpoints.test.ts
git commit -m "feat(dev-endpoints): repoint direct client endpoint reads at the resolver"
```

---

## Task 4: Bootstrap wiring (SW backend + frontend provider gate)

Load overrides before any client is created, in both contexts.

**Files:**
- Modify: `src/lib/miden/back/main.ts` (`start()` ~21-28)
- Modify: `src/lib/miden/front/provider.tsx` (imports; readiness gate ~105-117; `getMidenClient` effect ~61-72; `sdkConfig` ~82-97)
- Test: `src/lib/miden/front/provider.overrides.test.tsx` (new)

**Interfaces:** Consumes `loadEndpointOverrides` + effective getters (Task 1). Produces: no new symbols.

- [ ] **Step 1: Write the failing test**

```tsx
// src/lib/miden/front/provider.overrides.test.tsx
import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

const loadEndpointOverrides = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  loadEndpointOverrides: () => loadEndpointOverrides(),
  getEffectiveRpcUrl: () => 'https://rpc.test',
  getEffectiveProverUrl: () => 'https://prover.test',
  getEffectiveNoteTransportUrl: () => 'https://ntl.test'
}));

const ensureSdkWasmReady = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: () => ensureSdkWasmReady() }));

jest.mock('lib/platform', () => ({ isExtension: () => true, isMobile: () => false }));
jest.mock('lib/store/WalletStoreProvider', () => ({ WalletStoreProvider: ({ children }: any) => <>{children}</> }));
jest.mock('lib/miden/front/client', () => ({ MidenContextProvider: ({ children }: any) => <>{children}</> }));
jest.mock('@miden-sdk/react', () => ({ SdkMidenProvider: ({ children }: any) => <>{children}</> }));
jest.mock('./ConditionalProviders', () => ({ ConditionalProviders: ({ children }: any) => <>{children}</> }), {
  virtual: true
});

import { MidenProvider } from './provider';

it('loads endpoint overrides before rendering children', async () => {
  render(
    <MidenProvider>
      <div data-testid="child" />
    </MidenProvider>
  );
  await waitFor(() => expect(screen.getByTestId('child')).toBeInTheDocument());
  expect(loadEndpointOverrides).toHaveBeenCalledTimes(1);
});
```
> Adjust the `ConditionalProviders` mock path/name to match the real import in `provider.tsx` when implementing.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/front/provider.overrides.test.tsx`
Expected: FAIL — `loadEndpointOverrides` not called (gate doesn't await it yet).

- [ ] **Step 3: Write minimal implementation**

`src/lib/miden/back/main.ts` — add import and the load call inside `start()` (after `intercom.onRequest(processRequest)`, before `await Actions.init()`):

```ts
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
// ...
export async function start() {
  console.log('Miden background script started');
  intercom.onRequest(processRequest);

  // Apply any developer endpoint override before any client/vault init reads endpoints.
  await loadEndpointOverrides();

  await Actions.init();
```

`src/lib/miden/front/provider.tsx`:
- Add imports:
```ts
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import {
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl
} from 'lib/miden-chain/effective-endpoints';
```
- Replace the `sdkWasmReady` state + effect (L105-117) with a combined readiness gate:
```ts
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadEndpointOverrides();
      await ensureSdkWasmReady();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) {
    return null;
  }
```
- Change `sdkConfig` (L82-97) to read the resolver and depend on `ready` (so it recomputes once overrides are loaded):
```ts
  const sdkConfig = useMemo(
    () => ({
      rpcUrl: getEffectiveRpcUrl(),
      noteTransportUrl: getEffectiveNoteTransportUrl(),
      prover: getEffectiveProverUrl(),
      autoSyncInterval: 0,
      useWorker: !isMobile()
    }),
    [ready]
  );
```
- Gate the `getMidenClient()` effect on `ready` so the frontend (mobile/desktop) client is created only after overrides load — change its deps and guard (L61-72):
```ts
  useEffect(() => {
    if (!ready || isExtension()) return;
    const initializeClient = async () => {
      try {
        await getMidenClient();
      } catch (err) {
        console.error('Failed to initialize Miden client singleton:', err);
      }
    };
    initializeClient();
  }, [ready]);
```
> Keep the existing early `return null` semantics — the `sdkConfig`/`getMidenClient` hooks must remain declared before the `if (!ready) return null;` line (React hook ordering). Place the `ready` gate's `return null` after all hooks.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/miden/front/provider.overrides.test.tsx src/lib/miden/front/provider.test.tsx`
Expected: PASS (new test + existing provider test still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden/back/main.ts src/lib/miden/front/provider.tsx src/lib/miden/front/provider.overrides.test.tsx
git commit -m "feat(dev-endpoints): load overrides at SW start and frontend provider gate"
```

---

## Task 5: Endpoint health probe + hook

**Files:**
- Create: `src/lib/miden-chain/endpoint-health.ts`
- Test: `src/lib/miden-chain/endpoint-health.test.ts`

**Interfaces:**
- Produces: `type EndpointHealthStatus = 'idle' | 'pending' | 'reachable' | 'error'`; `type EndpointHealthKind = 'faucet-api' | 'reachability'`; `probeEndpointHealth(url: string, kind: EndpointHealthKind): Promise<EndpointHealthStatus>`; `useEndpointHealth(url: string, kind: EndpointHealthKind): EndpointHealthStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/miden-chain/endpoint-health.test.ts
import { probeEndpointHealth } from './endpoint-health';

describe('probeEndpointHealth', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns idle for an empty url', async () => {
    expect(await probeEndpointHealth('', 'reachability')).toBe('idle');
  });

  it('reachability: resolves fetch => reachable', async () => {
    global.fetch = jest.fn().mockResolvedValue({}) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://x', 'reachability')).toBe('reachable');
  });

  it('reachability: thrown fetch => error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('nope')) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://x', 'reachability')).toBe('error');
  });

  it('faucet-api: 2xx JSON => reachable', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: '0x1' }) }) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://f', 'faucet-api')).toBe('reachable');
  });

  it('faucet-api: non-2xx => error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://f', 'faucet-api')).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden-chain/endpoint-health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/miden-chain/endpoint-health.ts
import { useEffect, useRef, useState } from 'react';

export type EndpointHealthStatus = 'idle' | 'pending' | 'reachable' | 'error';
export type EndpointHealthKind = 'faucet-api' | 'reachability';

const PROBE_TIMEOUT_MS = 4000;
const DEBOUNCE_MS = 500;

/**
 * Non-authoritative reachability probe. For gRPC/cross-origin hosts a
 * `no-cors` fetch resolving (opaque) means "the host answered" — NOT that it is
 * the correct service. Only 'faucet-api' actually validates the response body.
 */
export async function probeEndpointHealth(url: string, kind: EndpointHealthKind): Promise<EndpointHealthStatus> {
  if (!url) return 'idle';
  try {
    if (kind === 'faucet-api') {
      const res = await fetch(`${url.replace(/\/$/, '')}/get_metadata`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (!res.ok) return 'error';
      await res.json();
      return 'reachable';
    }
    await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return 'reachable';
  } catch {
    return 'error';
  }
}

/** Debounced, cancellation-safe health status for a single field. */
export function useEndpointHealth(url: string, kind: EndpointHealthKind): EndpointHealthStatus {
  const [status, setStatus] = useState<EndpointHealthStatus>('idle');
  const latest = useRef(0);

  useEffect(() => {
    if (!url) {
      setStatus('idle');
      return;
    }
    const token = ++latest.current;
    setStatus('pending');
    const handle = setTimeout(async () => {
      const result = await probeEndpointHealth(url, kind);
      if (latest.current === token) setStatus(result);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [url, kind]);

  return status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/miden-chain/endpoint-health.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden-chain/endpoint-health.ts src/lib/miden-chain/endpoint-health.test.ts
git commit -m "feat(dev-endpoints): non-blocking endpoint health probe + hook"
```

---

## Task 6: Preset helper

Pure mapping from preset → all field values, so the screen stays thin/testable.

**Files:**
- Create: `src/screens/developer-settings/preset.ts`
- Test: `src/screens/developer-settings/preset.test.ts`

**Interfaces:**
- Produces: `const ENDPOINT_PRESETS: MIDEN_NETWORK_NAME[]` (`[TESTNET, DEVNET, LOCALNET]`); `presetToOverride(preset: MIDEN_NETWORK_NAME): EndpointOverride` (= `buildDefaultOverrideFor` with `presetName = preset`); `CUSTOM_PRESET = 'custom'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/screens/developer-settings/preset.test.ts
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { ENDPOINT_PRESETS, presetToOverride } from './preset';

describe('preset helper', () => {
  it('lists the selectable presets', () => {
    expect(ENDPOINT_PRESETS).toEqual([
      MIDEN_NETWORK_NAME.TESTNET,
      MIDEN_NETWORK_NAME.DEVNET,
      MIDEN_NETWORK_NAME.LOCALNET
    ]);
  });

  it('presetToOverride prefills all fields and stamps presetName', () => {
    const o = presetToOverride(MIDEN_NETWORK_NAME.DEVNET);
    expect(o.networkName).toBe(MIDEN_NETWORK_NAME.DEVNET);
    expect(o.presetName).toBe(MIDEN_NETWORK_NAME.DEVNET);
    expect(o.rpcUrl).toContain('devnet');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/screens/developer-settings/preset.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/screens/developer-settings/preset.ts
import { buildDefaultOverrideFor, EndpointOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

export const CUSTOM_PRESET = 'custom';

export const ENDPOINT_PRESETS: MIDEN_NETWORK_NAME[] = [
  MIDEN_NETWORK_NAME.TESTNET,
  MIDEN_NETWORK_NAME.DEVNET,
  MIDEN_NETWORK_NAME.LOCALNET
];

export function presetToOverride(preset: MIDEN_NETWORK_NAME): EndpointOverride {
  return buildDefaultOverrideFor(preset);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/screens/developer-settings/preset.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/developer-settings/preset.ts src/screens/developer-settings/preset.test.ts
git commit -m "feat(dev-endpoints): preset-to-override helper"
```

---

## Task 7: Developer Settings screen + route + i18n

**Files:**
- Create: `src/screens/developer-settings/DeveloperSettings.tsx`
- Test: `src/screens/developer-settings/DeveloperSettings.test.tsx`
- Modify: `src/app/PageRouter.tsx` (import + `ROUTE_MAP` entry)
- Modify: `public/_locales/en/en.json` (i18n keys)

**Interfaces:**
- Consumes: `EndpointOverride`, `getActiveOverride`, `applyEndpointOverride`, `clearEndpointOverride`, `buildDefaultOverrideFor` (Task 1); `useEndpointHealth` (Task 5); `ENDPOINT_PRESETS`, `presetToOverride`, `CUSTOM_PRESET` (Task 6); `getEffectiveNetworkName`; `ScreenHeader`, `Button`, `Input`, `TabPicker`; `navigate`, `goBack` (woozie); `resetStorageDestructive` (`lib/miden/reset`).
- Produces: default export `DeveloperSettings` (props `{ readOnly?: boolean }`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/screens/developer-settings/DeveloperSettings.test.tsx
import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (p: string) => mockNavigate(p), goBack: () => mockGoBack() }));

const applyEndpointOverride = jest.fn().mockResolvedValue(undefined);
const clearEndpointOverride = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const { MIDEN_NETWORK_NAME } = jest.requireActual('lib/miden-chain/constants');
  return {
    getActiveOverride: () => null,
    applyEndpointOverride: (o: unknown) => applyEndpointOverride(o),
    clearEndpointOverride: () => clearEndpointOverride(),
    getEffectiveNetworkName: () => MIDEN_NETWORK_NAME.TESTNET,
    buildDefaultOverrideFor: (n: string) => ({
      rpcUrl: `https://rpc.${n}`,
      proverUrl: `https://prover.${n}`,
      noteTransportUrl: `https://ntl.${n}`,
      faucetUrl: `https://faucet.${n}`,
      faucetApiUrl: `https://faucet-api.${n}`,
      explorerUrl: `https://scan.${n}`,
      guardianUrl: `https://guardian.${n}`,
      networkName: n,
      presetName: n
    })
  };
});
jest.mock('lib/miden-chain/endpoint-health', () => ({ useEndpointHealth: () => 'idle' }));
jest.mock('lib/miden/reset', () => ({ resetStorageDestructive: jest.fn().mockResolvedValue(undefined) }));

import DeveloperSettings from './DeveloperSettings';

beforeEach(() => jest.clearAllMocks());

describe('DeveloperSettings', () => {
  it('renders the warning banner and the RPC field', () => {
    render(<DeveloperSettings />);
    expect(screen.getByText('developerSettingsWarning')).toBeInTheDocument();
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeInTheDocument();
  });

  it('saves the current values and navigates home on save', async () => {
    render(<DeveloperSettings />);
    fireEvent.click(screen.getByTestId('dev-endpoints-save'));
    await waitFor(() => expect(applyEndpointOverride).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('read-only mode disables inputs and shows the reset action', () => {
    render(<DeveloperSettings readOnly />);
    expect(screen.getByTestId('dev-endpoint-rpcUrl')).toBeDisabled();
    expect(screen.getByTestId('dev-endpoints-reset')).toBeInTheDocument();
    expect(screen.queryByTestId('dev-endpoints-save')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/screens/developer-settings/DeveloperSettings.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/screens/developer-settings/DeveloperSettings.tsx
import React, { useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Input } from 'components/Input';
import { ScreenHeader } from 'components/ScreenHeader';
import { TabPicker } from 'components/TabPicker';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { EndpointHealthKind, useEndpointHealth } from 'lib/miden-chain/endpoint-health';
import {
  applyEndpointOverride,
  buildDefaultOverrideFor,
  clearEndpointOverride,
  EndpointOverride,
  getActiveOverride,
  getEffectiveNetworkName
} from 'lib/miden-chain/effective-endpoints';
import { hapticMedium } from 'lib/mobile/haptics';
import { resetStorageDestructive } from 'lib/miden/reset';
import { goBack, navigate } from 'lib/woozie';

import { CUSTOM_PRESET, ENDPOINT_PRESETS } from './preset';

type UrlFieldKey = 'rpcUrl' | 'proverUrl' | 'noteTransportUrl' | 'faucetUrl' | 'faucetApiUrl' | 'explorerUrl' | 'guardianUrl';

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

const HealthNote: React.FC<{ url: string; kind: EndpointHealthKind }> = ({ url, kind }) => {
  const { t } = useTranslation();
  const status = useEndpointHealth(url, kind);
  if (status === 'idle') return null;
  const color =
    status === 'reachable' ? 'text-green-600' : status === 'error' ? 'text-red-500' : 'text-text-muted';
  const key = status === 'pending' ? 'devEndpointChecking' : status === 'reachable' ? 'devEndpointReachable' : 'devEndpointNoResponse';
  return <p className={`text-xs mt-1 ${color}`}>{t(key)}</p>;
};

const DeveloperSettings: React.FC<{ readOnly?: boolean }> = ({ readOnly = false }) => {
  const { t } = useTranslation();
  const initial = useMemo<EndpointOverride>(
    () => getActiveOverride() ?? buildDefaultOverrideFor(getEffectiveNetworkName()),
    []
  );
  const [form, setForm] = useState<EndpointOverride>(initial);
  const [saving, setSaving] = useState(false);

  const presetTabs = useMemo(
    () =>
      [...ENDPOINT_PRESETS.map(p => ({ id: p, title: p })), { id: CUSTOM_PRESET, title: t('devEndpointCustom') }].map(
        tab => ({ ...tab, active: form.presetName === tab.id })
      ),
    [form.presetName, t]
  );

  const applyPreset = (index: number) => {
    const id = presetTabs[index]!.id;
    if (id === CUSTOM_PRESET) {
      setForm(prev => ({ ...prev, presetName: CUSTOM_PRESET }));
      return;
    }
    setForm(buildDefaultOverrideFor(id as MIDEN_NETWORK_NAME));
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

  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg">
      <ScreenHeader title={t('developerSettingsTitle')} backLabel={t('back')} onBack={() => goBack()} className="mx-4 shrink-0" />
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-4 flex flex-col gap-5">
        <div className="w-full bg-surface-input rounded-10 px-4 py-3">
          <div className="text-base font-bold font-heading leading-tight text-black">{t('developerSettingsWarningTitle')}</div>
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

        <div className="flex flex-col">
          <span className="text-sm font-medium text-heading-gray">{t('devEndpointNetworkId')}</span>
          <TabPicker
            tabs={ENDPOINT_PRESETS.map(n => ({ id: n, title: n, active: form.networkName === n }))}
            onTabChange={i =>
              !readOnly && setForm(prev => ({ ...prev, networkName: ENDPOINT_PRESETS[i]!, presetName: CUSTOM_PRESET }))
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
              onClick={() => setForm(buildDefaultOverrideFor(getEffectiveNetworkName()))}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default DeveloperSettings;
```

Register the route in `src/app/PageRouter.tsx` — add the import near the other page imports:
```ts
import DeveloperSettings from 'screens/developer-settings/DeveloperSettings';
```
and add, before the final `['*', () => <Woozie.Redirect to="/" />]` catch-all, a concrete entry (note: **not** wrapped in `onlyReady`, because it must be reachable during onboarding when the wallet is not ready):
```ts
  ['/developer-settings', () => (
    <FullScreenPage>
      <DeveloperSettings />
    </FullScreenPage>
  )],
```

Add the i18n keys to `public/_locales/en/en.json` (flat entries):
```json
  "developerSettingsTitle": "Developer Settings",
  "developerSettingsWarningTitle": "For advanced users",
  "developerSettingsWarning": "Most people should never change these. Wrong values will break your wallet.",
  "devEndpointPreset": "Network preset",
  "devEndpointCustom": "Custom",
  "devEndpointNetworkId": "Network ID",
  "devEndpointRpc": "RPC node URL",
  "devEndpointProver": "Transaction prover URL",
  "devEndpointNoteTransport": "Note transport URL",
  "devEndpointFaucet": "Faucet website URL",
  "devEndpointFaucetApi": "Faucet API URL",
  "devEndpointExplorer": "Explorer URL",
  "devEndpointGuardian": "Custom guardian URL",
  "devEndpointChecking": "Checking…",
  "devEndpointReachable": "Host reachable",
  "devEndpointNoResponse": "No response",
  "devEndpointSaveContinue": "Save & continue",
  "devEndpointResetDefaults": "Reset to defaults",
  "devEndpointResetAndReonboard": "Reset to defaults & re-onboard"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/screens/developer-settings/DeveloperSettings.test.tsx && yarn lint:i18n`
Expected: PASS (3 tests) and i18n lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/screens/developer-settings/DeveloperSettings.tsx src/screens/developer-settings/DeveloperSettings.test.tsx src/app/PageRouter.tsx public/_locales/en/en.json
git commit -m "feat(dev-endpoints): developer settings screen + route"
```

---

## Task 8: 7-tap unlock on the Welcome logo (+ text-selection fix)

**Files:**
- Modify: `src/screens/onboarding/common/Welcome.tsx`
- Test: `src/screens/onboarding/common/Welcome.test.tsx` (extend)

**Interfaces:** Consumes `navigate` (woozie), `hapticLight`/`hapticMedium`. Produces: no exported symbols (internal behavior). The logo wrapper carries `data-testid="onboarding-bread-logo"`.

- [ ] **Step 1: Write the failing test**

Add to `src/screens/onboarding/common/Welcome.test.tsx`:

```tsx
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (p: string) => mockNavigate(p) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn() }));

describe('WelcomeScreen developer unlock', () => {
  beforeEach(() => mockNavigate.mockClear());

  it('navigates to developer settings after 7 taps on the logo', () => {
    render(<WelcomeScreen />);
    const logo = screen.getByTestId('onboarding-bread-logo');
    for (let i = 0; i < 7; i++) fireEvent.click(logo);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
  });

  it('does not navigate before the 7th tap', () => {
    render(<WelcomeScreen />);
    const logo = screen.getByTestId('onboarding-bread-logo');
    for (let i = 0; i < 6; i++) fireEvent.click(logo);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('prevents text selection on the logo tap target', () => {
    render(<WelcomeScreen />);
    const logo = screen.getByTestId('onboarding-bread-logo');
    expect(logo).toHaveStyle({ userSelect: 'none' });
  });
});
```
> The existing `Welcome.test.tsx` mocks `lib/mobile/haptics` for `hapticLight` only — extend that mock to also export `hapticMedium` (add `hapticMedium: jest.fn()` to the existing `jest.mock('lib/mobile/haptics', …)` factory) rather than declaring a second mock.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/screens/onboarding/common/Welcome.test.tsx`
Expected: FAIL — no `onboarding-bread-logo` testid / no navigation.

- [ ] **Step 3: Write minimal implementation**

In `src/screens/onboarding/common/Welcome.tsx`:
- Add imports:
```ts
import React, { useRef } from 'react';
// ...
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
```
- Inside `WelcomeScreen`, add the tap-counter logic:
```ts
  const tapCount = useRef(0);
  const lastTap = useRef(0);

  const handleLogoTap = (e: React.MouseEvent) => {
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    const now = e.timeStamp;
    tapCount.current = now - lastTap.current > 2000 ? 1 : tapCount.current + 1;
    lastTap.current = now;
    if (tapCount.current >= 4 && tapCount.current < 7) hapticLight();
    if (tapCount.current >= 7) {
      tapCount.current = 0;
      hapticMedium();
      navigate('/developer-settings');
    }
  };
```
- Wrap the logo in a tap target with selection disabled:
```tsx
          <div
            data-testid="onboarding-bread-logo"
            onClick={handleLogoTap}
            className="cursor-default"
            style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
          >
            <BreadLogo style={{ width: 130, height: 'auto' }} />
          </div>
```
> Replace only the bare `<BreadLogo .../>` line with this wrapper. `e.timeStamp` avoids the banned `Date.now()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/screens/onboarding/common/Welcome.test.tsx`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/screens/onboarding/common/Welcome.tsx src/screens/onboarding/common/Welcome.test.tsx
git commit -m "feat(dev-endpoints): 7-tap logo unlock for developer settings"
```

---

## Task 9: Settings entry (read-only) + reset

Show a "Network endpoints" row in Settings only when an override is active; it opens the screen read-only.

**Files:**
- Modify: `src/app/pages/Settings.tsx`
- Modify: `src/app/PageRouter.tsx` (read-only route variant)
- Modify: `public/_locales/en/en.json` (row label key)
- Test: `src/app/pages/Settings.devEndpoints.test.tsx` (new, focused)

**Interfaces:** Consumes `isEndpointOverrideActive` (Task 1); the `Tab`/`TabGroup` model + `TAB_GROUPS` in Settings; `DeveloperSettings` (Task 7). Produces: no new exported symbols.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/pages/Settings.devEndpoints.test.tsx
import { isEndpointOverrideActive } from 'lib/miden-chain/effective-endpoints';

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  isEndpointOverrideActive: jest.fn()
}));

// A pure unit over the visibility predicate the Settings page uses.
import { shouldShowDevEndpointsRow } from './Settings';

describe('developer endpoints settings row visibility', () => {
  it('hidden when no override is active', async () => {
    (isEndpointOverrideActive as jest.Mock).mockResolvedValue(false);
    expect(await shouldShowDevEndpointsRow()).toBe(false);
  });
  it('shown when an override is active', async () => {
    (isEndpointOverrideActive as jest.Mock).mockResolvedValue(true);
    expect(await shouldShowDevEndpointsRow()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/app/pages/Settings.devEndpoints.test.tsx`
Expected: FAIL — `shouldShowDevEndpointsRow` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/app/pages/Settings.tsx`:
- Add import:
```ts
import { isEndpointOverrideActive } from 'lib/miden-chain/effective-endpoints';
```
- Export the predicate (keeps the test pure and documents intent):
```ts
export async function shouldShowDevEndpointsRow(): Promise<boolean> {
  return isEndpointOverrideActive();
}
```
- Add local state that resolves it on mount (inside the `Settings` component, near other hooks):
```ts
  const [showDevEndpoints, setShowDevEndpoints] = useState(false);
  useEffect(() => {
    let cancelled = false;
    shouldShowDevEndpointsRow().then(v => {
      if (!cancelled) setShowDevEndpoints(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
```
- Add a `Tab` to the existing `developer` group. Because `TAB_GROUPS` is module-level, gate the row at render instead: in the `tabGroups` useMemo (the filtered copy, ~L287-294) append the row conditionally. Add this entry object (reuse the existing `ToolIcon`):
```ts
  // inside the tabGroups useMemo, after computing the base filtered groups:
  const withDevEndpoints = showDevEndpoints
    ? groups.map(g =>
        g.titleI18nKey === 'developer'
          ? {
              ...g,
              tabs: [
                ...g.tabs,
                {
                  slug: 'network-endpoints',
                  titleI18nKey: 'devEndpointsRow',
                  Icon: ToolIcon,
                  Component: () => null,
                  hasOwnLayout: true
                }
              ]
            }
          : g
      )
    : groups;
  return withDevEndpoints;
```
> Adapt variable names (`groups`) to the actual local in that useMemo. The row links to `/settings/network-endpoints` (default `/settings/${slug}` behavior for non-drawer, non-external tabs). Add `showDevEndpoints` to the useMemo deps.

In `src/app/PageRouter.tsx`, add a read-only route mapping `/settings/network-endpoints` to the screen in read-only mode, before the generic `'/settings/:tabSlug?'` route:
```ts
  ['/settings/network-endpoints', onlyReady(() => (
    <FullScreenPage>
      <DeveloperSettings readOnly />
    </FullScreenPage>
  ))],
```

Add the i18n key to `public/_locales/en/en.json`:
```json
  "devEndpointsRow": "Network endpoints",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/app/pages/Settings.devEndpoints.test.tsx src/app/pages/Settings.test.tsx && yarn lint:i18n`
Expected: PASS (new + existing Settings tests) and i18n clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/pages/Settings.tsx src/app/PageRouter.tsx public/_locales/en/en.json src/app/pages/Settings.devEndpoints.test.tsx
git commit -m "feat(dev-endpoints): read-only network-endpoints row in Settings"
```

---

## Task 10: Full verification + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the CHANGELOG entry**

Confirm the latest published tag, then add a one-liner under a `(TBD)` section whose version is strictly higher:
```bash
gh api repos/0xMiden/wallet/releases/latest --jq .tag_name
```
Add under the appropriate `## <version> (TBD)` heading:
```markdown
- Add hidden developer endpoint configuration (7-tap the Welcome logo) to override RPC/prover/note-transport/faucet/explorer/guardian/network during onboarding; read-only + reset in Settings.
```

- [ ] **Step 2: Typecheck**

Run: `yarn ts`
Expected: no errors. (Watch for dangling references to removed imports in the edited files.)

- [ ] **Step 3: i18n lint**

Run: `yarn lint:i18n`
Expected: clean.

- [ ] **Step 4: Full test suite with coverage**

Run: `yarn test:coverage`
Expected: PASS with all four metrics ≥ 95. If a new file drags coverage, add the missing test cases (do not lower the gate, do not add to `coveragePathIgnorePatterns` without a justification comment).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(dev-endpoints): changelog entry for developer endpoint configuration"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §1 summary → Tasks 7/8/9; §3 resolver + bootstrap → Tasks 1/2/3/4; §4 unlock + screen → Tasks 7/8; §5 health → Task 5; §6 Settings read-only + reset → Task 9; §7 testing → every task + Task 10; E2E guarantees → Task 1 (`MIDEN_E2E_TEST` no-op) + Task 2 (invariant test). **Deviation:** spec §3 listed `isDevnet` theming as dynamic; this plan defers it (cosmetic, ~28-const ripple) and flags it for user sign-off — the functional `getNetworkId()` remains dynamic.
- **Placeholder scan:** none — every code step contains full code.
- **Type consistency:** `EndpointOverride`, `getEffective*`, `presetToOverride`, `useEndpointHealth`, `EndpointHealthKind`, `shouldShowDevEndpointsRow`, `resetStorageDestructive`, `applyEndpointOverride`/`clearEndpointOverride`/`isEndpointOverrideActive` are used with identical names/signatures across tasks.
