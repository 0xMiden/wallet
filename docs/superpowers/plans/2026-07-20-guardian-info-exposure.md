# Guardian Info Exposure + Out-of-Band Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the connected account's guardian info to dApps via a live `requestGuardianInfo()` method, and keep each device's guardian metadata correct after an out-of-band guardian switch (detect + auto-resolve for built-in operators, prompt+verify for custom URLs).

**Architecture:** Wallet-side, a backend action reads the account's on-chain guardian key commitment, compares it to a new locally-persisted `guardianOperatorCommitment` baseline, and on drift resolves the endpoint by matching against the built-in operators' public `GET /pubkey` (zero account-specific disclosure) or, failing that, flags the account for a user prompt that is verified against the on-chain commitment before persisting. The existing 3s guardian-sync loop triggers this. dApp exposure mirrors the existing read-only `Assets` request end-to-end (no confirmation prompt — guardian info is non-sensitive), and `requestGuardianInfo` is cloned across the wallet-adapter's base/wallets/react layers.

**Tech Stack:** TypeScript, React, Zustand + Effector (wallet), Jest + @swc/jest (wallet tests), Vitest (adapter tests), `@openzeppelin/miden-multisig-client` + `@openzeppelin/guardian-client`, `@miden-sdk/miden-sdk` (WASM).

## Global Constraints

- **Coverage gate: global 95/95/95/95** (branches/functions/lines/statements), `jest.config.ts`. Every new source file MUST arrive with tests holding all four metrics ≥95, or `yarn test:coverage` fails CI. Verify locally before pushing.
- **No `any`, no `as`** in new code (repo rule). Use concrete types even though the existing `Assets` code uses `as Asset[]`/`as any` — do not copy those.
- **WASM client is single-threaded.** Every `getMidenClient()` call MUST be inside `withWasmClientLock` (`lib/miden/sdk/miden-client`). HTTP-only calls (`getPubkey`) must run OUTSIDE the lock.
- **i18n required.** Every user-facing string uses `t('key')`; add keys to `public/_locales/en/en.json` (flat, `$name$` placeholders) or `yarn lint:i18n` fails CI.
- **Prettier:** 120 cols, single quotes, semicolons, trailing commas.
- **jest.mock() path must match the import path the source file uses** (relative vs absolute alias). `@miden-sdk/*`, `@openzeppelin/*`, `.svg` auto-map to `__mocks__` — do not re-mock.
- **CHANGELOG.md:** add ONE one-line entry under the current `## <next-version> (TBD)` section (verify the latest published tag first; do not add under a released heading).
- **Commits:** single-line, short, no `Co-Authored-By`, no attribution. Never `git push` without explicit request.
- **Wire string values** (`'GUARDIAN_INFO_REQUEST'` / `'GUARDIAN_INFO_RESPONSE'`) are the stable dApp↔wallet contract; enum keys are internal.
- **Issue:** this implements https://github.com/0xMiden/wallet/issues/347.

## Final type shapes (authoritative — referenced by many tasks)

```ts
// Wallet-local internal states (WalletAccount.guardianSyncStatus)
export type GuardianSyncStatus = 'in-sync' | 'resolving' | 'needs-user-input';

// Provider identity (reverse-mapped from endpoint against GUARDIAN_OPTIONS)
export type GuardianProvider = 'open-zeppelin' | 'gateway' | 'lambda-class' | 'custom';

// dApp-facing payload (collapses status to in-sync | out-of-sync)
export interface GuardianInfo {
  isGuardianAccount: boolean;
  guardianEndpoint: string | null;     // null: non-guardian / mainnet / unresolved
  guardianProvider: GuardianProvider | null;
  guardianSyncStatus: 'in-sync' | 'out-of-sync' | null; // null: non-guardian
}
```

## File Structure

**Wallet repo (`/Users/celrisen/miden/miden-wallet-guardian-info`)**
- `src/lib/shared/types.ts` — add `GuardianSyncStatus`, `GuardianProvider`, `GuardianInfo`; two `WalletAccount` fields; `WalletMessageType` setter pair; unions. (Tasks 1, 8)
- `src/lib/miden/guardian/account.ts` — `GUARDIAN_SLOT_NAMES`, `getGuardianCommitmentFromAccount`, `guardianProviderFromEndpoint`. (Tasks 3, 8)
- `src/lib/miden/guardian/operator-map.ts` *(new)* — `buildOperatorKeyMap`, `identifyGuardianOperator`, `verifyEndpointMatchesCommitment`, `normalizeHex`. (Task 4)
- `src/lib/miden/back/vault.ts` — `setGuardianOperatorCommitment`, `setGuardianSyncStatus` setters. (Task 2)
- `src/lib/miden/back/guardian-drift.ts` *(new)* — `resolveGuardianDrift`, `applyUserGuardianEndpoint`. (Tasks 5, 7)
- `src/lib/miden/back/actions.ts` + `back/main.ts` — action registration + processDApp case. (Tasks 2, 5, 8)
- `src/lib/store/index.ts` + `store/types.ts` — store actions. (Tasks 2, 5)
- `src/lib/miden/front/guardian-sync.ts` — invoke drift check in the 3s loop. (Task 6)
- `src/lib/miden/front/client.ts` — expose store actions via `useMidenContext`. (Tasks 2, 5)
- `src/lib/adapter/{types.ts,client.ts,midenWindowObject.ts}` + `src/lib/dapp-browser/injection-script.ts` — dApp wire + provider. (Tasks 8, 9)
- `src/lib/miden/back/dapp.ts` — `requestGuardianInfo` handler + `getGuardianInfoData`. (Task 8)
- `src/app/templates/GuardianNeedsUrlBanner.tsx` *(new)* + mount + i18n. (Task 7)
- `src/lib/intercom/mobile-adapter.ts` — mobile setter passthrough (per CLAUDE.md). (Tasks 2, 5)

**Adapter repo (`/Users/celrisen/miden/wallet-adapter`)**
- `packages/core/base/{types.ts,signer.ts}` — `GuardianInfo` + `requestGuardianInfo` on props/abstract. (Task 10)
- `packages/wallets/miden/adapter.ts` — concrete method. (Task 11)
- `packages/core/react/{useWallet.ts,WalletProvider.tsx,MidenFiSignerProvider.tsx}` — both hooks. (Task 12)

