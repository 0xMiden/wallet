# Wallet Telemetry & Crash Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn where people get stuck in Wallet — start, result, and duration per flow, plus scrubbed crash reports — behind an off-by-default **Help improve Wallet** setting, without ever transmitting anything about a user's money or activity.

**Architecture:** A first-party emitter with exactly one egress point in the background service worker. A screen reports a flow; an intercom message crosses to the background; the background checks consent, builds an allowlisted payload, and sends. The wire type has no free-text field and no index signature, so forbidden data fails to typecheck rather than relying on review. Vendors are dumb sinks: Aptabase (EU) for product events, Sentry (EU) for crashes.

**Tech Stack:** TypeScript (strict, no `any`, no `as`), React, Zustand, Jest + React Testing Library, Playwright. Vendor sinks reached over plain `fetch` — no analytics SDK.

**Spec:** `docs/superpowers/specs/2026-08-20-wallet-telemetry-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-20-web-sdk-observability.md`. Tasks 1-12 here do not need it. **Task 13 requires the published SDK version**, and the wallet PR cannot merge until that version is out.

## Global Constraints

- **One egress point.** Only `src/lib/telemetry/sink.ts`, running in the background service worker, may make a telemetry network request. No frontend module calls `fetch` for telemetry.
- **No free-text on the wire.** The payload type has no `string` field outside a closed literal union, no `object` field, and no index signature. `appVersion` and `platform` are derived in the background and cannot be passed in.
- **Build payloads field by field.** Never spread into a wire payload. No `{...properties}`, no `Object.assign` onto an outbound object.
- **Consent defaults to off**, and absence of a stored choice means "never asked", which also sends nothing.
- **Off means off.** Turning the setting off stops sends *and* drops the queue. Never queue while off and flush on opt-in.
- **Never enable the SDK's `observeSensitive`.** The option name must appear nowhere in `src/`.
- **No ATT.** `AppTrackingTransparency`, `NSUserTrackingUsageDescription`, `ATTrackingManager`, `IDFA`, and `advertisingIdentifier` must appear nowhere in `ios/`, `android/`, or `src/`.
- TypeScript is strict: **no `any`, no `as`**. Use explicit domain types. Preserve absolute imports (`app/...`, `lib/...`, `shared/...`).
- All user-facing text via `t('key')` or `<T id="key" />`; new flat keys go in `public/_locales/en/en.json`. `yarn lint:i18n` blocks raw strings.
- Jest coverage must stay at or above **95%** for branches, functions, lines, and statements.
- Prettier: 120 columns, two spaces, single quotes, semicolons. `yarn format` fixes.
- Commit messages: single-line, short, imperative. **Never** add `Co-Authored-By` or any agent attribution. Never `git push` without being asked.

---

### Task 1: Delete the dead analytics scaffold

Removing it first means later tasks can't accidentally build on it, and the tree has one telemetry story rather than two.

**Files:**
- Delete: `src/lib/analytics/` (all 19 files)
- Delete: `src/lib/miden/analytics-types.ts`, `src/lib/shared/analytics-types.ts`, `src/lib/shared/analytics-types.test.ts`
- Modify: `src/lib/miden/back/main.ts:214-222` (remove the commented-out handlers)
- Modify: `src/lib/shared/types.ts` (remove the six `Send*Event{Request,Response}` message types and their `WalletMessageType` members)
- Modify: `src/lib/woozie/Link.tsx`, `src/app/atoms/ToggleSwitch.tsx`, `src/app/atoms/FormSubmitButton.tsx`, `src/app/atoms/FormSecondaryButton.tsx`, `src/app/atoms/CopyButton.tsx`, `src/app/atoms/OpenInExplorerChip.tsx`, `src/app/pages/Welcome.tsx`, `src/app/pages/Unlock.tsx`, `src/app/templates/LanguageSettings.tsx`, `src/screens/generating-transaction/GeneratingTransaction.tsx` — remove `useAnalytics` / `useFormAnalytics` / `usePageRouterAnalytics` usage and any now-unused `testID`-adjacent analytics props
- Modify: `package.json` (remove `@segment/analytics-node`, line 155)
- Create: `src/lib/telemetry/legacy-cleanup.ts`
- Test: `src/lib/telemetry/legacy-cleanup.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `clearLegacyAnalyticsStorage(): void` — deletes the `analytics` key from `localStorage`. Called once at app startup (wired in Task 10).

**Why the cleanup function:** `src/lib/analytics/use-analytics-state.hook.ts` seeded `localStorage['analytics']` with `{ enabled: undefined, userId: nanoid() }`. Every existing install carries that persistent identifier. Deleting the code does not delete the data.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/telemetry/legacy-cleanup.test.ts
import { clearLegacyAnalyticsStorage } from './legacy-cleanup';

describe('clearLegacyAnalyticsStorage', () => {
  afterEach(() => localStorage.clear());

  it('removes the legacy analytics key and its persistent userId', () => {
    localStorage.setItem('analytics', JSON.stringify({ enabled: true, userId: 'abc123' }));
    clearLegacyAnalyticsStorage();
    expect(localStorage.getItem('analytics')).toBeNull();
  });

  it('is a no-op when the key is absent', () => {
    expect(() => clearLegacyAnalyticsStorage()).not.toThrow();
    expect(localStorage.getItem('analytics')).toBeNull();
  });

  it('leaves other settings untouched', () => {
    localStorage.setItem('analytics', '{}');
    localStorage.setItem('theme_setting', '"dark"');
    clearLegacyAnalyticsStorage();
    expect(localStorage.getItem('theme_setting')).toBe('"dark"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/legacy-cleanup.test.ts`
Expected: FAIL — cannot resolve `./legacy-cleanup`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/telemetry/legacy-cleanup.ts
/**
 * The removed `src/lib/analytics/` scaffold seeded `localStorage['analytics']`
 * with a `nanoid()` userId that persisted for the life of the install. Deleting
 * the code does not delete the data, so every existing install still carries a
 * dormant long-lived identifier that nothing owns. Clear it at startup.
 */
const LEGACY_ANALYTICS_KEY = 'analytics';