---

## Milestone 1 — Data model foundation (wallet)

### Task 1: Add guardian fields to `WalletAccount` + surface via `toFront`

**Files:**
- Modify: `src/lib/shared/types.ts` (WalletAccount ~340-369; add types near line 338)
- Modify: the backend `toFront()` sanitizer (grep `toFront` in `src/lib/miden/back`) — ensure new fields pass through
- Test: `src/lib/shared/types.test.ts` *(new if absent; else colocate)* and the existing `toFront` test

**Interfaces:**
- Produces: `GuardianSyncStatus`, `GuardianProvider`, `GuardianInfo` types; `WalletAccount.guardianOperatorCommitment?: string`, `WalletAccount.guardianSyncStatus?: GuardianSyncStatus`.

- [ ] **Step 1: Write the failing test** — assert `toFront` preserves the new fields.

```ts
// in the existing toFront test file (grep toFront in src/lib/miden/back for its test)
it('preserves guardianOperatorCommitment and guardianSyncStatus', () => {
  const acc = makeAccount({
    type: WalletType.Guardian,
    guardianEndpoint: 'https://guardian.openzeppelin.com',
    guardianOperatorCommitment: 'abc123',
    guardianSyncStatus: 'in-sync',
  });
  const front = toFront({ ...baseState, accounts: [acc] });
  expect(front.accounts[0].guardianOperatorCommitment).toBe('abc123');
  expect(front.accounts[0].guardianSyncStatus).toBe('in-sync');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/back -t "guardianOperatorCommitment"`
Expected: FAIL (fields dropped or type error).

- [ ] **Step 3: Add the types and fields**

```ts
// src/lib/shared/types.ts — near AuthScheme (~line 338)
/**
 * Local reconciliation state of a Guardian account's endpoint vs its on-chain
 * guardian key. 'in-sync': stored endpoint matches on-chain. 'resolving':
 * an out-of-band switch was detected and auto-resolution is in progress.
 * 'needs-user-input': the new operator could not be identified (custom URL) and
 * the user must supply it. Absent on non-Guardian accounts and legacy records.
 */
export type GuardianSyncStatus = 'in-sync' | 'resolving' | 'needs-user-input';

/** Built-in guardian provider identity, reverse-mapped from the endpoint. */
export type GuardianProvider = 'open-zeppelin' | 'gateway' | 'lambda-class' | 'custom';

/** dApp-facing guardian info for the connected account. */
export interface GuardianInfo {
  isGuardianAccount: boolean;
  guardianEndpoint: string | null;
  guardianProvider: GuardianProvider | null;
  guardianSyncStatus: 'in-sync' | 'out-of-sync' | null;
}
```

```ts
// src/lib/shared/types.ts — WalletAccount interface, right after `guardianEndpoint?` (~line 364)
  /**
   * The operator-wide guardian key commitment the current `guardianEndpoint`
   * corresponds to (the value baked into the account's on-chain
   * `openzeppelin::guardian::public_key` slot at create/switch time). Local
   * baseline for out-of-band-switch detection. Absent on non-Guardian accounts.
   */
  guardianOperatorCommitment?: string;
  /** Reconciliation state; see GuardianSyncStatus. Defaults to 'in-sync'. */
  guardianSyncStatus?: GuardianSyncStatus;
```

- [ ] **Step 4: Ensure `toFront` passes the fields through**

In the `toFront` account mapping, confirm it spreads the whole account or add the two fields explicitly (match how `guardianEndpoint`/`requiresHotKeyRotation` are already surfaced). Run: `yarn test src/lib/miden/back -t "guardianOperatorCommitment"` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/types.ts src/lib/miden/back
git commit -m "feat(guardian): add guardianOperatorCommitment + guardianSyncStatus to WalletAccount"
```

### Task 2: Vault setters + store actions + action registration

**Files:**
- Modify: `src/lib/miden/back/vault.ts` (next to `setGuardianEndpoint` ~933-957)
- Modify: `src/lib/miden/back/actions.ts`, `src/lib/miden/back/main.ts`, `src/lib/store/index.ts`, `src/lib/store/types.ts`, `src/lib/miden/front/client.ts`, `src/lib/intercom/mobile-adapter.ts`
- Modify: `src/lib/shared/types.ts` (WalletMessageType pair + interfaces + unions)
- Test: `src/lib/miden/back/vault.test.ts` (or the nearest vault test)

**Interfaces:**
- Consumes: fields from Task 1.
- Produces: `vault.setGuardianOperatorCommitment(pk, commitment)`, `vault.setGuardianSyncStatus(pk, status)`; `Actions.setGuardianOperatorCommitment`, `Actions.setGuardianSyncStatus`; store actions of the same names.

- [ ] **Step 1: Write the failing test** (mirror the existing `setGuardianEndpoint` vault test)

```ts
it('setGuardianSyncStatus updates only the target account and persists', async () => {
  const vault = await makeVaultWith([
    { publicKey: 'pkA', type: WalletType.Guardian, guardianSyncStatus: 'in-sync' },
    { publicKey: 'pkB', type: WalletType.Guardian, guardianSyncStatus: 'in-sync' },
  ]);
  await vault.setGuardianSyncStatus('pkA', 'needs-user-input');
  const accounts = await vault.getAccounts();
  expect(accounts.find(a => a.publicKey === 'pkA')?.guardianSyncStatus).toBe('needs-user-input');
  expect(accounts.find(a => a.publicKey === 'pkB')?.guardianSyncStatus).toBe('in-sync');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/back/vault -t "setGuardianSyncStatus"` → Expected: FAIL (method undefined).

- [ ] **Step 3: Add the vault setters** (copy `setGuardianEndpoint` at vault.ts:933, swap the field)

```ts
// src/lib/miden/back/vault.ts
  async setGuardianOperatorCommitment(accountPublicKey: string, guardianOperatorCommitment: string) {
    return this.updateAccount(accountPublicKey, acc => ({ ...acc, guardianOperatorCommitment }));
  }

  async setGuardianSyncStatus(accountPublicKey: string, guardianSyncStatus: GuardianSyncStatus) {
    return this.updateAccount(accountPublicKey, acc => ({ ...acc, guardianSyncStatus }));
  }
```

If `setGuardianEndpoint` inlines the `.map` rather than a shared `updateAccount`, copy that exact inline shape instead (verbatim from vault.ts:933-945), swapping the written field.

- [ ] **Step 4: Wire the message/action/store chain** (mirror `setGuardianEndpoint` at each site)

Add to `src/lib/shared/types.ts`: `WalletMessageType.SetGuardianSyncStatusRequest/Response` + `SetGuardianOperatorCommitmentRequest/Response` (pattern at 635-643), added to the request/response unions (~859/~916). Add `Actions.setGuardianSyncStatus` / `setGuardianOperatorCommitment` in `back/actions.ts` (pattern at 331) and register in `back/main.ts` (pattern at 274). Add store actions in `store/index.ts` (352) + `store/types.ts` (155), expose via `front/client.ts`, and add the `mobile-adapter.ts` cases (pattern at 183). Run: `yarn test src/lib/miden/back/vault -t "setGuardianSyncStatus"` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat(guardian): vault setters + actions for guardian operator commitment & sync status"
```

---

## Milestone 2 — Detection & resolution primitives (wallet)

### Task 3: `getGuardianCommitmentFromAccount` + `GUARDIAN_SLOT_NAMES` + provider reverse-map

**Files:**
- Modify: `src/lib/miden/guardian/account.ts` (near `MULTISIG_SLOT_NAMES` ~26, and near `getSignerDetailsFromAccount` ~76)
- Test: `src/lib/miden/guardian/account.test.ts`

**Interfaces:**
- Produces: `GUARDIAN_SLOT_NAMES`, `getGuardianCommitmentFromAccount(account: Account): string | undefined` (unprefixed hex), `guardianProviderFromEndpoint(endpoint: string | null): GuardianProvider | null`.

- [ ] **Step 1: Write the failing test** (mock an `Account` whose storage returns a known guardian Word)

```ts
import { getGuardianCommitmentFromAccount, guardianProviderFromEndpoint } from './account';

it('reads the guardian commitment from the guardian public_key slot', () => {
  const fakeAccount = {
    storage: () => ({
      getMapItem: (slot: string) =>
        slot === 'openzeppelin::guardian::public_key'
          ? { toHex: () => '0xdeadbeef' }
          : undefined,
    }),
  } as unknown as import('@miden-sdk/miden-sdk').Account;
  expect(getGuardianCommitmentFromAccount(fakeAccount)).toBe('deadbeef');
});

it('returns undefined for the empty (all-zero) word', () => {
  const fakeAccount = {
    storage: () => ({ getMapItem: () => ({ toHex: () => '0x' + '0'.repeat(64) }) }),
  } as unknown as import('@miden-sdk/miden-sdk').Account;
  expect(getGuardianCommitmentFromAccount(fakeAccount)).toBeUndefined();
});

it('maps endpoints to provider ids with custom fallback', () => {
  expect(guardianProviderFromEndpoint('https://guardian.openzeppelin.com')).toBe('open-zeppelin');
  expect(guardianProviderFromEndpoint('https://my-own.example.com')).toBe('custom');
  expect(guardianProviderFromEndpoint(null)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/guardian/account -t "guardian commitment"` → Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement**

```ts
// src/lib/miden/guardian/account.ts — near MULTISIG_SLOT_NAMES
export const GUARDIAN_SLOT_NAMES = {
  SELECTOR: 'openzeppelin::guardian::selector',
  PUBLIC_KEY: 'openzeppelin::guardian::public_key',
  SCHEME_ID: 'openzeppelin::guardian::scheme_id',
} as const;

/** Read the on-chain guardian operator key commitment (unprefixed hex), or undefined. */
export function getGuardianCommitmentFromAccount(account: Account): string | undefined {
  const storage = account.storage();
  const value = storage.getMapItem(GUARDIAN_SLOT_NAMES.PUBLIC_KEY, signerMapKey(0));
  if (!value) return undefined;
  const hex = value.toHex();
  const unprefixed = hex.startsWith('0x') ? hex.slice(2) : hex;
  return /^0*$/.test(unprefixed) ? undefined : unprefixed;
}
```

```ts
// src/lib/miden/guardian/account.ts — import GUARDIAN_OPTIONS from 'lib/miden-chain/constants'
import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import type { GuardianProvider } from 'lib/shared/types';

const PROVIDER_ID_MAP: Record<string, GuardianProvider> = {
  'open-zeppelin': 'open-zeppelin',
  gateway: 'gateway',
  'lambda-class': 'lambda-class',
};

/** Reverse-map an endpoint URL to its built-in provider id; 'custom' if unmatched. */
export function guardianProviderFromEndpoint(endpoint: string | null): GuardianProvider | null {
  if (!endpoint) return null;
  for (const option of GUARDIAN_OPTIONS) {
    for (const url of option.endpoint.values()) {
      if (url === endpoint) return PROVIDER_ID_MAP[option.id] ?? 'custom';
    }
  }
  return 'custom';
}
```

- [ ] **Step 4: Run tests** — Run: `yarn test src/lib/miden/guardian/account` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden/guardian/account.ts src/lib/miden/guardian/account.test.ts
git commit -m "feat(guardian): read on-chain guardian commitment + reverse-map provider"
```

### Task 4: Operator-key map + endpoint verification (`operator-map.ts`)

**Files:**
- Create: `src/lib/miden/guardian/operator-map.ts`
- Test: `src/lib/miden/guardian/operator-map.test.ts`

**Interfaces:**
- Consumes: `getGuardianOptionsForNetwork`, `DEFAULT_NETWORK` (constants); `GuardianHttpClient` (`@openzeppelin/guardian-client`).
- Produces: `normalizeHex(h: string): string`; `buildOperatorKeyMap(network?): Promise<Map<string, ResolvedGuardianOption>>`; `identifyGuardianOperator(onChainCommitment, network?): Promise<ResolvedGuardianOption | undefined>`; `verifyEndpointMatchesCommitment(endpoint, onChainCommitment): Promise<boolean>`.

- [ ] **Step 1: Write the failing test** (mock `@openzeppelin/guardian-client`)

```ts
jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    constructor(public url: string) {}
    async getPubkey() {
      const byUrl: Record<string, string> = {
        'https://guardian.openzeppelin.com': '0xAAA',
        'https://miden-guardian.dev.eu-north-3.gateway.fm': '0xBBB',
        'https://miden-guardian.lambdaclass.com': '0xCCC',
      };
      return { commitment: byUrl[this.url] };
    }
  },
}));
import { identifyGuardianOperator, verifyEndpointMatchesCommitment, normalizeHex } from './operator-map';