export function clearLegacyAnalyticsStorage(): void {
  try {
    localStorage.removeItem(LEGACY_ANALYTICS_KEY);
  } catch {
    // A storage failure here is not worth failing startup over; the next
    // launch retries.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/telemetry/legacy-cleanup.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Delete the scaffold**

```bash
git rm -r src/lib/analytics
git rm src/lib/miden/analytics-types.ts src/lib/shared/analytics-types.ts src/lib/shared/analytics-types.test.ts
yarn remove @segment/analytics-node
```

- [ ] **Step 6: Remove every call site**

Work through the ten files listed above. In each, delete the `useAnalytics` / `useFormAnalytics` / `usePageRouterAnalytics` import, the hook call, and the `trackEvent` / `pageEvent` / `performanceEvent` invocations. Keep `testID` props — they feed `data-testid` for E2E and are unrelated to telemetry despite living next to it. Remove the commented-out handler block at `src/lib/miden/back/main.ts:214-222` and the corresponding `WalletMessageType` members and interfaces from `src/lib/shared/types.ts`.

- [ ] **Step 7: Verify the tree is clean**

Run: `yarn ts && yarn lint && yarn test`
Expected: PASS. Type-check is the real gate — it finds every missed import. Also confirm nothing references the removed modules:

```bash
rg -n "lib/analytics|analytics-types|useAnalytics|AnalyticsEventCategory|@segment" src && echo "LEAKS FOUND" || echo "clean"
```
Expected: `clean`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(telemetry): remove the dead analytics scaffold and its stored identifier"
```

---

### Task 2: Consent setting

**Files:**
- Modify: `src/lib/settings/constants.ts` (add the key and default)
- Modify: `src/lib/settings/helpers.ts` (add the three helpers)
- Test: `src/lib/settings/helpers.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `setSetting`, `getSetting`, `mirrorSetting`, `readMirroredSetting` — existing module-private helpers in `src/lib/settings/helpers.ts:16-51`.
- Produces:
  - `setTelemetrySetting(enabled: boolean): void`
  - `isTelemetryEnabled(): boolean` — `false` when unset
  - `isTelemetryEnabledAsync(): Promise<boolean>` — service-worker-safe, `false` on read-miss
  - `hasTelemetryChoice(): boolean` — whether the user has ever answered

**Why `hasTelemetryChoice` rather than a tri-state value:** the existing `getSetting` returns its default on absence, so `isTelemetryEnabled()` already reads `false` for a fresh install — which is the required "off until the user turns it on". The only other thing anyone needs to know is whether to *ask*, and that is exactly key-absence. This reuses the existing boolean helpers rather than introducing tri-state machinery beside them.

Note the default direction differs from `AUTO_CONSUME`: that one defaults **on** so existing users are not silently opted out of a feature. Telemetry defaults **off** on read-miss, so a mirror failure fails closed.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/lib/settings/helpers.test.ts
import {
  setTelemetrySetting,
  isTelemetryEnabled,
  isTelemetryEnabledAsync,
  hasTelemetryChoice
} from './helpers';
import { TELEMETRY_STORAGE_KEY } from './constants';

describe('telemetry consent setting', () => {
  afterEach(() => localStorage.clear());

  it('is off on a fresh install', () => {
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('reports no choice made on a fresh install', () => {
    expect(hasTelemetryChoice()).toBe(false);
  });

  it('reports a choice once the user turns it on', () => {
    setTelemetrySetting(true);
    expect(hasTelemetryChoice()).toBe(true);
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('reports a choice once the user explicitly turns it off', () => {
    setTelemetrySetting(false);
    expect(hasTelemetryChoice()).toBe(true);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('persists under the documented key', () => {
    setTelemetrySetting(true);
    expect(localStorage.getItem(TELEMETRY_STORAGE_KEY)).toBe('true');
  });

  it('resolves false from the background mirror on a read miss', async () => {
    await expect(isTelemetryEnabledAsync()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/settings/helpers.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Add the constant**

In `src/lib/settings/constants.ts`, alongside the existing keys:

```typescript
export const TELEMETRY_STORAGE_KEY = 'telemetry_consent_setting';
/**
 * Off until the user turns it on. Also the read-miss default for the
 * background mirror, so a mirror failure fails closed rather than sending.
 */
export const DEFAULT_TELEMETRY = false;
```

- [ ] **Step 4: Add the helpers**

In `src/lib/settings/helpers.ts`, after the auto-consume helpers, and add `TELEMETRY_STORAGE_KEY` / `DEFAULT_TELEMETRY` to the existing `./constants` import:

```typescript
export function setTelemetrySetting(enabled: boolean) {
  setSetting(TELEMETRY_STORAGE_KEY, enabled);
  mirrorSetting(TELEMETRY_STORAGE_KEY, enabled);
}

export function isTelemetryEnabled() {
  return getSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);
}

/**
 * Service-worker-safe read of the telemetry consent toggle. The background is
 * the single consent gate for every send, so this is the authoritative read.
 * Defaults to OFF on read-miss — unlike auto-consume, a missing mirror here
 * must fail closed.
 */
export function isTelemetryEnabledAsync(): Promise<boolean> {
  return readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY);
}

/**
 * Whether the user has ever answered the telemetry prompt. Absence of the key
 * means "never asked", which is what drives the first-launch step — and which
 * still sends nothing, since `isTelemetryEnabled()` reads false.
 */
export function hasTelemetryChoice(): boolean {
  return localStorage.getItem(TELEMETRY_STORAGE_KEY) !== null;
}
```

- [ ] **Step 5: Mirror it at startup like the others**

In `mirrorBackgroundSettings` (`src/lib/settings/helpers.ts:98`), add the telemetry mirror before the marker line:

```typescript
  mirrorSetting(TELEMETRY_STORAGE_KEY, isTelemetryEnabled());
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test src/lib/settings/helpers.test.ts`
Expected: PASS, 6 new tests plus the existing suite.

- [ ] **Step 7: Commit**

```bash
git add src/lib/settings/constants.ts src/lib/settings/helpers.ts src/lib/settings/helpers.test.ts
git commit -m "feat(telemetry): add the off-by-default Help improve Wallet consent setting"
```

---

### Task 3: Wire types and the allowlist serializer

The load-bearing task. Everything after it depends on forbidden data being unrepresentable.

**Files:**
- Create: `src/lib/telemetry/types.ts`
- Create: `src/lib/telemetry/serialize.ts`
- Test: `src/lib/telemetry/serialize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TelemetryFlow` — closed union: `'open' | 'unlock' | 'create' | 'import' | 'recover' | 'return' | 'fund' | 'receive_share' | 'send' | 'note_handle' | 'activity_view'`
  - `type TelemetryResult` — `'completed' | 'cancelled' | 'errored'`
  - `type TelemetryErrorKind` — `'network' | 'rpc' | 'proving' | 'validation' | 'storage' | 'auth' | 'timeout' | 'unknown'`
  - `type TelemetryPlatform` — `'extension' | 'ios' | 'android'`
  - `interface FlowStartedEvent { phase: 'started'; flow: TelemetryFlow; flowId: string }`
  - `interface FlowEndedEvent { phase: 'ended'; flow: TelemetryFlow; flowId: string; result: TelemetryResult; errorKind?: TelemetryErrorKind; durationMs: number }`
  - `type TelemetryEvent = FlowStartedEvent | FlowEndedEvent`
  - `interface TelemetryContext { appVersion: string; platform: TelemetryPlatform }`
  - `interface TelemetryWirePayload` — the exact outbound shape
  - `serializeEvent(event: TelemetryEvent, context: TelemetryContext): TelemetryWirePayload`
  - `WIRE_KEYS: readonly string[]` — the allowlist, exported so tests and the sink share one source of truth

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/telemetry/serialize.test.ts
import { serializeEvent, WIRE_KEYS } from './serialize';
import { TelemetryContext, TelemetryEvent } from './types';

const context: TelemetryContext = { appVersion: '1.15.21', platform: 'extension' };

describe('serializeEvent', () => {
  it('serializes a started event with no result or duration', () => {
    const event: TelemetryEvent = { phase: 'started', flow: 'send', flowId: 'f1' };
    expect(serializeEvent(event, context)).toEqual({
      phase: 'started',
      flow: 'send',
      flowId: 'f1',
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('serializes a completed event with a rounded duration', () => {
    const event: TelemetryEvent = {
      phase: 'ended',
      flow: 'send',
      flowId: 'f1',
      result: 'completed',
      durationMs: 1234.87
    };
    expect(serializeEvent(event, context)).toEqual({
      phase: 'ended',
      flow: 'send',
      flowId: 'f1',
      result: 'completed',
      durationMs: 1235,
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('includes errorKind only when supplied', () => {
    const withKind = serializeEvent(
      { phase: 'ended', flow: 'send', flowId: 'f1', result: 'errored', errorKind: 'network', durationMs: 10 },
      context
    );
    expect(withKind.errorKind).toBe('network');

    const withoutKind = serializeEvent(
      { phase: 'ended', flow: 'send', flowId: 'f1', result: 'cancelled', durationMs: 10 },
      context
    );
    expect('errorKind' in withoutKind).toBe(false);
  });

  it('emits only allowlisted keys for every event shape', () => {
    const events: TelemetryEvent[] = [
      { phase: 'started', flow: 'open', flowId: 'a' },
      { phase: 'ended', flow: 'unlock', flowId: 'b', result: 'completed', durationMs: 1 },
      { phase: 'ended', flow: 'import', flowId: 'c', result: 'errored', errorKind: 'rpc', durationMs: 2 }
    ];
    for (const event of events) {
      for (const key of Object.keys(serializeEvent(event, context))) {
        expect(WIRE_KEYS).toContain(key);
      }
    }
  });

  it('derives appVersion and platform from context, ignoring any caller-supplied value', () => {
    const payload = serializeEvent({ phase: 'started', flow: 'open', flowId: 'a' }, context);
    expect(payload.appVersion).toBe('1.15.21');
    expect(payload.platform).toBe('extension');
  });

  it('never produces a nested object or array', () => {
    const payload = serializeEvent(
      { phase: 'ended', flow: 'send', flowId: 'f1', result: 'errored', errorKind: 'proving', durationMs: 5 },
      context
    );
    for (const value of Object.values(payload)) {
      expect(['string', 'number']).toContain(typeof value);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/serialize.test.ts`
Expected: FAIL — cannot resolve `./serialize`.

- [ ] **Step 3: Write the types**

```typescript
// src/lib/telemetry/types.ts
/**
 * Telemetry domain types.
 *
 * Every field is a closed literal union or a number. There is deliberately no
 * free-form `string` field, no `object` field, and no index signature anywhere
 * in `TelemetryWirePayload`. That is the design's primary privacy guarantee: an
 * address, an amount, a note id, or an `error.message` has no field it could
 * occupy, so it fails `yarn ts` before any test runs.
 *
 * Do not add a `string` field to the wire payload. Add a literal union.
 */

export type TelemetryFlow =
  | 'open'
  | 'unlock'
  | 'create'
  | 'import'
  | 'recover'
  | 'return'
  | 'fund'
  | 'receive_share'
  | 'send'
  | 'note_handle'
  | 'activity_view';

export type TelemetryResult = 'completed' | 'cancelled' | 'errored';

/** Broad categories only. Never a message, code, or detail string. */
export type TelemetryErrorKind =
  | 'network'
  | 'rpc'
  | 'proving'
  | 'validation'
  | 'storage'
  | 'auth'
  | 'timeout'
  | 'unknown';

export type TelemetryPlatform = 'extension' | 'ios' | 'android';

export interface FlowStartedEvent {
  phase: 'started';
  flow: TelemetryFlow;
  /**
   * Ephemeral, in-memory, never persisted. Exists only to join this event to
   * its `ended` counterpart so an unmatched `started` can be read as an
   * abandoned flow. Never reused.
   */
  flowId: string;
}

export interface FlowEndedEvent {
  phase: 'ended';
  flow: TelemetryFlow;
  flowId: string;
  result: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs: number;
}

export type TelemetryEvent = FlowStartedEvent | FlowEndedEvent;

/** Derived in the background. Callers cannot supply these. */
export interface TelemetryContext {
  appVersion: string;
  platform: TelemetryPlatform;
}

export interface TelemetryWirePayload {
  phase: 'started' | 'ended';
  flow: TelemetryFlow;
  flowId: string;
  result?: TelemetryResult;
  errorKind?: TelemetryErrorKind;
  durationMs?: number;
  appVersion: string;
  platform: TelemetryPlatform;
}
```

- [ ] **Step 4: Write the serializer**

```typescript
// src/lib/telemetry/serialize.ts
import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

/**
 * The complete set of keys that may ever appear on the wire. Exported so the
 * serializer test and the egress guard assert against one source of truth
 * rather than two lists that drift.
 */
export const WIRE_KEYS: readonly string[] = [
  'phase',
  'flow',
  'flowId',
  'result',
  'errorKind',
  'durationMs',
  'appVersion',
  'platform'
];

/**
 * Build the outbound payload field by field.
 *
 * This function must never spread. Spreading an event or a context into the
 * payload would let a future field reach the wire without appearing here, which
 * is exactly the failure mode the allowlist exists to prevent.
 */
export function serializeEvent(event: TelemetryEvent, context: TelemetryContext): TelemetryWirePayload {
  const payload: TelemetryWirePayload = {
    phase: event.phase,
    flow: event.flow,
    flowId: event.flowId,
    appVersion: context.appVersion,
    platform: context.platform
  };

  if (event.phase === 'ended') {
    payload.result = event.result;
    payload.durationMs = Math.round(event.durationMs);
    if (event.errorKind !== undefined) {
      payload.errorKind = event.errorKind;
    }
  }

  return payload;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/lib/telemetry/serialize.test.ts && yarn ts`
Expected: PASS, 6 tests, and a clean type-check.

- [ ] **Step 6: Commit**

```bash
git add src/lib/telemetry/types.ts src/lib/telemetry/serialize.ts src/lib/telemetry/serialize.test.ts
git commit -m "feat(telemetry): add the allowlisted wire type and serializer"
```

---

### Task 4: The sink — the single egress point

**Files:**
- Create: `src/lib/telemetry/sink.ts`
- Test: `src/lib/telemetry/sink.test.ts`

**Interfaces:**
- Consumes: `serializeEvent`, `WIRE_KEYS` (Task 3); `isTelemetryEnabledAsync` (Task 2); `TelemetryEvent`, `TelemetryContext` (Task 3).
- Produces:
  - `sendEvent(event: TelemetryEvent, context: TelemetryContext): Promise<void>` — consent-gated, queued, best-effort
  - `dropQueue(): void` — called when consent is withdrawn
  - `__setTransportForTest(transport: ((payload: TelemetryWirePayload) => Promise<void>) | null): void`
  - `__getQueueLengthForTest(): number`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/telemetry/sink.test.ts
import { sendEvent, dropQueue, __setTransportForTest, __getQueueLengthForTest } from './sink';
import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

jest.mock('lib/settings/helpers', () => ({
  isTelemetryEnabledAsync: jest.fn()
}));
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

const context: TelemetryContext = { appVersion: '1.15.21', platform: 'extension' };
const started: TelemetryEvent = { phase: 'started', flow: 'send', flowId: 'f1' };

describe('telemetry sink', () => {
  let sent: TelemetryWirePayload[];

  beforeEach(() => {
    sent = [];
    __setTransportForTest(async payload => {
      sent.push(payload);
    });
  });

  afterEach(() => {
    __setTransportForTest(null);
    dropQueue();
    jest.resetAllMocks();
  });

  it('sends nothing when consent is off', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    await sendEvent(started, context);
    expect(sent).toEqual([]);
  });

  it('sends nothing when consent has never been given', async () => {
    // Read-miss resolves false — a fresh install must be silent.
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    await sendEvent(started, context);
    expect(sent).toEqual([]);
  });

  it('sends the serialized payload when consent is on', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    await sendEvent(started, context);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      phase: 'started',
      flow: 'send',
      flowId: 'f1',
      appVersion: '1.15.21',
      platform: 'extension'
    });
  });

  it('emits only allowlisted keys', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    await sendEvent(
      { phase: 'ended', flow: 'send', flowId: 'f1', result: 'errored', errorKind: 'network', durationMs: 5 },
      context
    );
    for (const key of Object.keys(sent[0])) {
      expect(['phase', 'flow', 'flowId', 'result', 'errorKind', 'durationMs', 'appVersion', 'platform']).toContain(key);
    }
  });

  it('never throws when the transport fails', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(async () => {
      throw new Error('network down');
    });
    await expect(sendEvent(started, context)).resolves.toBeUndefined();
  });

  it('drops the queue when consent is withdrawn', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(() => new Promise(() => {}));
    void sendEvent(started, context);
    dropQueue();
    expect(__getQueueLengthForTest()).toBe(0);
  });

  it('bounds the queue so an offline device cannot grow it without limit', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    __setTransportForTest(() => new Promise(() => {}));
    for (let i = 0; i < 200; i++) {
      void sendEvent({ phase: 'started', flow: 'send', flowId: `f${i}` }, context);
    }
    await Promise.resolve();
    expect(__getQueueLengthForTest()).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/sink.test.ts`
Expected: FAIL — cannot resolve `./sink`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/telemetry/sink.ts
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { serializeEvent } from './serialize';
import { TelemetryContext, TelemetryEvent, TelemetryWirePayload } from './types';

/**
 * The ONLY telemetry egress point in the wallet.
 *
 * Nothing in `src/` may make a telemetry network request outside this module,
 * and this module runs in the background service worker. That is what makes the
 * consent gate a single auditable check rather than a discipline applied at
 * every call site, and what lets the E2E egress test assert against one
 * boundary instead of thirty.
 */

/** Bounded so an offline device cannot grow the queue without limit. */
const QUEUE_CAPACITY = 50;

type Transport = (payload: TelemetryWirePayload) => Promise<void>;

let queue: TelemetryWirePayload[] = [];
let transportOverride: Transport | null = null;

async function defaultTransport(payload: TelemetryWirePayload): Promise<void> {
  await fetch(process.env.TELEMETRY_INGEST_URL ?? '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * Consent-gate, serialize, and send one event. Never throws and never rejects:
 * telemetry must not be able to fail a wallet operation.
 */
export async function sendEvent(event: TelemetryEvent, context: TelemetryContext): Promise<void> {
  try {
    if (!(await isTelemetryEnabledAsync())) return;

    const payload = serializeEvent(event, context);
    queue.push(payload);
    while (queue.length > QUEUE_CAPACITY) queue.shift();

    const transport = transportOverride ?? defaultTransport;
    await transport(payload);
    queue = queue.filter(queued => queued !== payload);
  } catch {
    // Best-effort by design.
  }
}

/**
 * Discard everything pending. Called when consent is withdrawn, so turning the
 * setting off stops in-flight sharing rather than merely stopping new events.
 */
export function dropQueue(): void {
  queue = [];
}

/** Test-only: substitute the transport. */
export function __setTransportForTest(transport: Transport | null): void {
  transportOverride = transport;
}

/** Test-only: current queue depth. */
export function __getQueueLengthForTest(): number {
  return queue.length;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/lib/telemetry/sink.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the ingest URL to the environment**

Add `TELEMETRY_INGEST_URL=` to `.env.example` with a comment naming the Aptabase EU endpoint, and register it in the `define` block of each app vite config that already defines env vars: `vite.extension.config.ts`, `vite.background.config.ts`, `vite.mobile.config.ts`. Follow the existing pattern in those files exactly — do not invent a new mechanism.

- [ ] **Step 6: Verify the build still works**

Run: `yarn ts && yarn test src/lib/telemetry/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/telemetry/sink.ts src/lib/telemetry/sink.test.ts .env.example vite.extension.config.ts vite.background.config.ts vite.mobile.config.ts
git commit -m "feat(telemetry): add the consent-gated background sink"
```

---

### Task 5: Message plumbing and the background handler

**Files:**
- Modify: `src/lib/shared/types.ts` (add the message type and interfaces)
- Modify: `src/lib/miden/back/actions.ts` (add the handler)
- Modify: `src/lib/miden/back/main.ts` (register the handler)
- Modify: `src/lib/intercom/mobile-adapter.ts` (register the new message type)
- Create: `src/lib/telemetry/context.ts`
- Test: `src/lib/telemetry/context.test.ts`
- Test: `src/lib/miden/back/actions.test.ts` (extend)

**Interfaces:**
- Consumes: `sendEvent`, `dropQueue` (Task 4); `TelemetryEvent` (Task 3); `isMobile` / `isIOS` / `isAndroid` from `lib/platform`.
- Produces:
  - `WalletMessageType.ReportTelemetryEventRequest` / `ReportTelemetryEventResponse`
  - `interface ReportTelemetryEventRequest extends WalletMessageBase { type: WalletMessageType.ReportTelemetryEventRequest; event: TelemetryEvent }`
  - `resolveTelemetryContext(): TelemetryContext` in `context.ts` — derives `appVersion` from `package.json` version and `platform` from `lib/platform`
  - `handleReportTelemetryEvent(req: ReportTelemetryEventRequest): Promise<ReportTelemetryEventResponse>` in `actions.ts`

**Note:** the request carries only `event`. It deliberately does **not** carry `appVersion` or `platform` — those are derived in the background so a compromised or buggy frontend cannot supply them.

- [ ] **Step 1: Write the failing test for the context resolver**

```typescript
// src/lib/telemetry/context.test.ts
import { resolveTelemetryContext } from './context';

jest.mock('lib/platform', () => ({
  isIOS: jest.fn(() => false),
  isAndroid: jest.fn(() => false)
}));
import { isAndroid, isIOS } from 'lib/platform';

describe('resolveTelemetryContext', () => {
  afterEach(() => jest.resetAllMocks());

  it('reports the extension platform by default', () => {
    jest.mocked(isIOS).mockReturnValue(false);
    jest.mocked(isAndroid).mockReturnValue(false);
    expect(resolveTelemetryContext().platform).toBe('extension');
  });

  it('reports ios', () => {
    jest.mocked(isIOS).mockReturnValue(true);
    expect(resolveTelemetryContext().platform).toBe('ios');
  });

  it('reports android', () => {
    jest.mocked(isIOS).mockReturnValue(false);
    jest.mocked(isAndroid).mockReturnValue(true);
    expect(resolveTelemetryContext().platform).toBe('android');
  });

  it('reports a dotted semver app version', () => {
    expect(resolveTelemetryContext().appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/context.test.ts`
Expected: FAIL — cannot resolve `./context`.

- [ ] **Step 3: Write the context resolver**

```typescript
// src/lib/telemetry/context.ts
import { isAndroid, isIOS } from 'lib/platform';

import packageJson from '../../../package.json';
import { TelemetryContext, TelemetryPlatform } from './types';

function resolvePlatform(): TelemetryPlatform {
  if (isIOS()) return 'ios';
  if (isAndroid()) return 'android';
  return 'extension';
}

/**
 * Derive the allowed context in the background. Deliberately not passed in from
 * the frontend: a caller that could supply `appVersion` or `platform` could
 * supply anything, which is the hole the allowlist exists to close.
 */
export function resolveTelemetryContext(): TelemetryContext {
  return {
    appVersion: packageJson.version,
    platform: resolvePlatform()
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/telemetry/context.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the message type**

In `src/lib/shared/types.ts`, add to the `WalletMessageType` enum:

```typescript
  ReportTelemetryEventRequest = 'ReportTelemetryEventRequest',
  ReportTelemetryEventResponse = 'ReportTelemetryEventResponse',
```

and the interfaces, importing `TelemetryEvent` from `lib/telemetry/types`:

```typescript
export interface ReportTelemetryEventRequest extends WalletMessageBase {
  type: WalletMessageType.ReportTelemetryEventRequest;
  /** Only the event. Version and platform are derived in the background. */
  event: TelemetryEvent;
}

export interface ReportTelemetryEventResponse extends WalletMessageBase {
  type: WalletMessageType.ReportTelemetryEventResponse;
}
```

Add both to the union type that aggregates wallet messages in that file.

- [ ] **Step 6: Add the handler**

In `src/lib/miden/back/actions.ts`:

```typescript
export async function handleReportTelemetryEvent(
  req: ReportTelemetryEventRequest
): Promise<ReportTelemetryEventResponse> {
  await sendEvent(req.event, resolveTelemetryContext());
  return { type: WalletMessageType.ReportTelemetryEventResponse };
}
```

Register it in `src/lib/miden/back/main.ts` beside the other cases (this is where the deleted commented-out analytics handlers used to sit):

```typescript
    case WalletMessageType.ReportTelemetryEventRequest:
      return await Actions.handleReportTelemetryEvent(req);
```

Register the new message type in `src/lib/intercom/mobile-adapter.ts`, matching how the existing types are listed there — without this, the message never crosses on mobile.

- [ ] **Step 7: Write the handler test**

```typescript
// append to src/lib/miden/back/actions.test.ts
jest.mock('lib/telemetry/sink', () => ({ sendEvent: jest.fn() }));
import { sendEvent } from 'lib/telemetry/sink';
import { handleReportTelemetryEvent } from './actions';
import { WalletMessageType } from 'lib/shared/types';

describe('handleReportTelemetryEvent', () => {
  afterEach(() => jest.resetAllMocks());

  it('forwards the event with a background-derived context', async () => {
    const response = await handleReportTelemetryEvent({
      type: WalletMessageType.ReportTelemetryEventRequest,
      event: { phase: 'started', flow: 'send', flowId: 'f1' }
    });
    expect(response.type).toBe(WalletMessageType.ReportTelemetryEventResponse);
    expect(jest.mocked(sendEvent).mock.calls[0][1]).toEqual({
      appVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      platform: expect.any(String)
    });
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `yarn test src/lib/telemetry/ src/lib/miden/back/actions.test.ts && yarn ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/shared/types.ts src/lib/miden/back/actions.ts src/lib/miden/back/main.ts src/lib/intercom/mobile-adapter.ts src/lib/telemetry/context.ts src/lib/telemetry/context.test.ts src/lib/miden/back/actions.test.ts
git commit -m "feat(telemetry): plumb flow events from the frontend to the background gate"
```

---

### Task 6: The flow reporting primitive

One API for every flow, so no screen needs to know how telemetry works.

**Files:**
- Create: `src/lib/telemetry/report-flow.ts`
- Create: `src/lib/telemetry/index.ts`
- Test: `src/lib/telemetry/report-flow.test.ts`

**Interfaces:**
- Consumes: `request` from `lib/miden/front`; `WalletMessageType`, `ReportTelemetryEventRequest` (Task 5); `TelemetryFlow`, `TelemetryErrorKind` (Task 3).
- Produces:
  - `beginFlow(flow: TelemetryFlow): FlowHandle`
  - `interface FlowHandle { complete(): void; cancel(): void; fail(kind: TelemetryErrorKind): void }`
  - `classifyError(error: unknown): TelemetryErrorKind`
  - `src/lib/telemetry/index.ts` re-exports `beginFlow`, `classifyError`, and the public types.

**Semantics:** `beginFlow` emits `started` immediately and starts a `performance.now()` clock. The first terminal call emits `ended`; subsequent calls on the same handle are ignored, so a flow can't double-report if both a cancel handler and an unmount fire.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/telemetry/report-flow.test.ts
jest.mock('lib/miden/front', () => ({ request: jest.fn().mockResolvedValue(undefined) }));
import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { beginFlow, classifyError } from './report-flow';

const sentEvents = () => jest.mocked(request).mock.calls.map(call => call[0].event);

describe('beginFlow', () => {
  afterEach(() => jest.resetAllMocks());

  it('emits a started event immediately', () => {
    beginFlow('send');
    expect(jest.mocked(request).mock.calls[0][0].type).toBe(WalletMessageType.ReportTelemetryEventRequest);
    expect(sentEvents()[0]).toMatchObject({ phase: 'started', flow: 'send' });
  });

  it('emits completed with a duration on complete', () => {
    beginFlow('send').complete();
    expect(sentEvents()[1]).toMatchObject({ phase: 'ended', flow: 'send', result: 'completed' });
    expect(typeof sentEvents()[1].durationMs).toBe('number');
  });

  it('emits cancelled on cancel', () => {
    beginFlow('import').cancel();
    expect(sentEvents()[1]).toMatchObject({ result: 'cancelled' });
  });

  it('emits errored with the supplied kind on fail', () => {
    beginFlow('recover').fail('rpc');
    expect(sentEvents()[1]).toMatchObject({ result: 'errored', errorKind: 'rpc' });
  });

  it('pairs started and ended by flowId', () => {
    beginFlow('send').complete();
    expect(sentEvents()[0].flowId).toBe(sentEvents()[1].flowId);
  });

  it('gives concurrent flows distinct ids', () => {
    beginFlow('send');
    beginFlow('fund');
    expect(sentEvents()[0].flowId).not.toBe(sentEvents()[1].flowId);
  });

  it('ignores a second terminal call on the same handle', () => {
    const flow = beginFlow('send');
    flow.complete();
    flow.cancel();
    expect(sentEvents()).toHaveLength(2);
  });

  it('never throws when the intercom request rejects', () => {
    jest.mocked(request).mockRejectedValue(new Error('port closed'));
    expect(() => beginFlow('send').complete()).not.toThrow();
  });
});

describe('classifyError', () => {
  it.each([
    ['Failed to fetch', 'network'],
    ['network request timed out', 'timeout'],
    ['rpc error: invalid response', 'rpc'],
    ['proving failed after fallback', 'proving'],
    ['QuotaExceededError writing to store', 'storage'],
    ['invalid password', 'auth'],
    ['amount must be positive', 'validation'],
    ['something nobody predicted', 'unknown']
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it('classifies a non-Error as unknown', () => {
    expect(classifyError('a bare string')).toBe('unknown');
  });

  it('never returns the original message', () => {
    const kind = classifyError(new Error('account mtst1secret balance 4200'));
    expect(kind).not.toContain('mtst1');
    expect(kind).not.toContain('4200');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/report-flow.test.ts`
Expected: FAIL — cannot resolve `./report-flow`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/telemetry/report-flow.ts
import { nanoid } from 'nanoid';

import { request } from 'lib/miden/front';
import { WalletMessageType } from 'lib/shared/types';

import { TelemetryErrorKind, TelemetryEvent, TelemetryFlow } from './types';

export interface FlowHandle {
  complete(): void;
  cancel(): void;
  fail(kind: TelemetryErrorKind): void;
}

function report(event: TelemetryEvent): void {
  void (async () => {
    try {
      await request({ type: WalletMessageType.ReportTelemetryEventRequest, event });
    } catch {
      // Telemetry must never surface as a user-visible failure.
    }
  })();
}

/**
 * Begin reporting a flow.
 *
 * Two events are emitted per flow rather than one. A single terminal event
 * would be lost whenever a user force-quits or the popup is dismissed
 * mid-flow — exactly the stuck users this exists to find. With a `started`
 * event already durable, an unmatched `started` IS the abandonment signal,
 * computed on the receiving side.
 *
 * `flowId` is ephemeral: it exists only to pair those two events, is never
 * persisted, and is never reused.
 */
export function beginFlow(flow: TelemetryFlow): FlowHandle {
  const flowId = nanoid();
  // Monotonic: a wall-clock adjustment mid-flow must not be able to produce a
  // negative or wildly inflated duration.
  const startedAt = performance.now();
  let settled = false;

  report({ phase: 'started', flow, flowId });

  const end = (result: 'completed' | 'cancelled' | 'errored', errorKind?: TelemetryErrorKind): void => {
    if (settled) return;
    settled = true;
    report({
      phase: 'ended',
      flow,
      flowId,
      result,
      durationMs: performance.now() - startedAt,
      ...(errorKind !== undefined ? { errorKind } : {})
    });
  };

  return {
    complete: () => end('completed'),
    cancel: () => end('cancelled'),
    fail: (kind: TelemetryErrorKind) => end('errored', kind)
  };
}

/**
 * Map an error to a broad category. The message is inspected but NEVER
 * returned — the return type is a closed union, so no caught text can reach
 * the wire through this function.
 */
export function classifyError(error: unknown): TelemetryErrorKind {
  if (!(error instanceof Error)) return 'unknown';
  const message = error.message.toLowerCase();

  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (message.includes('failed to fetch') || message.includes('network')) return 'network';
  if (message.includes('rpc')) return 'rpc';
  if (message.includes('prov')) return 'proving';
  if (message.includes('quota') || message.includes('store') || message.includes('indexeddb')) return 'storage';
  if (message.includes('password') || message.includes('unauthor') || message.includes('biometric')) return 'auth';
  if (message.includes('invalid') || message.includes('must be') || message.includes('required')) return 'validation';
  return 'unknown';
}
```

Note the ordering in `classifyError` is deliberate: `timeout` is tested before `network` because a timeout message often contains both words, and `validation` is tested last because `invalid` appears in many more specific messages.

- [ ] **Step 4: Write the barrel**

```typescript
// src/lib/telemetry/index.ts
export { beginFlow, classifyError } from './report-flow';
export { clearLegacyAnalyticsStorage } from './legacy-cleanup';
export type { FlowHandle } from './report-flow';
export type { TelemetryErrorKind, TelemetryFlow } from './types';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test src/lib/telemetry/report-flow.test.ts`
Expected: PASS, 8 + 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/telemetry/report-flow.ts src/lib/telemetry/index.ts src/lib/telemetry/report-flow.test.ts
git commit -m "feat(telemetry): add the flow reporting primitive and error classifier"
```

---

### Task 7: Instrument the getting-started flows

**Files:**
- Modify: `src/app/pages/Welcome.tsx` (the `onAction` host for the onboarding step machine — `create`, `import`, `recover`)
- Modify: `src/app/pages/Unlock.tsx` (`unlock`)
- Modify: `src/app/App.tsx` (`open` and `return`)
- Test: `src/app/pages/Welcome.test.tsx`, `src/app/pages/Unlock.test.tsx`, `src/app/App.test.tsx` (extend each)

**Interfaces:**
- Consumes: `beginFlow`, `classifyError`, `FlowHandle` from `lib/telemetry` (Task 6).
- Produces: no new exports.

**Instrumentation points.** Onboarding is a step machine (`OnboardingStep` / `OnboardingAction` in `src/screens/onboarding/types.ts`), dispatched through the single `onAction` prop of `OnboardingFlow` (`src/screens/onboarding/navigator.tsx:85`). Instrument the **host** that supplies `onAction`, not the individual screens — one call site per flow. `open` fires once per app launch; `return` fires when the app is re-foregrounded with an existing wallet.

- [ ] **Step 1: Write the failing test for onboarding**

```typescript
// append to src/app/pages/Welcome.test.tsx
jest.mock('lib/telemetry', () => ({
  beginFlow: jest.fn(() => ({ complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() })),
  classifyError: jest.fn(() => 'unknown')
}));
import { beginFlow } from 'lib/telemetry';

describe('Welcome telemetry', () => {
  afterEach(() => jest.resetAllMocks());

  it('begins the create flow when the user chooses to create a wallet', async () => {
    // Render Welcome and dispatch the create-path action through onAction.
    // (Use the file's existing render helper and action-dispatch pattern.)
    await renderWelcomeAndChooseCreate();
    expect(jest.mocked(beginFlow)).toHaveBeenCalledWith('create');
  });

  it('begins the import flow when the user chooses to import', async () => {
    await renderWelcomeAndChooseImport();
    expect(jest.mocked(beginFlow)).toHaveBeenCalledWith('import');
  });

  it('completes the flow when onboarding confirms', async () => {
    const handle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
    jest.mocked(beginFlow).mockReturnValue(handle);
    await renderWelcomeAndCompleteCreate();
    expect(handle.complete).toHaveBeenCalledTimes(1);
  });

  it('reports errored with a broad kind when wallet creation throws', async () => {
    const handle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
    jest.mocked(beginFlow).mockReturnValue(handle);
    await renderWelcomeAndFailCreate(new Error('rpc unavailable'));
    expect(handle.fail).toHaveBeenCalledWith('unknown');
    expect(handle.complete).not.toHaveBeenCalled();
  });

  it('never passes user input to the telemetry layer', async () => {
    await renderWelcomeAndCompleteImport('abandon abandon abandon');
    for (const call of jest.mocked(beginFlow).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('abandon');
    }
  });
});
```

Replace the `renderWelcomeAnd*` helpers with the render-and-dispatch pattern already used in `Welcome.test.tsx`. Wrap with `WalletStoreProvider` + `MidenContextProvider` and mock `lib/intercom`, per the testing guidance in `AGENTS.md`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/app/pages/Welcome.test.tsx`
Expected: FAIL — `beginFlow` is never called.

- [ ] **Step 3: Instrument the onboarding host**

In `src/app/pages/Welcome.tsx`, hold the handle in a ref and drive it from the existing action dispatcher:

```typescript
import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';

const flowRef = useRef<FlowHandle | null>(null);
```

Begin the flow when the user picks a path (`choose-protection` / `select-import-type` map to `create` / `import`; the guardian-recovery entry maps to `recover`). Call `flowRef.current?.complete()` when onboarding reaches its terminal success, `flowRef.current?.cancel()` when the user abandons back out of the flow, and `flowRef.current?.fail(classifyError(error))` in the existing catch paths. Clear the ref after a terminal call.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/app/pages/Welcome.test.tsx`
Expected: PASS.

- [ ] **Step 5: Instrument unlock**

Repeat Steps 1-4 for `src/app/pages/Unlock.tsx` with `beginFlow('unlock')` — complete on successful unlock, `fail(classifyError(error))` on a rejected password or biometric failure. Add the matching tests to `src/app/pages/Unlock.test.tsx`, including one asserting the entered password never appears in any telemetry call argument.

- [ ] **Step 6: Instrument open and return**

In `src/app/App.tsx`, `beginFlow('open')` on mount, completing once the app has rendered its first ready state. `beginFlow('return')` when the app is re-foregrounded with an existing wallet. Add tests to `src/app/App.test.tsx`.

- [ ] **Step 7: Run the full app suite**

Run: `yarn test src/app && yarn ts && yarn lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/pages/Welcome.tsx src/app/pages/Welcome.test.tsx src/app/pages/Unlock.tsx src/app/pages/Unlock.test.tsx src/app/App.tsx src/app/App.test.tsx
git commit -m "feat(telemetry): report the getting-started flows"
```

---

### Task 8: Instrument the everyday-use flows

**Files:**
- Modify: `src/screens/send-flow/SendManager.tsx` (`send`)
- Modify: the fund entry point and the receive/share screen (`fund`, `receive_share`)
- Modify: the note-handling entry point (`note_handle`)
- Modify: the activity/history screen (`activity_view`)
- Test: `src/screens/send-flow/SendManager.test.tsx` plus a co-located test per screen touched

**Interfaces:**
- Consumes: `beginFlow`, `classifyError`, `FlowHandle` from `lib/telemetry` (Task 6).
- Produces: no new exports.

**Instrumentation point.** `SendManager` wraps itself in `NavigatorProvider` and is exported as `SendFlow` (`src/screens/send-flow/SendManager.tsx:852-858`). Instrument the manager, not the step screens: mount begins the flow, the terminal submit completes it, and unmount without a terminal call cancels it.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/screens/send-flow/SendManager.test.tsx
jest.mock('lib/telemetry', () => ({
  beginFlow: jest.fn(() => ({ complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() })),
  classifyError: jest.fn(() => 'unknown')
}));
import { beginFlow } from 'lib/telemetry';

describe('SendManager telemetry', () => {
  afterEach(() => {
    testRoot.unmount();
    jest.resetAllMocks();
  });

  it('begins the send flow on mount', () => {
    renderSendManager();
    expect(jest.mocked(beginFlow)).toHaveBeenCalledWith('send');
  });

  it('completes on successful submission', async () => {
    const handle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
    jest.mocked(beginFlow).mockReturnValue(handle);
    await renderSendManagerAndSubmit();
    expect(handle.complete).toHaveBeenCalledTimes(1);
  });

  it('cancels when unmounted before a terminal state', () => {
    const handle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
    jest.mocked(beginFlow).mockReturnValue(handle);
    renderSendManager();
    testRoot.unmount();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a broad error kind on submission failure', async () => {
    const handle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
    jest.mocked(beginFlow).mockReturnValue(handle);
    await renderSendManagerAndFailSubmit(new Error('rpc error: node unreachable'));
    expect(handle.fail).toHaveBeenCalledWith('unknown');
  });

  it('never passes a recipient address or amount to telemetry', async () => {
    await renderSendManagerAndSubmit({ to: 'mtst1recipientaddress', amount: '4200' });
    const allCalls = JSON.stringify(jest.mocked(beginFlow).mock.calls);
    expect(allCalls).not.toContain('mtst1recipientaddress');
    expect(allCalls).not.toContain('4200');
  });
});
```

Use the render helpers already present in `SendManager.test.tsx`. `afterEach` must call `testRoot.unmount()` to avoid React cross-test pollution, per `AGENTS.md`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/screens/send-flow/SendManager.test.tsx`
Expected: FAIL — `beginFlow` is never called.

- [ ] **Step 3: Instrument `SendManager`**

```typescript
import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';

const flowRef = useRef<FlowHandle | null>(null);

useEffect(() => {
  flowRef.current = beginFlow('send');
  return () => {
    // A terminal call already marked the handle settled, so this cancel is a
    // no-op for a completed flow and the abandonment signal otherwise.
    flowRef.current?.cancel();
  };
}, []);
```

Call `flowRef.current?.complete()` where the flow reaches successful submission, and `flowRef.current?.fail(classifyError(error))` in the existing submission catch.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/screens/send-flow/SendManager.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Instrument the remaining four flows**

Repeat the mount/complete/cancel/fail pattern from Steps 1-4 for `fund`, `receive_share`, `note_handle`, and `activity_view`. Locate each entry point first:

```bash
rg -l "fund|receive|share" src/screens src/app/pages --glob '!*.test.*'
rg -l "history|activity" src/app/templates src/app/pages --glob '!*.test.*'
```

For each, add a co-located test with the same five cases, including the assertion that no address, amount, or note id reaches a telemetry call.

- [ ] **Step 6: Run the full suite and check coverage**

Run: `yarn test && yarn test:coverage`
Expected: PASS, with branches/functions/lines/statements all at or above 95%.

- [ ] **Step 7: Commit**

```bash
git add src/screens src/app
git commit -m "feat(telemetry): report the everyday-use flows"
```

---

### Task 9: Crash reporting

**Files:**
- Create: `src/lib/telemetry/redact.ts`
- Create: `src/lib/telemetry/crash.ts`
- Test: `src/lib/telemetry/redact.test.ts`
- Test: `src/lib/telemetry/crash.test.ts`
- Modify: `src/app/ErrorBoundary.tsx`
- Modify: `package.json` (add `@sentry/browser`)

**Interfaces:**
- Consumes: `isTelemetryEnabledAsync` (Task 2); `resolveTelemetryContext` (Task 5); the BIP-39 wordlist already bundled and threaded through onboarding as the `wordslist` prop.
- Produces:
  - `redactMessage(message: string, wordlist: readonly string[]): string | null` — `null` means "drop the message entirely"
  - `initCrashReporting(): void`
  - `captureCrash(error: unknown): void`

- [ ] **Step 1: Write the failing redactor test**

```typescript
// src/lib/telemetry/redact.test.ts
import { redactMessage } from './redact';

const wordlist = ['abandon', 'ability', 'zoo'];

describe('redactMessage', () => {
  it('drops a message containing any BIP-39 word', () => {
    expect(redactMessage('invalid mnemonic word: abandon', wordlist)).toBeNull();
  });

  it('drops on a wordlist match regardless of case', () => {
    expect(redactMessage('Bad word ABILITY at index 3', wordlist)).toBeNull();
  });

  it('matches only whole words', () => {
    // "abandonment" is not a seed word; the message should survive.
    expect(redactMessage('abandonment of the request', wordlist)).not.toBeNull();
  });

  it('redacts a Miden bech32 address', () => {
    const out = redactMessage('cannot reach mtst1qqqqqqabcdefghij', wordlist);
    expect(out).not.toContain('mtst1qqqqqqabcdefghij');
    expect(out).toContain('[redacted]');
  });

  it('redacts a long hex run', () => {
    const out = redactMessage('note 0x4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c failed', wordlist);
    expect(out).not.toContain('4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c');
  });

  it('redacts digit sequences that could be amounts', () => {
    const out = redactMessage('insufficient balance 4200000000', wordlist);
    expect(out).not.toContain('4200000000');
  });

  it('leaves an innocuous message intact', () => {
    expect(redactMessage('rpc endpoint returned status', wordlist)).toBe('rpc endpoint returned status');
  });

  it('drops a message that is entirely redacted away', () => {
    expect(redactMessage('mtst1qqqqqqabcdefghij', wordlist)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/redact.test.ts`
Expected: FAIL — cannot resolve `./redact`.

- [ ] **Step 3: Write the redactor**

```typescript
// src/lib/telemetry/redact.ts
/**
 * Scrub an exception message before it can reach a crash report.
 *
 * An exception message is free text written by whoever threw it, which in this
 * codebase plausibly includes an address, an amount, or — worst case — a seed
 * word from a mnemonic validation error. So messages are never sent verbatim.
 *
 * The wordlist check is the important one: it is exhaustive against the single
 * worst leak rather than heuristic, because the BIP-39 wordlist is a closed set
 * that is already bundled.
 */
const REDACTED = '[redacted]';

/** Miden bech32-style address forms. */
const ADDRESS_PATTERN = /\b(?:mtst|mdev|mm)1[0-9a-z]{6,}\b/gi;
/** Hex runs long enough to be an id, commitment, or key. */
const HEX_PATTERN = /\b(?:0x)?[0-9a-f]{16,}\b/gi;
/** Digit runs long enough to be an amount or balance. */
const DIGITS_PATTERN = /\b\d{4,}\b/g;

export function redactMessage(message: string, wordlist: readonly string[]): string | null {
  const words = new Set(wordlist.map(word => word.toLowerCase()));
  // Whole-word match only: "abandonment" must not trip on "abandon".
  const tokens = message.toLowerCase().match(/[a-z]+/g) ?? [];
  if (tokens.some(token => words.has(token))) return null;

  const redacted = message
    .replace(ADDRESS_PATTERN, REDACTED)
    .replace(HEX_PATTERN, REDACTED)
    .replace(DIGITS_PATTERN, REDACTED);

  // Nothing of substance survived — send class and stack only.
  const withoutMarkers = redacted.split(REDACTED).join('').trim();
  return withoutMarkers.length === 0 ? null : redacted;
}
```

- [ ] **Step 4: Run the redactor test**

Run: `yarn test src/lib/telemetry/redact.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing crash-reporting test**

```typescript
// src/lib/telemetry/crash.test.ts
jest.mock('lib/settings/helpers', () => ({ isTelemetryEnabledAsync: jest.fn() }));

const captureEvent = jest.fn();
jest.mock('@sentry/browser', () => ({
  BrowserClient: jest.fn(() => ({ init: jest.fn(), captureEvent })),
  Scope: jest.fn(() => ({ setClient: jest.fn(), captureException: captureEvent })),
  makeFetchTransport: jest.fn(),
  defaultStackParser: jest.fn(),
  getDefaultIntegrations: jest.fn(() => [
    { name: 'BrowserApiErrors' },
    { name: 'Breadcrumbs' },
    { name: 'GlobalHandlers' },
    { name: 'Dedupe' }
  ])
}));

import { getDefaultIntegrations } from '@sentry/browser';
import { isTelemetryEnabledAsync } from 'lib/settings/helpers';
import { captureCrash, initCrashReporting, __selectIntegrationsForTest } from './crash';

describe('crash reporting', () => {
  afterEach(() => jest.resetAllMocks());

  it('excludes every global-state integration', () => {
    const names = __selectIntegrationsForTest(jest.mocked(getDefaultIntegrations)()).map(i => i.name);
    expect(names).not.toContain('BrowserApiErrors');
    expect(names).not.toContain('Breadcrumbs');
    expect(names).not.toContain('GlobalHandlers');
    expect(names).toContain('Dedupe');
  });

  it('sends nothing when consent is off', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(false);
    initCrashReporting();
    captureCrash(new Error('boom'));
    await Promise.resolve();
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('drops a message containing a seed word but keeps the class', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    initCrashReporting();
    captureCrash(new Error('invalid mnemonic word: abandon'));
    await Promise.resolve();
    const sent = JSON.stringify(captureEvent.mock.calls);
    expect(sent).not.toContain('abandon');
    expect(sent).toContain('Error');
  });

  it('redacts an address from the message', async () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    initCrashReporting();
    captureCrash(new Error('cannot reach mtst1qqqqqqabcdefghij'));
    await Promise.resolve();
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('mtst1qqqqqqabcdefghij');
  });

  it('never throws when Sentry is unavailable', () => {
    jest.mocked(isTelemetryEnabledAsync).mockResolvedValue(true);
    expect(() => captureCrash(new Error('boom'))).not.toThrow();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/crash.test.ts`
Expected: FAIL — cannot resolve `./crash`.

- [ ] **Step 7: Install Sentry with granular imports**

```bash
yarn add @sentry/browser
```

**Critical:** import only named bindings. A namespace import (`import * as Sentry from '@sentry/browser'`) has gotten an extension **rejected from the Chrome Web Store** under MV3's remote-code rule; granular named imports resolved it. This is a build requirement, not a style preference.

- [ ] **Step 8: Write the crash module**

```typescript
// src/lib/telemetry/crash.ts
import {
  BrowserClient,
  defaultStackParser,
  getDefaultIntegrations,
  makeFetchTransport,
  Scope
} from '@sentry/browser';

import { isTelemetryEnabledAsync } from 'lib/settings/helpers';

import { redactMessage } from './redact';
import { resolveTelemetryContext } from './context';

/**
 * Crash reporting.
 *
 * `Sentry.init()` is deliberately NOT used: in a browser extension it pollutes
 * global state shared with host pages, so events can cross between the
 * extension and a site's own Sentry project. A hand-built client and scope
 * avoids that.
 *
 * The excluded integrations are doing privacy work as well as avoiding global
 * state. `Breadcrumbs` auto-captures console output, fetch URLs, and DOM click
 * targets; the tracing integrations auto-instrument fetch and history and would
 * capture full URLs. All of that is on the never-send list. The cost is that
 * `GlobalHandlers` is gone too, so `window.onerror` and `unhandledrejection`
 * are wired explicitly below.
 */
const GLOBAL_STATE_INTEGRATIONS = ['BrowserApiErrors', 'Breadcrumbs', 'GlobalHandlers'];

interface NamedIntegration {
  name: string;
}

/** @internal exported for the integration-exclusion test. */
export function __selectIntegrationsForTest<T extends NamedIntegration>(integrations: T[]): T[] {
  return integrations.filter(integration => !GLOBAL_STATE_INTEGRATIONS.includes(integration.name));
}

let scope: Scope | null = null;

export function initCrashReporting(): void {
  try {
    const client = new BrowserClient({
      dsn: process.env.SENTRY_DSN ?? '',
      transport: makeFetchTransport,
      stackParser: defaultStackParser,
      integrations: __selectIntegrationsForTest(getDefaultIntegrations({})),
      sendDefaultPii: false,
      release: resolveTelemetryContext().appVersion
    });
    scope = new Scope();
    scope.setClient(client);
    client.init();

    // GlobalHandlers is excluded, so wire these explicitly.
    globalThis.addEventListener('error', event => captureCrash(event.error));
    globalThis.addEventListener('unhandledrejection', event => captureCrash(event.reason));
  } catch {
    // Crash reporting must never prevent the app from starting.
  }
}

export function captureCrash(error: unknown): void {
  void (async () => {
    try {
      if (!(await isTelemetryEnabledAsync())) return;
      if (scope === null) return;
      if (!(error instanceof Error)) return;

      const wordlist = await loadBip39Wordlist();
      const safeMessage = redactMessage(error.message, wordlist);

      // Rebuild the error rather than mutating the caught one, so the message
      // the app shows the user is untouched.
      const reportable = new Error(safeMessage ?? '');
      reportable.name = error.name;
      reportable.stack = error.stack;

      scope.captureException(reportable);
    } catch {
      // Best-effort.
    }
  })();
}
```

Wire `loadBip39Wordlist` to the same wordlist source that already feeds the `wordslist` prop into `OnboardingFlow`; locate it with `rg -n "wordslist" src --glob '!*.test.*'` and import from there rather than adding a second copy.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `yarn test src/lib/telemetry/crash.test.ts src/lib/telemetry/redact.test.ts`
Expected: PASS, 5 + 8 tests.

- [ ] **Step 10: Hook the error boundary**

In `src/app/ErrorBoundary.tsx`, call `captureCrash(error)` from `componentDidCatch`. Do not change what the boundary renders.

- [ ] **Step 11: Verify the bundle has no namespace import**

```bash
rg -n "import \* as Sentry|from '@sentry" src
```
Expected: only granular named imports from `@sentry/browser` in `src/lib/telemetry/crash.ts`. A namespace import here is a store-rejection risk.

- [ ] **Step 12: Commit**

```bash
git add src/lib/telemetry/redact.ts src/lib/telemetry/redact.test.ts src/lib/telemetry/crash.ts src/lib/telemetry/crash.test.ts src/app/ErrorBoundary.tsx package.json yarn.lock
git commit -m "feat(telemetry): add consent-gated crash reporting with message redaction"
```

---

### Task 10: Consent UI and the logger removal

**Files:**
- Modify: `src/app/templates/GeneralSettings.tsx` (add the toggle)
- Modify: `src/app/templates/GeneralSettings.selectors.ts` (add the test id)
- Modify: `src/screens/onboarding/types.ts` + `src/screens/onboarding/navigator.tsx` (add the optional first-launch step)
- Create: `src/screens/onboarding/common/HelpImproveWallet.tsx`
- Modify: `public/_locales/en/en.json` (new keys)
- Modify: `src/shared/logger.ts` (remove the server path)
- Delete: `src/shared/logger.test.ts` assertions covering the removed path
- Modify: `src/app/App.tsx` (call `clearLegacyAnalyticsStorage` and `initCrashReporting` at startup)
- Test: `src/app/templates/GeneralSettings.test.tsx`, `src/screens/onboarding/common/HelpImproveWallet.test.tsx`

**Interfaces:**
- Consumes: `setTelemetrySetting`, `isTelemetryEnabled`, `hasTelemetryChoice` (Task 2); `dropQueue` (Task 4); `clearLegacyAnalyticsStorage` (Task 1); `initCrashReporting` (Task 9).
- Produces: `OnboardingStep.HelpImproveWallet` and a `help-improve-wallet` `OnboardingAction` id.

- [ ] **Step 1: Write the failing settings test**

```typescript
// append to src/app/templates/GeneralSettings.test.tsx
jest.mock('lib/telemetry/sink', () => ({ dropQueue: jest.fn() }));
import { dropQueue } from 'lib/telemetry/sink';
import { isTelemetryEnabled } from 'lib/settings/helpers';

describe('GeneralSettings telemetry toggle', () => {
  afterEach(() => {
    localStorage.clear();
    jest.resetAllMocks();
  });

  it('renders the toggle off on a fresh install', () => {
    renderGeneralSettings();
    expect(screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle)).not.toBeChecked();
  });

  it('turns telemetry on when toggled', async () => {
    renderGeneralSettings();
    await userEvent.click(screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle));
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('drops the queue when toggled off', async () => {
    setTelemetrySetting(true);
    renderGeneralSettings();
    await userEvent.click(screen.getByTestId(GeneralSettingsSelectors.TelemetryToggle));
    expect(isTelemetryEnabled()).toBe(false);
    expect(jest.mocked(dropQueue)).toHaveBeenCalledTimes(1);
  });

  it('labels the toggle with a localized string', () => {
    renderGeneralSettings();
    expect(screen.getByText('Help improve Wallet')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/app/templates/GeneralSettings.test.tsx`
Expected: FAIL — the toggle does not exist.

- [ ] **Step 3: Add the i18n keys**

In `public/_locales/en/en.json` (flat keys):

```json
  "helpImproveWallet": "Help improve Wallet",
  "helpImproveWalletDescription": "Share anonymous data about which parts of Wallet you use and any crashes, so we can fix what's broken. Never your keys, balances, addresses, amounts, or transactions. You can change this any time.",
  "helpImproveWalletAccept": "Share anonymous data",
  "helpImproveWalletDecline": "Not now",
```

- [ ] **Step 4: Add the toggle**

Add `TelemetryToggle: 'telemetry-toggle'` to `src/app/templates/GeneralSettings.selectors.ts`, then a `SettingToggle` in `GeneralSettings.tsx` following the haptics and delegate-proof rows exactly:

```typescript
const [telemetryEnabled, setTelemetryEnabled] = useState(() => isTelemetryEnabled());
const handleTelemetryChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
  const nextEnabled = evt.target.checked;
  setTelemetrySetting(nextEnabled);
  setTelemetryEnabled(nextEnabled);
  // Off must stop sharing that is already queued, not just future events.
  if (!nextEnabled) dropQueue();
}, []);
```

```tsx
      <SettingToggle
        checked={telemetryEnabled}
        onChange={handleTelemetryChange}
        name="telemetryEnabled"
        testID={GeneralSettingsSelectors.TelemetryToggle}
        title={t('helpImproveWallet')}
        description={t('helpImproveWalletDescription')}
      />
```

- [ ] **Step 5: Run the settings test**

Run: `yarn test src/app/templates/GeneralSettings.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the failing onboarding-step test**

```typescript
// src/screens/onboarding/common/HelpImproveWallet.test.tsx
import { HelpImproveWalletScreen } from './HelpImproveWallet';
import { isTelemetryEnabled, hasTelemetryChoice } from 'lib/settings/helpers';

describe('HelpImproveWalletScreen', () => {
  afterEach(() => localStorage.clear());

  it('is skippable and records the refusal', async () => {
    const onSubmit = jest.fn();
    render(<HelpImproveWalletScreen onSubmit={onSubmit} />);
    await userEvent.click(screen.getByText('Not now'));
    expect(isTelemetryEnabled()).toBe(false);
    expect(hasTelemetryChoice()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('records acceptance', async () => {
    const onSubmit = jest.fn();
    render(<HelpImproveWalletScreen onSubmit={onSubmit} />);
    await userEvent.click(screen.getByText('Share anonymous data'));
    expect(isTelemetryEnabled()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('states that keys and balances are never sent', () => {
    render(<HelpImproveWalletScreen onSubmit={jest.fn()} />);
    expect(screen.getByText(/never your keys/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `yarn test src/screens/onboarding/common/HelpImproveWallet.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 8: Build the onboarding step**

Create `src/screens/onboarding/common/HelpImproveWallet.tsx` following the structure of a sibling such as `ChooseProtection.tsx` — reuse existing wallet components and semantic theme tokens, add `hapticLight()` to the buttons, and route all copy through `t()`. Read `skills/miden-wallet-frontend/SKILL.md` before writing the UI, as `AGENTS.md` requires. Both buttons call `setTelemetrySetting` (with `true` / `false`) and then `onSubmit`, so a skip is still a recorded choice and the prompt does not reappear.

Add `HelpImproveWallet` to `OnboardingStep` in `src/screens/onboarding/types.ts`, a `help-improve-wallet` action id, and a `case OnboardingStep.HelpImproveWallet:` to the `renderStep` switch in `src/screens/onboarding/navigator.tsx`. Leave it out of `STEP_TO_PROGRESS` so it does not renumber the progress indicator.

- [ ] **Step 9: Strip the logger's server path**

In `src/shared/logger.ts`, delete `sendLog`, `sendLogToServer`, `censorKeys`, and the `ILog` interface, leaving `info` / `warning` / `error` as console-only wrappers. That path carried an inverted consent check (`!analyticsJson.enabled === true`, which returns early when consent *is* granted) and an `APrivateKey` / `AViewKey` scrubber matching Aleo formats that do not exist in Miden. Remove the corresponding assertions from `src/shared/logger.test.ts`.

- [ ] **Step 10: Wire startup**

In `src/app/App.tsx`, call `clearLegacyAnalyticsStorage()` and `initCrashReporting()` once on mount.

- [ ] **Step 11: Run everything**

Run: `yarn test && yarn ts && yarn lint && yarn lint:i18n`
Expected: PASS. `lint:i18n` must be clean — every string above goes through `t()`.

- [ ] **Step 12: Commit**

```bash
git add src/app src/screens/onboarding src/shared/logger.ts src/shared/logger.test.ts public/_locales/en/en.json
git commit -m "feat(telemetry): add the consent prompt and settings toggle, drop the logger server path"
```

---

### Task 11: Anti-leak egress test

The requirement that tests stop forbidden data from being sent. This asserts at the boundary, so call sites added later are covered without touching this test.

**Files:**
- Create: `playwright/tests/telemetry-egress.spec.ts`
- Create: `src/lib/telemetry/egress-guard.test.ts`

**Interfaces:**
- Consumes: `WIRE_KEYS` (Task 3); the `MIDEN_E2E_TEST` harness (`window.__TEST_STORE__`, `window.__TEST_INTERCOM__`).
- Produces: no exports.

- [ ] **Step 1: Write the encoding-variant helper test**

A substring check that misses base64 is theater, so the variant generator gets its own test.

```typescript
// src/lib/telemetry/egress-guard.test.ts
import { encodingVariantsOf } from './egress-guard';

describe('encodingVariantsOf', () => {
  it('includes the raw value', () => {
    expect(encodingVariantsOf('mtst1abc')).toContain('mtst1abc');
  });

  it('includes upper and lower case', () => {
    const variants = encodingVariantsOf('MtSt1Abc');
    expect(variants).toContain('mtst1abc');
    expect(variants).toContain('MTST1ABC');
  });

  it('includes base64', () => {
    expect(encodingVariantsOf('mtst1abc')).toContain(btoa('mtst1abc'));
  });

  it('includes hex', () => {
    const variants = encodingVariantsOf('ab');
    expect(variants).toContain('6162');
  });

  it('includes URI encoding', () => {
    expect(encodingVariantsOf('a b')).toContain('a%20b');
  });

  it('includes JSON escaping', () => {
    expect(encodingVariantsOf('a"b')).toContain('a\\"b');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/egress-guard.test.ts`
Expected: FAIL — cannot resolve `./egress-guard`.

- [ ] **Step 3: Write the variant generator**

```typescript
// src/lib/telemetry/egress-guard.ts
/**
 * Every encoding a poison value could wear on the wire.
 *
 * A naive `body.includes(address)` check passes while leaking, because a
 * payload may carry the value base64-encoded, hex-encoded, or JSON-escaped. The
 * egress test asserts against all of these.
 */
export function encodingVariantsOf(value: string): string[] {
  const variants = new Set<string>([
    value,
    value.toLowerCase(),
    value.toUpperCase(),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1)
  ]);

  try {
    variants.add(btoa(value));
  } catch {
    // Non-latin1 input cannot be base64'd this way; the other variants cover it.
  }

  let hex = '';
  for (let i = 0; i < value.length; i++) {
    hex += value.charCodeAt(i).toString(16).padStart(2, '0');
  }
  variants.add(hex);

  return [...variants];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/telemetry/egress-guard.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the Playwright egress spec**

```typescript
// playwright/tests/telemetry-egress.spec.ts
import { expect, test } from '@playwright/test';

import { encodingVariantsOf } from '../../src/lib/telemetry/egress-guard';

/**
 * Poison values seeded into the wallet. If any of these — in any encoding —
 * appears in a telemetry request body, the test fails.
 */
const POISON = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  address: 'mtst1qqqqqqzzzztestaddress',
  amount: '4242424242',
  noteId: '0x9f8e7d6c5b4a39281706f5e4d3c2b1a0'
};

const TELEMETRY_HOSTS = ['aptabase', 'sentry'];

test.describe('telemetry egress', () => {
  test('no forbidden value leaves the app in any encoding', async ({ page, context }) => {
    const bodies: string[] = [];

    // Capture RAW bodies. Sentry sends newline-delimited envelopes rather than
    // one JSON object, so a test that JSON.parse()s the body silently stops
    // checking the part that carries the stack.
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (TELEMETRY_HOSTS.some(host => url.includes(host))) {
        bodies.push(route.request().postData() ?? '');
        await route.fulfill({ status: 200, body: '{}' });
        return;
      }
      await route.continue();
    });

    await seedWalletWithPoison(page, POISON);
    await enableTelemetry(page);
    await driveEveryInstrumentedFlow(page, POISON);

    expect(bodies.length).toBeGreaterThan(0); // guard against a vacuous pass

    const haystack = bodies.join('\n');
    for (const value of Object.values(POISON)) {
      for (const variant of encodingVariantsOf(value)) {
        expect(haystack, `leaked ${value} as ${variant}`).not.toContain(variant);
      }
    }
  });

  test('only allowlisted keys appear on the wire', async ({ page, context }) => {
    const keys = new Set<string>();
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url.includes('aptabase')) {
        for (const key of Object.keys(JSON.parse(route.request().postData() ?? '{}'))) keys.add(key);
        await route.fulfill({ status: 200, body: '{}' });
        return;
      }
      await route.continue();
    });

    await enableTelemetry(page);
    await driveEveryInstrumentedFlow(page, POISON);

    for (const key of keys) {
      expect(
        ['phase', 'flow', 'flowId', 'result', 'errorKind', 'durationMs', 'appVersion', 'platform']
      ).toContain(key);
    }
  });

  test('nothing is sent before consent is granted', async ({ page, context }) => {
    const requests: string[] = [];
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (TELEMETRY_HOSTS.some(host => url.includes(host))) requests.push(url);
      await route.continue();
    });

    await driveEveryInstrumentedFlow(page, POISON); // consent never granted
    expect(requests).toEqual([]);
  });

  test('telemetry contacts no host outside the allowlist', async ({ page, context }) => {
    const contacted: string[] = [];
    await context.route('**/*', async route => {
      contacted.push(new URL(route.request().url()).host);
      await route.continue();
    });

    await enableTelemetry(page);
    await driveEveryInstrumentedFlow(page, POISON);

    const unexpected = contacted.filter(
      host => host.includes('analytics') || host.includes('telemetry') || host.includes('segment')
    );
    expect(unexpected).toEqual([]);
  });
});
```

Implement `seedWalletWithPoison`, `enableTelemetry`, and `driveEveryInstrumentedFlow` as helpers using the patterns already in `playwright/tests/`. `driveEveryInstrumentedFlow` must exercise the success, cancellation, and error path of all eleven flows in `TelemetryFlow` — including cancelling mid-flow, since an abandoned flow is a distinct code path.

- [ ] **Step 6: Register the spec and run it**

Add the spec to the basic extension suite config so it runs in `yarn test:e2e`.

Run: `yarn test:e2e --grep "telemetry egress"`
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify the guard can fail**

A guard that cannot fail is worthless. Temporarily add `noteId: POISON.noteId` to the payload built in `src/lib/telemetry/serialize.ts` (it will not typecheck — use a temporary local widening, and do not commit it). Re-run the spec, confirm it FAILS naming the leaked value, then revert.

Run: `yarn test:e2e --grep "telemetry egress" && git diff --exit-code src/lib/telemetry/serialize.ts`
Expected: FAIL while the leak is present; after reverting, PASS and a clean diff.

- [ ] **Step 8: Commit**

```bash
git add playwright/tests/telemetry-egress.spec.ts src/lib/telemetry/egress-guard.ts src/lib/telemetry/egress-guard.test.ts playwright.e2e.config.ts
git commit -m "test(telemetry): assert forbidden data cannot leave at the egress boundary"
```

---

### Task 12: Standing guarantees — ATT, dependencies, and no stray egress

**Files:**
- Create: `src/lib/telemetry/guarantees.test.ts`

**Interfaces:**
- Consumes: the repository tree.
- Produces: no exports — standing assertions.

- [ ] **Step 1: Write the tests**

```typescript
// src/lib/telemetry/guarantees.test.ts
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

const grep = (pattern: string, paths: string): string => {
  try {
    return execSync(`rg -n --no-messages "${pattern}" ${paths}`, { cwd: repoRoot }).toString();
  } catch {
    return ''; // rg exits non-zero on no matches
  }
};

describe('no App Tracking Transparency', () => {
  it.each([
    'AppTrackingTransparency',
    'NSUserTrackingUsageDescription',
    'ATTrackingManager',
    'advertisingIdentifier'
  ])('does not reference %s anywhere', token => {
    expect(grep(token, 'ios android src')).toBe('');
  });
});

describe('the SDK high-fidelity channel is never enabled', () => {
  it('does not mention observeSensitive in wallet source', () => {
    expect(grep('observeSensitive', 'src')).toBe('');
  });
});

describe('no vendor binding package is installed', () => {
  it('declares no @miden-sdk/telemetry-* dependency', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter(name => name.startsWith('@miden-sdk/telemetry-'))).toEqual([]);
  });

  it('declares no customer-data-platform dependency', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter(name => name.startsWith('@segment/'))).toEqual([]);
  });
});

describe('telemetry has exactly one egress point', () => {
  it('is the only telemetry module that calls fetch', () => {
    const hits = grep('fetch\\(', 'src/lib/telemetry')
      .split('\n')
      .filter(line => line.length > 0 && !line.includes('.test.'));
    for (const hit of hits) {
      expect(hit).toContain('src/lib/telemetry/sink.ts');
    }
  });

  it('has no telemetry fetch outside the telemetry module', () => {
    expect(grep('TELEMETRY_INGEST_URL', 'src')).toContain('src/lib/telemetry/sink.ts');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `yarn test src/lib/telemetry/guarantees.test.ts`
Expected: PASS. These lock in the current state rather than fixing violations.

- [ ] **Step 3: Verify each guard can fail**

Confirm all three families actually catch a violation, reverting after each:

1. Add `NSUserTrackingUsageDescription` to `ios/App/App/Info.plist` → the ATT test must FAIL. Revert.
2. Add `observeSensitive: false` to any file in `src/` → the SDK test must FAIL (the assertion is that the name is absent, not that the value is false). Revert.
3. Add a `fetch('https://example.com')` call to `src/lib/telemetry/context.ts` → the egress test must FAIL. Revert.

Run after each revert: `git diff --exit-code`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/telemetry/guarantees.test.ts
git commit -m "test(telemetry): lock in the ATT, dependency, and single-egress guarantees"
```

---

### Task 13: Bind the SDK observer

**Requires the published SDK version from `2026-08-20-web-sdk-observability.md`.** Everything before this task is independent of it.

**Files:**
- Modify: `package.json` (bump `@miden-sdk/miden-sdk` and `@miden-sdk/react`)
- Create: `src/lib/telemetry/sdk-observer.ts`
- Test: `src/lib/telemetry/sdk-observer.test.ts`
- Modify: `src/lib/miden/sdk/prove-telemetry.ts` (become a consumer)
- Modify: `src/lib/miden/sdk/miden-client-interface.ts` (pass the observer at construction)

**Interfaces:**
- Consumes: `ClientOptions.observer` and `MidenObservation` from the published SDK; `beginFlow`-adjacent reporting from Task 6; `classifyError` (Task 6).
- Produces: `createWalletSdkObserver(): (observation: MidenObservation) => void`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/telemetry/sdk-observer.test.ts
jest.mock('lib/miden/front', () => ({ request: jest.fn().mockResolvedValue(undefined) }));
import { createWalletSdkObserver } from './sdk-observer';
import { recordProveTelemetry, __resetProveTelemetryForTest } from 'lib/miden/sdk/prove-telemetry';

describe('createWalletSdkObserver', () => {
  afterEach(() => __resetProveTelemetryForTest());

  it('records a prove observation into the prove ring', () => {
    createWalletSdkObserver()({ op: 'proveTransaction', outcome: 'ok', durationMs: 21_000 });
    expect(getProveTelemetry()).toHaveLength(1);
  });

  it('ignores an observation it has no mapping for', () => {
    expect(() =>
      createWalletSdkObserver()({ op: 'getAccount', outcome: 'ok', durationMs: 1 })
    ).not.toThrow();
  });

  it('never reads the sensitive field even when present', () => {
    const observer = createWalletSdkObserver();
    const observation = { op: 'proveTransaction', outcome: 'error' as const, durationMs: 1 };
    Object.defineProperty(observation, 'sensitive', {
      get() {
        throw new Error('wallet must never read observation.sensitive');
      }
    });
    expect(() => observer(observation)).not.toThrow();
  });

  it('never throws when downstream recording fails', () => {
    expect(() =>
      createWalletSdkObserver()({ op: 'proveTransaction', outcome: 'error', durationMs: -1 })
    ).not.toThrow();
  });
});
```

The third test is the important one: a getter that throws proves by construction that the wallet's observer never touches the high-fidelity field.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test src/lib/telemetry/sdk-observer.test.ts`
Expected: FAIL — cannot resolve `./sdk-observer`.

- [ ] **Step 3: Bump the SDK**

```bash
yarn add @miden-sdk/miden-sdk@<published-version> @miden-sdk/react@<published-version>
```

Then re-verify the dedupe pinning, because a version bump is exactly what breaks it. Per the duplicate-dexie gotcha in `AGENTS.md`, two inlined dexies trip dexie's global guard: the service worker fails to register and mobile and desktop crash. Confirm every app vite config still sets `resolve.dedupe: ['dexie', '@miden-sdk/miden-sdk']` and that `package.json` still pins `dexie` to the web-sdk's inlined version.

```bash
rm -rf dist/chrome_unpacked && yarn build:chrome
rg -o "DEXIE_VERSION[^,]*" dist/chrome_unpacked/**/*.js.map | sort -u
```
Expected: exactly one dexie version. A plain `grep -r` over `node_modules` misses this — you must parse the built source map.

- [ ] **Step 4: Write the observer**

```typescript
// src/lib/telemetry/sdk-observer.ts
import { isMobile } from 'lib/platform';
import { recordProveTelemetry } from 'lib/miden/sdk/prove-telemetry';

/**
 * The wallet's binding for the SDK observation sink.
 *
 * Reads ONLY the safe fields. `observation.sensitive` is never destructured,
 * never read, and never forwarded — and because the wallet never passes
 * `observeSensitive` at client construction, it is absent from the object
 * entirely. Two independent reasons the high-fidelity channel cannot leak
 * through here, either of which would suffice.
 */
interface SafeObservationFields {
  op: string;
  outcome: 'ok' | 'error';
  durationMs: number;
}

export function createWalletSdkObserver(): (observation: SafeObservationFields) => void {
  return observation => {
    try {
      // Destructure explicitly rather than passing the object along, so a
      // field added to the SDK's observation type can never ride through
      // untouched.
      const { op, outcome, durationMs } = observation;

      if (op === 'proveTransaction') {
        recordProveTelemetry({
          path: isMobile() ? 'native-mobile' : 'local',
          durationMs,
          fellBack: false,
          ...(outcome === 'error' ? { failed: true } : {})
        });
      }
    } catch {
      // An observer must never fail a client operation.
    }
  };
}
```

- [ ] **Step 5: Register it at client construction**

In `src/lib/miden/sdk/miden-client-interface.ts`, pass `observer: createWalletSdkObserver()` in the `ClientOptions` used to create the client. **Do not pass `observeSensitive`** — its absence is asserted by Task 12.

- [ ] **Step 6: Run the tests**

Run: `yarn test src/lib/telemetry/ && yarn test src/lib/miden/sdk/ && yarn ts`
Expected: PASS, including the existing `prove-telemetry.test.ts`.

- [ ] **Step 7: Re-run the standing guarantees and the egress test**

Run: `yarn test src/lib/telemetry/guarantees.test.ts && yarn test:e2e --grep "telemetry egress"`
Expected: PASS. The `observeSensitive` assertion must still hold after the SDK bump.

- [ ] **Step 8: Commit**

```bash
git add package.json yarn.lock src/lib/telemetry/sdk-observer.ts src/lib/telemetry/sdk-observer.test.ts src/lib/miden/sdk/miden-client-interface.ts src/lib/miden/sdk/prove-telemetry.ts
git commit -m "feat(telemetry): bind the SDK observation sink without the sensitive channel"
```

---

### Task 14: Disclosures

Shipping the code without this makes the published privacy policy false, so it is part of the work rather than a follow-up.

**Files:**
- Modify: `docs/privacy/index.md`
- Modify: `STORE_LISTING.md` (line 213 Data Safety answer; flag line 47 for Product)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the field list from Task 3; the retention decision from the spec.
- Produces: no code.

- [ ] **Step 1: Rewrite the privacy policy's data section**

`docs/privacy/index.md` is served by GitHub Pages at `https://0xmiden.github.io/wallet/privacy/` — the URL submitted to every store, so it is the live document for all surfaces. It currently opens with "**None.**" and claims "no analytics SDKs, no crash reporters, and no advertising identifiers", which this release makes false.

Replace the "Data we collect" section with one that states: the setting is optional and **off by default**; where to turn it off (Settings → General → Help improve Wallet); the exact fields sent, named individually — flow name, result, duration, app version, platform, broad error category, and an ephemeral per-flow identifier; the never-send list verbatim from the requirements; that there is no advertising identifier, no ATT prompt, and no cross-app or cross-site tracking; the two processors and their EU regions; the 90-day retention window; and this, stated plainly:

> Because we attach no persistent identifier to this data, we cannot tell which records came from which person — including when you ask us. That means we cannot delete "your" telemetry on request, because there is no way to find it. It also means it cannot be traced back to you or your wallet.

Update `Last updated` to the release date.

- [ ] **Step 2: Update the Play Data Safety answers**

In `STORE_LISTING.md`, line 213 currently reads:

> **App info and performance — Crash logs / Diagnostics:** None collected (no crash reporter).

Replace it with an accurate declaration: crash logs and diagnostics are collected **optionally** (off by default), **not linked to the user**, not shared with third parties for advertising, and **not used for tracking**. Answer the data-deletion question consistently with the no-identifier design — the data is not linked to a user, so per-user deletion does not apply.

- [ ] **Step 3: Flag the marketing claim**

`STORE_LISTING.md` line 47 reads "No tracking or analytics that compromise your privacy." Do not silently rewrite it. Add a `<!-- REVIEW: -->` comment noting that this release adds optional, off-by-default, non-identifying analytics, and that Product must confirm the claim still stands. It is arguably still true under this design, but it should be a decision rather than a sentence that survives unread.

- [ ] **Step 4: Record the App Store and Chrome Web Store actions**

These live outside the repo, so capture them where the release checklist can find them. Add to the PR description:

- **Apple App Store:** declare Diagnostics and Usage Data, mapped to App Functionality and Analytics, marked *not linked to identity* and *not used for tracking*. Required even though collection is optional, because the questionnaire asks what the app *can* collect. No ATT prompt.
- **Chrome Web Store:** update the data-use disclosure and the certification checkboxes covering not selling data and not using it for purposes unrelated to core functionality.

- [ ] **Step 5: Add the changelog entry**

One entry for the whole task, per `AGENTS.md`. Before writing it, check the latest published release and use a strictly-higher `(TBD)` section — do not trust the file header:

```bash
gh api repos/0xMiden/wallet/releases/latest --jq .tag_name
```

- [ ] **Step 6: Verify**

Run: `yarn lint:i18n && yarn test && yarn ts`
Expected: PASS. Also re-read `docs/privacy/index.md` against the `WIRE_KEYS` list in `src/lib/telemetry/serialize.ts` and confirm the documented fields and the shipped fields match exactly — a policy that overstates or understates is the failure mode here.

- [ ] **Step 7: Commit**

```bash
git add docs/privacy/index.md STORE_LISTING.md CHANGELOG.md
git commit -m "docs(telemetry): disclose optional telemetry in the privacy policy and store listings"
```

- [ ] **Step 8: Open the PR**

Include the `Web SDK PR: #N` marker on its own line, using the number from the SDK plan's Task 8. Prose mentions do not trigger the linked-PR CI pipeline. Cover user impact, the testing performed, the platform-specific effects, and the App Store and Chrome Web Store actions from Step 4.

---

## Self-Review

**Spec coverage.** Walking the spec section by section: the trust boundary and single egress point are Tasks 4-5; the wire type is Task 3; the two-events-per-flow lifecycle and ephemeral flow ID are Task 6; instrumented flows are Tasks 7-8; consent storage is Task 2 and its UI is Task 10; crash reporting including the BIP-39 check and the Sentry recipe is Task 9; the `logger.ts` replacement is Task 10 Step 9; the SDK binding and dedupe re-verification are Task 13; the anti-leak suite is Tasks 11-12; retention and disclosures are Task 14. Scaffold deletion, the legacy identifier, and the Segment removal are Task 1.

**Deliberate omissions, matching the spec's non-goals.** Beta-feature flows (Guardian, local proving, swaps, connected-app requests, on/off-ramp) and the user-initiated diagnostic report are follow-on specs. macOS/Tauri is out of scope, which is why `TelemetryPlatform` has three members rather than four.

**One item the spec names that no task fully owns.** Vendor-side configuration — the 90-day retention window, disabling IP storage on the Sentry project, and turning off raw export and third-party forwarding — cannot be done from this repo. Task 14 documents the retention window in the privacy policy, but the settings themselves are console work. They are listed in the spec's "Retention and deletion" section and must be verified by whoever provisions the accounts; flagged here rather than left implicit, since a policy claiming 90 days against a vendor defaulting to longer is worse than no claim.

**Type consistency.** `TelemetryFlow`, `TelemetryResult`, `TelemetryErrorKind`, `TelemetryPlatform`, `TelemetryEvent`, `TelemetryContext`, and `TelemetryWirePayload` are defined once in Task 3 and used unchanged in Tasks 4, 5, 6, and 11. `FlowHandle` has exactly `complete` / `cancel` / `fail` in Task 6 and every mock in Tasks 7-8 supplies those three. `sendEvent(event, context)` keeps its two-parameter shape between Tasks 4 and 5. `WIRE_KEYS` in Task 3 is the same list asserted in Tasks 4 and 11. `isTelemetryEnabledAsync` is the consent read in Tasks 4 and 9; the synchronous `isTelemetryEnabled` is used only in UI (Task 10).

**Placeholder scan.** No TBDs. Three places instruct discovery rather than naming a path, and each supplies the command: the fund / receive / notes / activity entry points (Task 8 Step 5), the BIP-39 wordlist source (Task 9 Step 8), and the existing render helpers in `Welcome.test.tsx` and `SendManager.test.tsx` (Tasks 7-8). These are genuinely repo-state-dependent rather than unspecified, and the `rg` commands are given. Tasks 11 Step 7 and 12 Step 3 instruct a temporary edit and its revert; that is a verification procedure — a guard that cannot fail is worthless — not an incomplete step.