it('identifies the operator whose pubkey matches the on-chain commitment', async () => {
  const op = await identifyGuardianOperator('aaa'); // unprefixed on-chain form
  expect(op?.id).toBe('open-zeppelin');
});

it('returns undefined when no operator matches (custom/rotated)', async () => {
  expect(await identifyGuardianOperator('deadbeef')).toBeUndefined();
});

it('verifies a specific endpoint against the commitment', async () => {
  expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', '0xaaa')).toBe(true);
  expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', 'bbb')).toBe(false);
});

it('normalizeHex strips 0x and lowercases', () => {
  expect(normalizeHex('0xABC')).toBe('abc');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/guardian/operator-map` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/miden/guardian/operator-map.ts
import { GuardianHttpClient } from '@openzeppelin/guardian-client';
import { getGuardianOptionsForNetwork, DEFAULT_NETWORK } from 'lib/miden-chain/constants';
import type { ResolvedGuardianOption } from 'lib/miden-chain/constants';
import type { MIDEN_NETWORK_NAME } from 'lib/miden-chain/types';

export function normalizeHex(h: string): string {
  return (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
}

/** Fetch each built-in operator's public key commitment (HTTP GET /pubkey, no auth). */
export async function buildOperatorKeyMap(
  network: MIDEN_NETWORK_NAME = DEFAULT_NETWORK
): Promise<Map<string, ResolvedGuardianOption>> {
  const options = getGuardianOptionsForNetwork(network);
  const map = new Map<string, ResolvedGuardianOption>();
  await Promise.all(
    options.map(async option => {
      try {
        const { commitment } = await new GuardianHttpClient(option.endpoint).getPubkey('ecdsa');
        if (commitment) map.set(normalizeHex(commitment), option);
      } catch {
        // operator unreachable — skip; a later tick retries
      }
    })
  );
  return map;
}

/** Which built-in operator holds this on-chain guardian commitment? undefined => unknown/custom/rotated. */
export async function identifyGuardianOperator(
  onChainCommitment: string,
  network: MIDEN_NETWORK_NAME = DEFAULT_NETWORK
): Promise<ResolvedGuardianOption | undefined> {
  const map = await buildOperatorKeyMap(network);
  return map.get(normalizeHex(onChainCommitment));
}

/** Verify a specific endpoint's operator key matches the on-chain commitment. */
export async function verifyEndpointMatchesCommitment(
  endpoint: string,
  onChainCommitment: string
): Promise<boolean> {
  try {
    const { commitment } = await new GuardianHttpClient(endpoint).getPubkey('ecdsa');
    return Boolean(commitment) && normalizeHex(commitment) === normalizeHex(onChainCommitment);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests** — Run: `yarn test src/lib/miden/guardian/operator-map` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden/guardian/operator-map.ts src/lib/miden/guardian/operator-map.test.ts
git commit -m "feat(guardian): operator-key map + endpoint verification via GET /pubkey"
```

### Task 5: Drift detection/resolution action (`guardian-drift.ts`) + trigger

**Files:**
- Create: `src/lib/miden/back/guardian-drift.ts`
- Modify: `src/lib/miden/back/actions.ts` + `back/main.ts` + `store/index.ts` + `store/types.ts` + `front/client.ts` (register `checkGuardianDrift`)
- Test: `src/lib/miden/back/guardian-drift.test.ts`

**Interfaces:**
- Consumes: `getGuardianCommitmentFromAccount` (T3), `identifyGuardianOperator` (T4), `vault.setGuardianEndpoint/setGuardianOperatorCommitment/setGuardianSyncStatus` (T2), `resolveGuardianEndpoint` (existing), `getMidenClient`/`withWasmClientLock`.
- Produces: `resolveGuardianDrift(vault, accountPublicKey): Promise<GuardianSyncStatus>`; `Actions.checkGuardianDrift`; store action `checkGuardianDrift(accountPublicKey)`.

- [ ] **Step 1: Write the failing test** (mock the WASM client + operator-map + a vault stub)

```ts
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(),
  withWasmClientLock: (fn: () => unknown) => fn(),
}));
jest.mock('lib/miden/guardian/operator-map', () => ({
  identifyGuardianOperator: jest.fn(),
}));
jest.mock('lib/miden/guardian/account', () => ({
  getGuardianCommitmentFromAccount: jest.fn(),
}));
import { resolveGuardianDrift } from './guardian-drift';
import { getMidenClient } from '../sdk/miden-client';
import { identifyGuardianOperator } from 'lib/miden/guardian/operator-map';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';

const makeVault = (acc: Record<string, unknown>) => ({
  getAccount: jest.fn(async () => acc),
  setGuardianEndpoint: jest.fn(),
  setGuardianOperatorCommitment: jest.fn(),
  setGuardianSyncStatus: jest.fn(),
});

beforeEach(() => {
  (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: jest.fn(async () => ({})) });
});

it('stays in-sync when on-chain commitment equals the stored baseline', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('abc');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });
  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalledWith('pk', 'needs-user-input');
});

it('auto-resolves to the matching built-in operator on drift', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue({ id: 'gateway', endpoint: 'https://g' });
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });
  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');
  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

it('flags needs-user-input when no built-in operator matches', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(undefined);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });
  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('needs-user-input');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'needs-user-input');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/back/guardian-drift` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/lib/miden/back/guardian-drift.ts
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import { identifyGuardianOperator, verifyEndpointMatchesCommitment } from 'lib/miden/guardian/operator-map';
import type { GuardianSyncStatus } from 'lib/shared/types';

interface GuardianDriftVault {
  getAccount(pk: string): Promise<{ guardianOperatorCommitment?: string } | undefined>;
  setGuardianEndpoint(pk: string, endpoint: string): Promise<unknown>;
  setGuardianOperatorCommitment(pk: string, commitment: string): Promise<unknown>;
  setGuardianSyncStatus(pk: string, status: GuardianSyncStatus): Promise<unknown>;
}

/**
 * Detect an out-of-band guardian switch and reconcile the local endpoint.
 * Returns the resulting sync status. WASM read is locked; HTTP probing is not.
 */
export async function resolveGuardianDrift(
  vault: GuardianDriftVault,
  accountPublicKey: string
): Promise<GuardianSyncStatus> {
  const account = await vault.getAccount(accountPublicKey);
  if (!account) return 'in-sync';

  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await (await getMidenClient()).getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return 'in-sync';

  if (account.guardianOperatorCommitment && normalizedEqual(onChain, account.guardianOperatorCommitment)) {
    return 'in-sync';
  }

  await vault.setGuardianSyncStatus(accountPublicKey, 'resolving');
  const operator = await identifyGuardianOperator(onChain);
  if (operator) {
    await vault.setGuardianEndpoint(accountPublicKey, operator.endpoint);
    await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
    await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
    return 'in-sync';
  }

  await vault.setGuardianSyncStatus(accountPublicKey, 'needs-user-input');
  return 'needs-user-input';
}

function normalizedEqual(a: string, b: string): boolean {
  const n = (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
  return n(a) === n(b);
}

export { verifyEndpointMatchesCommitment };
```

- [ ] **Step 4: Register the action + run tests**

Add `Actions.checkGuardianDrift(accountPublicKey)` in `back/actions.ts` (wrapping `resolveGuardianDrift(getVault(), pk)`), register in `back/main.ts`, add store action `checkGuardianDrift` (store/index.ts + types.ts) and expose via `front/client.ts` — mirroring `setGuardianEndpoint`. Run: `yarn test src/lib/miden/back/guardian-drift` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat(guardian): out-of-band drift detection + auto-resolution action"
```

### Task 6: Trigger drift check from the 3s sync loop

**Files:**
- Modify: `src/lib/miden/front/guardian-sync.ts` (`syncGuardianAccounts`, ~54-77)
- Test: `src/lib/miden/front/guardian-sync.test.ts`

**Interfaces:**
- Consumes: store action `checkGuardianDrift` (T5).

- [ ] **Step 1: Write the failing test** — assert `checkGuardianDrift` is called per guardian account each cycle.

```ts
it('checks guardian drift for each guardian account with a hot key', async () => {
  const checkGuardianDrift = jest.fn();
  mockStore({
    accounts: [
      { publicKey: 'pk1', type: WalletType.Guardian, hotPublicKey: 'h1' },
      { publicKey: 'pk2', type: WalletType.OnChain },
    ],
    checkGuardianDrift,
  });
  await syncGuardianAccounts();
  expect(checkGuardianDrift).toHaveBeenCalledWith('pk1');
  expect(checkGuardianDrift).not.toHaveBeenCalledWith('pk2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/front/guardian-sync -t "guardian drift"` → Expected: FAIL.

- [ ] **Step 3: Add the call** inside the existing per-account loop in `syncGuardianAccounts`, after `service.sync()`, inside the try (best-effort; the existing `catch` at line 73 already swallows per-account errors):

```ts
// src/lib/miden/front/guardian-sync.ts — inside the for-loop, after service.sync()
await useWalletStore.getState().checkGuardianDrift(account.publicKey).catch(() => {});
```

- [ ] **Step 4: Run tests** — Run: `yarn test src/lib/miden/front/guardian-sync` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/miden/front/guardian-sync.ts src/lib/miden/front/guardian-sync.test.ts
git commit -m "feat(guardian): run drift check on the 3s guardian sync loop"
```

---

## Milestone 3 — needs-user-input UI (wallet)

### Task 7: Custom-URL prompt banner + verified apply

**Files:**
- Create: `src/app/templates/GuardianNeedsUrlBanner.tsx`
- Modify: `src/lib/miden/back/guardian-drift.ts` (add `applyUserGuardianEndpoint`) + register action (actions/main/store/client)
- Modify: the home prompts host (grep where `ActivateHotKeyBanner` is mounted) + `public/_locales/en/en.json`
- Test: `src/lib/miden/back/guardian-drift.test.ts` (apply path) + `src/app/templates/GuardianNeedsUrlBanner.test.tsx`

**Interfaces:**
- Consumes: `verifyEndpointMatchesCommitment` (T4), vault setters (T2), `getGuardianCommitmentFromAccount` (T3).
- Produces: `applyUserGuardianEndpoint(vault, accountPublicKey, endpoint): Promise<boolean>`; store action `applyUserGuardianEndpoint`.

- [ ] **Step 1: Write the failing test** (apply path — verified before persist)

```ts
jest.mock('lib/miden/guardian/operator-map', () => ({
  identifyGuardianOperator: jest.fn(),
  verifyEndpointMatchesCommitment: jest.fn(),
}));
import { applyUserGuardianEndpoint } from './guardian-drift';
import { verifyEndpointMatchesCommitment } from 'lib/miden/guardian/operator-map';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';

it('persists a user URL only when it matches the on-chain commitment', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
  (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue(true);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });
  expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe(true);
  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://mine');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

it('rejects a user URL that does not match on-chain', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
  (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue(false);
  const vault = makeVault({ publicKey: 'pk' });
  expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://wrong')).toBe(false);
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/back/guardian-drift -t "user URL"` → Expected: FAIL.

- [ ] **Step 3: Implement `applyUserGuardianEndpoint`**

```ts
// src/lib/miden/back/guardian-drift.ts
export async function applyUserGuardianEndpoint(
  vault: GuardianDriftVault,
  accountPublicKey: string,
  endpoint: string
): Promise<boolean> {
  const onChain = await withWasmClientLock(async () => {
    const sdkAccount = await (await getMidenClient()).getAccount(accountPublicKey);
    return sdkAccount ? getGuardianCommitmentFromAccount(sdkAccount) : undefined;
  });
  if (!onChain) return false;
  const ok = await verifyEndpointMatchesCommitment(endpoint, onChain);
  if (!ok) return false;
  await vault.setGuardianEndpoint(accountPublicKey, endpoint);
  await vault.setGuardianOperatorCommitment(accountPublicKey, onChain);
  await vault.setGuardianSyncStatus(accountPublicKey, 'in-sync');
  return true;
}
```

- [ ] **Step 4: Build the banner** (clone `ActivateHotKeyBanner.tsx`; gate on `guardianSyncStatus === 'needs-user-input'`; reuse `sanitizeGuardianUrl`/`isValidGuardianUrl` from GuardianSettings/ImportRecoveryMethod for the URL field; call the `applyUserGuardianEndpoint` store action; `hapticLight()` on tap). Add i18n keys:

```json
// public/_locales/en/en.json
"guardianChangedTitle": { "message": "Guardian changed" },
"guardianChangedBody": { "message": "Your guardian was switched and we couldn't identify the new operator. Enter its URL to reconnect." },
"guardianUrlMismatch": { "message": "That operator doesn't match your account's on-chain guardian." }
```

Mount the banner where `ActivateHotKeyBanner` is mounted. Add a component test asserting it renders only when status is `needs-user-input` and that submit calls the action. Run: `yarn test src/app/templates/GuardianNeedsUrlBanner && yarn test src/lib/miden/back/guardian-drift` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib src/app public/_locales
git commit -m "feat(guardian): needs-user-input banner + verified custom-URL apply"
```

---

## Milestone 4 — dApp exposure backend (wallet)

### Task 8: `GuardianInfo` wire type + `requestGuardianInfo` handler + dispatch

**Files:**
- Modify: `src/lib/adapter/types.ts` (enum 50-75, interfaces ~174, unions 16-44)
- Modify: `src/lib/miden/back/dapp.ts` (handler + `getGuardianInfoData`) + `src/lib/miden/back/actions.ts` (import + case)
- Test: `src/lib/miden/back/dapp.test.ts` (or nearest handler test)

**Interfaces:**
- Consumes: `resolveGuardianEndpoint`, `guardianProviderFromEndpoint` (T3), `WalletType`, `getDApp`, vault.
- Produces: wire enum `GuardianInfoRequest/Response`, `MidenDAppGuardianInfoRequest/Response` (`guardianInfo: GuardianInfo`), `requestGuardianInfo(origin, req)`.

- [ ] **Step 1: Write the failing test**

```ts
it('requestGuardianInfo returns endpoint + provider + status for a guardian account', async () => {
  seedDApp({ origin: 'https://dapp', sourcePublicKey: 'pk', accountId: 'pk' });
  mockAccount({
    publicKey: 'pk', type: WalletType.Guardian,
    guardianEndpoint: 'https://guardian.openzeppelin.com',
    guardianSyncStatus: 'in-sync',
  });
  const res = await requestGuardianInfo('https://dapp', {
    type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey: 'pk',
  });
  expect(res.guardianInfo).toEqual({
    isGuardianAccount: true,
    guardianEndpoint: 'https://guardian.openzeppelin.com',
    guardianProvider: 'open-zeppelin',
    guardianSyncStatus: 'in-sync',
  });
});

it('returns the null/false shape for a non-guardian account', async () => {
  seedDApp({ origin: 'https://dapp', sourcePublicKey: 'pk2', accountId: 'pk2' });
  mockAccount({ publicKey: 'pk2', type: WalletType.OnChain });
  const res = await requestGuardianInfo('https://dapp', {
    type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey: 'pk2',
  });
  expect(res.guardianInfo).toEqual({
    isGuardianAccount: false, guardianEndpoint: null, guardianProvider: null, guardianSyncStatus: null,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/miden/back/dapp -t "requestGuardianInfo"` → Expected: FAIL.

- [ ] **Step 3: Add wire types + handler**

```ts
// src/lib/adapter/types.ts — enum (after AssetsResponse ~68)
  GuardianInfoRequest = 'GUARDIAN_INFO_REQUEST',
  GuardianInfoResponse = 'GUARDIAN_INFO_RESPONSE',
```

```ts
// src/lib/adapter/types.ts — interfaces (after Assets ~182); import GuardianInfo from 'lib/shared/types'
export interface MidenDAppGuardianInfoRequest extends MidenDAppMessageBase {
  type: MidenDAppMessageType.GuardianInfoRequest;
  sourcePublicKey: string;
}
export interface MidenDAppGuardianInfoResponse extends MidenDAppMessageBase {
  type: MidenDAppMessageType.GuardianInfoResponse;
  guardianInfo: GuardianInfo;
}
```

Add `MidenDAppGuardianInfoRequest`/`Response` to the `MidenDAppRequest`/`MidenDAppResponse` unions (16-44).

```ts
// src/lib/miden/back/dapp.ts — direct-return handler (model on getCurrentPermission, NOT Assets — no confirm)
export async function requestGuardianInfo(
  origin: string,
  req: MidenDAppGuardianInfoRequest
): Promise<MidenDAppGuardianInfoResponse> {
  if (!req?.sourcePublicKey) throw new Error(MidenDAppErrorType.InvalidParams);
  const dApp = await getDApp(origin, req.sourcePublicKey);
  if (!dApp) throw new Error(MidenDAppErrorType.NotGranted);
  const guardianInfo = await getGuardianInfoData(dApp.accountId);
  return { type: MidenDAppMessageType.GuardianInfoResponse, guardianInfo };
}

async function getGuardianInfoData(accountId: string): Promise<GuardianInfo> {
  return withUnlocked(async ({ vault }) => {
    const account = await vault.getAccount(accountId);
    if (!account || account.type !== WalletType.Guardian) {
      return { isGuardianAccount: false, guardianEndpoint: null, guardianProvider: null, guardianSyncStatus: null };
    }
    const guardianEndpoint = await resolveGuardianEndpoint(account);
    const status = account.guardianSyncStatus ?? 'in-sync';
    return {
      isGuardianAccount: true,
      guardianEndpoint: guardianEndpoint || null,
      guardianProvider: guardianProviderFromEndpoint(guardianEndpoint || null),
      guardianSyncStatus: status === 'in-sync' ? 'in-sync' : 'out-of-sync',
    };
  });
}
```

Add the dispatch case in `back/actions.ts` (after Assets ~423) and the import:

```ts
    case MidenDAppMessageType.GuardianInfoRequest:
      return withInited(() => getDappQueue().add(() => requestGuardianInfo(origin, req)));
```

- [ ] **Step 4: Run tests** — Run: `yarn test src/lib/miden/back/dapp -t "GuardianInfo"` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat(guardian): dApp requestGuardianInfo backend handler + wire types"
```

### Task 9: Wallet-side dApp SDK (`client.ts`, `midenWindowObject.ts`, injection script)

**Files:**
- Modify: `src/lib/adapter/client.ts` (~181), `src/lib/adapter/midenWindowObject.ts` (~19, ~90), `src/lib/dapp-browser/injection-script.ts` (~279)
- Test: `src/lib/adapter/client.test.ts`

**Interfaces:**
- Consumes: wire types (T8).
- Produces: `requestGuardianInfo(sourcePublicKey): Promise<GuardianInfo>` (client); `window.miden.requestGuardianInfo(): Promise<{ guardianInfo: GuardianInfo }>`.

- [ ] **Step 1: Write the failing test** (mock `request`, assert wire type + unwrap)

```ts
it('requestGuardianInfo posts the GuardianInfo request and returns the payload', async () => {
  (request as jest.Mock).mockResolvedValue({
    type: MidenDAppMessageType.GuardianInfoResponse,
    guardianInfo: { isGuardianAccount: true, guardianEndpoint: 'https://g', guardianProvider: 'gateway', guardianSyncStatus: 'in-sync' },
  });
  const info = await requestGuardianInfo('pk');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey: 'pk',
  }));
  expect(info.guardianProvider).toBe('gateway');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/adapter/client -t "requestGuardianInfo"` → Expected: FAIL.

- [ ] **Step 3: Implement** (clone `requestAssets` at client.ts:181; midenWindowObject.ts:90; injection-script.ts:279 using raw string `'GUARDIAN_INFO_REQUEST'`)

```ts
// src/lib/adapter/client.ts
export async function requestGuardianInfo(sourcePublicKey: string): Promise<GuardianInfo> {
  const res = await request({ type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey });
  assertResponse(res.type === MidenDAppMessageType.GuardianInfoResponse);
  return res.guardianInfo;
}
```

```ts
// src/lib/adapter/midenWindowObject.ts
  async requestGuardianInfo(): Promise<{ guardianInfo: GuardianInfo }> {
    const res = await requestGuardianInfo(this.address!);
    return { guardianInfo: res };
  }
```

- [ ] **Step 4: Run tests** — Run: `yarn test src/lib/adapter/client` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/adapter src/lib/dapp-browser
git commit -m "feat(guardian): wallet-side dApp SDK requestGuardianInfo + window.miden method"
```

---

## Milestone 5 — Adapter exposure (wallet-adapter repo)

> Work in `/Users/celrisen/miden/wallet-adapter`. Adapter tests: from repo root `yarn workspace @miden-sdk/miden-wallet-adapter-base test` (Vitest), or `cd packages/core/base && npx vitest run`.

### Task 10: `GuardianInfo` type + `requestGuardianInfo` on base props/abstract

**Files:**
- Modify: `packages/core/base/types.ts` (~30), `packages/core/base/signer.ts` (9, 29, 60)
- Test: `packages/core/base/__tests__/signer.test.ts` *(new if absent)*

**Interfaces:**
- Produces: `GuardianInfo` (base); `MessageSignerWalletAdapterProps.requestGuardianInfo(): Promise<GuardianInfo>`; abstract `requestGuardianInfo`.

- [ ] **Step 1: Write the failing test** — a type/contract test that a concrete adapter must implement `requestGuardianInfo` (or a shape test on the exported `GuardianInfo`).

```ts
import type { GuardianInfo } from '../types';
it('GuardianInfo has the agreed shape', () => {
  const g: GuardianInfo = { isGuardianAccount: false, guardianEndpoint: null, guardianProvider: null, guardianSyncStatus: null };
  expect(Object.keys(g).sort()).toEqual(['guardianEndpoint', 'guardianProvider', 'guardianSyncStatus', 'isGuardianAccount']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core/base && npx vitest run` → Expected: FAIL (GuardianInfo undefined).

- [ ] **Step 3: Add the type + declarations**

```ts
// packages/core/base/types.ts
export interface GuardianInfo {
  isGuardianAccount: boolean;
  guardianEndpoint: string | null;
  guardianProvider: 'open-zeppelin' | 'gateway' | 'lambda-class' | 'custom' | null;
  guardianSyncStatus: 'in-sync' | 'out-of-sync' | null;
}
```

```ts
// packages/core/base/signer.ts — import (line 9) add GuardianInfo next to Asset
// in MessageSignerWalletAdapterProps (after requestAssets, ~29):
  requestGuardianInfo(): Promise<GuardianInfo>;
// in BaseMessageSignerWalletAdapter (after abstract requestAssets, ~60):
  abstract requestGuardianInfo(): Promise<GuardianInfo>;
```

- [ ] **Step 4: Run tests** — Run: `cd packages/core/base && npx vitest run` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/base
git commit -m "feat(guardian): GuardianInfo type + requestGuardianInfo on base signer props"
```

### Task 11: Concrete adapter method (`packages/wallets/miden/adapter.ts`)

**Files:**
- Modify: `packages/wallets/miden/adapter.ts` (import ~2-27; `MidenWallet` iface ~47; concrete method clone of `requestAssets` 273-287)
- Test: `packages/wallets/miden/__tests__/adapter.test.ts` (or nearest)

- [ ] **Step 1: Write the failing test** — mock the injected `wallet.requestGuardianInfo` returning `{ guardianInfo }`, assert the adapter unwraps to `GuardianInfo` and emits `error` on throw.

```ts
it('requestGuardianInfo unwraps the provider result', async () => {
  const adapter = makeConnectedAdapter({
    requestGuardianInfo: async () => ({ guardianInfo: { isGuardianAccount: true, guardianEndpoint: 'https://g', guardianProvider: 'gateway', guardianSyncStatus: 'in-sync' } }),
  });
  await expect(adapter.requestGuardianInfo()).resolves.toMatchObject({ guardianProvider: 'gateway' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/wallets/miden && npx vitest run` → Expected: FAIL.

- [ ] **Step 3: Implement** (clone `requestAssets` 273-287; `wallet.requestAssets()`→`wallet.requestGuardianInfo()`, `result.assets`→`result.guardianInfo`; keep try/catch → `WalletTransactionError` → `emit('error')`; no `watchForFailure`). Add `requestGuardianInfo(): Promise<{ guardianInfo: GuardianInfo }>;` to the `MidenWallet` interface (~47) and `GuardianInfo` to the base import.

- [ ] **Step 4: Run tests** — Run: `cd packages/wallets/miden && npx vitest run` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallets/miden
git commit -m "feat(guardian): concrete adapter requestGuardianInfo"
```

### Task 12: Surface on both React hooks

**Files:**
- Modify: `packages/core/react/useWallet.ts` (type ~47, DEFAULT_CONTEXT stub 99-105)
- Modify: `packages/core/react/WalletProvider.tsx` (useMemo 310-322, value object ~430)
- Modify: `packages/core/react/MidenFiSignerProvider.tsx` (type ~61, useMemo 463-475, value+deps 686-733)
- Test: `packages/core/react/__tests__/useWallet.test.tsx` (or nearest)

- [ ] **Step 1: Write the failing test** — render a provider with a stub adapter, assert `useWallet().requestGuardianInfo` and `useMidenFiWallet().requestGuardianInfo` are wired and callable.

```tsx
it('exposes requestGuardianInfo through the provider', async () => {
  const { result } = renderHook(() => useWallet(), { wrapper: withWalletProvider(stubAdapter) });
  await act(() => result.current.select(stubAdapter.name));
  expect(typeof result.current.requestGuardianInfo).toBe('function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core/react && npx vitest run` (or the repo's react test command) → Expected: FAIL.

- [ ] **Step 3: Implement** (all three files — clone every `requestAssets` touch point):

```ts
// useWallet.ts — WalletContextState (~47):
  requestGuardianInfo: MessageSignerWalletAdapterProps['requestGuardianInfo'] | undefined;
// DEFAULT_CONTEXT (after requestAssets, 99-105):
  requestGuardianInfo() {
    return Promise.reject(console.error(constructMissingProviderErrorMessage('get', 'requestGuardianInfo')));
  },
```

```tsx
// WalletProvider.tsx — useMemo cloning requestAssets (310-322), guard "'requestGuardianInfo' in adapter",
// deps [adapter, handleError, connected]; then add `requestGuardianInfo,` to the inline value object (~430).
// MidenFiSignerProvider.tsx — type (~61) `requestGuardianInfo?: MessageSignerWalletAdapterProps['requestGuardianInfo'];`,
// useMemo (463-475), and add `requestGuardianInfo,` to BOTH walletContextValue (~700) AND its deps array (~723).
```

- [ ] **Step 4: Run tests** — Run: `cd packages/core/react && npx vitest run` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/react
git commit -m "feat(guardian): expose requestGuardianInfo on useWallet + useMidenFiWallet"
```

---

## Milestone 6 — Gating, CHANGELOG, integration

### Task 13: Gate guardian-dependent ops while not in-sync

**Files:**
- Modify: the guardian transaction entry points (grep guardian tx builders in `src/lib/miden/activity/transactions.ts` and the send/consume paths that require the guardian co-signer)
- Test: colocated unit test asserting a guardian op is blocked when `guardianSyncStatus !== 'in-sync'`

- [ ] **Step 1: Write the failing test** — a guardian-signed operation rejects with a clear error when the account's `guardianSyncStatus` is `needs-user-input`.

```ts
it('blocks guardian co-signing while guardian is out of sync', async () => {
  const account = { publicKey: 'pk', type: WalletType.Guardian, guardianSyncStatus: 'needs-user-input' };
  await expect(assertGuardianInSync(account)).rejects.toThrow('guardian out of sync');
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `yarn test -t "guardian out of sync"` → Expected: FAIL.

- [ ] **Step 3: Implement** a small `assertGuardianInSync(account)` guard and call it at the guardian-tx entry points.

```ts
export function assertGuardianInSync(account: { guardianSyncStatus?: GuardianSyncStatus }): void {
  if (account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync') {
    throw new Error('guardian out of sync');
  }
}
```

- [ ] **Step 4: Run tests** — Run: `yarn test -t "guardian out of sync"` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib
git commit -m "feat(guardian): gate guardian ops while endpoint is out of sync"
```

### Task 14: CHANGELOG + full-suite + coverage gate

- [ ] **Step 1:** Add ONE CHANGELOG line under the current `(TBD)` section (verify latest tag first):

```
- Guardian accounts now auto-detect and reconcile out-of-band guardian switches; dApps can read guardian info via `requestGuardianInfo()`.
```

- [ ] **Step 2: Run the full wallet suite with coverage** — Run: `yarn test:coverage` → Expected: PASS, all four metrics ≥95. If any new file drags a metric under 95, add targeted tests before proceeding (per Global Constraints).

- [ ] **Step 3: Run adapter suite** — from `/Users/celrisen/miden/wallet-adapter`: `yarn test` (all workspaces) → Expected: PASS.

- [ ] **Step 4: Lint + i18n + typecheck** — Run: `yarn lint && yarn lint:i18n` (wallet) → Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(guardian): changelog for guardian info exposure + resolution"
```

---

## Notes for the executor

- **Two repos, two branches.** Wallet work on `wiktor/guardian-info-exposure` (this worktree). Adapter work (Tasks 10-12) on a branch in `/Users/celrisen/miden/wallet-adapter`; open its PR first and note the version the wallet consumes. The two integrate over the **string wire protocol**, not shared TS types, so they can be tested independently.
- **Detection lives in the backend** (`guardian-drift.ts`) because reading the on-chain guardian commitment needs the WASM client and persisting needs the vault; the frontend 3s loop only triggers it (Task 6).
- **No confirmation prompt** for `requestGuardianInfo` — it is non-sensitive and returns directly (Task 8), so it works uniformly on extension/mobile/desktop with no `ConfirmPage`/confirmation-store changes.
- **Operator key rotation:** if `identifyGuardianOperator` misses because an operator rotated its key, the account lands in `needs-user-input`. A future optimization (cache-bust + re-probe before prompting) is noted in the spec §11 — out of scope here.
