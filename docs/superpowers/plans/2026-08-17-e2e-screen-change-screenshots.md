# E2E Screen-Change Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a screenshot on every wallet UI screen change during E2E tests, on all harnesses that run on `main`, uploaded as CI artifacts.

**Architecture:** The app publishes a single derived "screen key" (`route > card > overlay`) to `globalThis.__TEST_SCREEN__` whenever the UI navigates, gated on `MIDEN_E2E_TEST` (tree-shaken from prod). Chrome captures reactively via `page.exposeFunction`; iOS/Android capture via a ~250ms poll + native grab. Capture is app-driven (not tied to the `TestStepRunner`), so it uniformly covers suites like swap/earn/bridge that never call `steps.step(...)`.

**Tech Stack:** React + Zustand (app), Woozie hash router, `vaul` drawer, `react-modal`, `constate`; Playwright 1.61 (Chrome extension + iOS `simctl` + Android `adb`); Jest + RTL (unit); GitHub Actions (CI).

**Spec:** `docs/superpowers/plans/2026-08-17-e2e-screen-change-screenshots-design.md`

## Global Constraints

- **Gate everything app-side on `process.env.MIDEN_E2E_TEST === 'true'`.** Vite statically replaces this in prod → the code tree-shakes out. Model: `src/app/pages/Welcome.tsx:148-155`.
- **No `any`, no `as`** in `src/` product code. For globals use a typed intersection, matching `Welcome.tsx:202`: `(globalThis as typeof globalThis & { __TEST_SCREEN__?: ScreenState })`.
- **Publish to `globalThis`** (works in the SW realm too, per `src/lib/store/index.ts:769-771`); read as `window` in browser/CDP contexts.
- **`__TEST_SCREEN__` must never dereference the Miden WASM client.** A plain-object read is the only thing safe to poll over CDP on iOS (avoids the `useSyncTrigger` 30–60s sync-lock deadlock; see `CLAUDE.md` "Don't read WASM client from CDP").
- **Overlay part is appended**, so open AND close both change the key: `/send > SelectAmount` ↔ `/send > SelectAmount > drawer:token`.
- **`__TEST_SCREEN__` updates immediately; the Chrome push is debounced 150ms** (`SCREEN_PUSH_DEBOUNCE_MS`).
- **iOS eval: `cdp.eval('return …')` with an explicit `return`; NEVER `evalAsync`** (broken on the RWI bridge — `playwright/e2e/ios/helpers/cdp-bridge.ts:116-130`). Android: `cdp.evaluate(fn)` is fine.
- **Screenshots write under the harness `outputDir`** in a `screens/` subfolder (same tree as the existing `screenshots/`), so they ride the existing `actions/upload-artifact` steps.
- **Commit style (repo rule):** single-line, short, imperative. Never sign, never add `Co-Authored-By`. Never `git push`.

---

## File Structure

**App (product code, all `MIDEN_E2E_TEST`-gated):**
- `src/lib/e2e/screen-key.ts` *(new)* — module state (route/card/overlay stack) + `composeScreenKey` + publish (updates `__TEST_SCREEN__`, bumps seq, debounced Chrome push). The single source of truth; everything else feeds it.
- `src/app/templates/ScreenKeyPublisher.tsx` *(new)* — root component; subscribes to Woozie and feeds the `route` part.
- `src/app/App.tsx` — mount `ScreenKeyPublisher` inside `Woozie.Provider`.
- `src/components/Navigator.tsx` — one effect feeding the `card` part.
- `src/lib/ui/drawer.tsx`, `src/app/atoms/CustomModal.tsx`, `src/lib/ui/dialog.tsx` — feed the `overlay` part; add optional `screenKey` prop to Drawer/CustomModal.
- Selected drawer call sites — pass `screenKey`.

**Harness:**
- `playwright/e2e/harness/screen-capture.ts` *(new, shared)* — `screenShotName`, `captureBestEffort`, `startScreenPoll`.
- `playwright/e2e/fixtures/two-wallets.ts` — Chrome `installScreenCapture` + re-register on relaunch/reload.
- `playwright/e2e/ios/fixtures/two-simulators.ts` — iOS poll loop.
- `playwright/e2e/android/fixtures/two-emulators.ts` — Android poll loop.

**CI:** `pr-e2e-{swap,earn,guardian-lifecycle,bridge-guardian}.yml`, `e2e-resilience.yml`.

---

## Task 1: Screen-key module (foundation)

**Files:**
- Create: `src/lib/e2e/screen-key.ts`
- Test: `src/lib/e2e/screen-key.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ScreenState = { key: string; seq: number }`
  - `const SCREEN_PUSH_DEBOUNCE_MS = 150`
  - `composeScreenKey(parts: { route?: string | null; card?: string | null; overlay?: string | null }): string`
  - `setRoutePart(value: string | null): void`
  - `setCardPart(value: string | null): void`
  - `pushOverlay(id: string): void`
  - `popOverlay(id: string): void`
  - `getCurrentScreen(): ScreenState`
  - `__resetScreenKeyForTest(): void` (test-only reset of module state)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/e2e/screen-key.test.ts
import {
  composeScreenKey,
  setRoutePart,
  setCardPart,
  pushOverlay,
  popOverlay,
  getCurrentScreen,
  __resetScreenKeyForTest,
  SCREEN_PUSH_DEBOUNCE_MS,
} from './screen-key';

type PushMock = jest.Mock<void, [string, number]>;

function installPush(): PushMock {
  const fn = jest.fn() as PushMock;
  (window as typeof window & { __e2eScreenChanged?: (k: string, s: number) => void }).__e2eScreenChanged = fn;
  return fn;
}

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
  delete (window as typeof window & { __e2eScreenChanged?: unknown }).__e2eScreenChanged;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('composeScreenKey', () => {
  it('joins present parts with " > " and drops empties', () => {
    expect(composeScreenKey({ route: '/send', card: 'SelectAmount' })).toBe('/send > SelectAmount');
    expect(composeScreenKey({ route: '/send', card: null, overlay: 'drawer:token' })).toBe('/send > drawer:token');
    expect(composeScreenKey({})).toBe('');
  });
});

describe('publish', () => {
  it('bumps seq and updates __TEST_SCREEN__ immediately on a real change', () => {
    setRoutePart('/home');
    expect(getCurrentScreen()).toEqual({ key: '/home', seq: 1 });
    setCardPart('SelectAmount');
    expect(getCurrentScreen()).toEqual({ key: '/home > SelectAmount', seq: 2 });
  });

  it('does NOT bump seq when the composed key is unchanged', () => {
    setRoutePart('/home');
    setRoutePart('/home');
    expect(getCurrentScreen().seq).toBe(1);
  });

  it('overlay push then pop restores the base key (both are changes)', () => {
    setRoutePart('/send');
    pushOverlay('drawer:token');
    expect(getCurrentScreen().key).toBe('/send > drawer:token');
    popOverlay('drawer:token');
    expect(getCurrentScreen().key).toBe('/send');
    expect(getCurrentScreen().seq).toBe(3);
  });

  it('debounces the Chrome push and fires once with the latest key+seq', () => {
    const push = installPush();
    setRoutePart('/a');
    setRoutePart('/b');
    expect(push).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SCREEN_PUSH_DEBOUNCE_MS);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/b', 2);
  });

  it('is a no-op when MIDEN_E2E_TEST !== "true"', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    __resetScreenKeyForTest();
    setRoutePart('/home');
    expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/e2e/screen-key.test.ts`
Expected: FAIL — module `./screen-key` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/e2e/screen-key.ts
export type ScreenState = { key: string; seq: number };

export const SCREEN_PUSH_DEBOUNCE_MS = 150;

type Parts = { route?: string | null; card?: string | null; overlay?: string | null };

export function composeScreenKey(parts: Parts): string {
  return [parts.route, parts.card, parts.overlay].filter((p): p is string => !!p).join(' > ');
}

let routePart: string | null = null;
let cardPart: string | null = null;
const overlayStack: string[] = [];
let current: ScreenState = { key: '', seq: 0 };
let pushTimer: ReturnType<typeof setTimeout> | null = null;

type GlobalWithScreen = typeof globalThis & { __TEST_SCREEN__?: ScreenState };
type WindowWithPush = typeof window & { __e2eScreenChanged?: (key: string, seq: number) => void };

function enabled(): boolean {
  return process.env.MIDEN_E2E_TEST === 'true';
}

function scheduleChromePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const w = (typeof window !== 'undefined' ? window : undefined) as WindowWithPush | undefined;
    w?.__e2eScreenChanged?.(current.key, current.seq);
  }, SCREEN_PUSH_DEBOUNCE_MS);
}

function recomputeAndPublish(): void {
  if (!enabled()) return;
  const key = composeScreenKey({ route: routePart, card: cardPart, overlay: overlayStack[overlayStack.length - 1] ?? null });
  if (key === current.key) return;
  current = { key, seq: current.seq + 1 };
  (globalThis as GlobalWithScreen).__TEST_SCREEN__ = current;
  scheduleChromePush();
}

export function setRoutePart(value: string | null): void {
  routePart = value || null;
  recomputeAndPublish();
}

export function setCardPart(value: string | null): void {
  cardPart = value || null;
  recomputeAndPublish();
}

export function pushOverlay(id: string): void {
  if (!id) return;
  overlayStack.push(id);
  recomputeAndPublish();
}

export function popOverlay(id: string): void {
  const idx = overlayStack.lastIndexOf(id);
  if (idx >= 0) overlayStack.splice(idx, 1);
  recomputeAndPublish();
}

export function getCurrentScreen(): ScreenState {
  return current;
}

export function __resetScreenKeyForTest(): void {
  routePart = null;
  cardPart = null;
  overlayStack.length = 0;
  current = { key: '', seq: 0 };
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  delete (globalThis as GlobalWithScreen).__TEST_SCREEN__;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/e2e/screen-key.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/e2e/screen-key.ts src/lib/e2e/screen-key.test.ts
git commit -m "feat(e2e): screen-key module publishing __TEST_SCREEN__"
```

---

## Task 2: ScreenKeyPublisher (Woozie route → route part)

**Files:**
- Create: `src/app/templates/ScreenKeyPublisher.tsx`
- Modify: `src/app/App.tsx` (mount inside `Woozie.Provider`, near `ExtensionMessageListener`/`MobileBackBridge` at `App.tsx:94-96`)
- Test: `src/app/templates/ScreenKeyPublisher.test.tsx`

**Interfaces:**
- Consumes: `setRoutePart` (Task 1); Woozie `listen`, `createLocationState` from `lib/woozie`.
- Produces: `<ScreenKeyPublisher />` (renders `null`).

Notes for the implementer: Woozie exposes a non-React subscribe API `listen(cb): () => void` (`src/lib/woozie/history.ts:18-27`) that fires on every push/replace/pop; read the current route via `createLocationState().pathname` (+ `.search`). Route lives in the URL hash (`USE_LOCATION_HASH_AS_URL = true`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/templates/ScreenKeyPublisher.test.tsx
import { render } from '@testing-library/react';
import * as Woozie from 'lib/woozie';
import { getCurrentScreen, __resetScreenKeyForTest } from 'lib/e2e/screen-key';
import { ScreenKeyPublisher } from './ScreenKeyPublisher';

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
});

it('publishes the current route on mount and on navigation', () => {
  render(
    <Woozie.Provider>
      <ScreenKeyPublisher />
    </Woozie.Provider>
  );
  // mount publishes whatever the initial route is (non-empty key)
  expect(getCurrentScreen().key.startsWith('/')).toBe(true);

  Woozie.navigate('/send/review');
  expect(getCurrentScreen().key).toContain('/send/review');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/app/templates/ScreenKeyPublisher.test.tsx`
Expected: FAIL — `./ScreenKeyPublisher` not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/app/templates/ScreenKeyPublisher.tsx
import { useLayoutEffect } from 'react';
import { listen, createLocationState } from 'lib/woozie';
import { setRoutePart } from 'lib/e2e/screen-key';

/**
 * E2E-only. Feeds the Woozie route into the screen-key signal.
 * Gated on MIDEN_E2E_TEST so it tree-shakes out of production.
 */
export function ScreenKeyPublisher(): null {
  useLayoutEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    const publish = (): void => {
      const loc = createLocationState();
      setRoutePart(loc.pathname + (loc.search || ''));
    };
    publish();
    return listen(publish);
  }, []);
  return null;
}
```

Then mount in `src/app/App.tsx` (inside `<Woozie.Provider>`, alongside the existing listeners around `App.tsx:94-96`):

```tsx
import { ScreenKeyPublisher } from 'app/templates/ScreenKeyPublisher';
// ...
<Woozie.Provider>
  {/* existing children (ExtensionMessageListener, MobileBackBridge, ...) */}
  <ScreenKeyPublisher />
  {/* ... */}
</Woozie.Provider>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/app/templates/ScreenKeyPublisher.test.tsx`
Expected: PASS. (If the render errors on missing providers, wrap only in `Woozie.Provider` — this component needs no store/context beyond Woozie.)

- [ ] **Step 5: Commit**

```bash
git add src/app/templates/ScreenKeyPublisher.tsx src/app/templates/ScreenKeyPublisher.test.tsx src/app/App.tsx
git commit -m "feat(e2e): publish Woozie route into screen key"
```

---

## Task 3: Navigator card → card part

**Files:**
- Modify: `src/components/Navigator.tsx` (add one effect in `NavigatorProvider`, `:37-116`; `activeRoute` is memoized at `:94`)
- Test: `src/components/Navigator.screenkey.test.tsx`

**Interfaces:**
- Consumes: `setCardPart` (Task 1).
- Produces: no new export; behavior only.

Notes: `NavigatorProvider` is the ONE component all four flows mount (`SendManager.tsx:793`, `SwapManager.tsx:350`, `EncryptedFileManager.tsx:234`, `EvmBridgeDepositScreen.tsx:686`), so a single effect covers every flow. Publish `activeRoute?.name`; clear (`null`) on unmount so leaving a flow drops the card part.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/Navigator.screenkey.test.tsx
import { render, act } from '@testing-library/react';
import { NavigatorProvider, useNavigator } from './Navigator';
import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
  setRoutePart('/send');
});

function Harness() {
  const nav = useNavigator();
  return (
    <button onClick={() => nav.navigateTo({ name: 'Review', animationIn: 'push', animationOut: 'pop' })}>
      go
    </button>
  );
}

it('publishes the active Navigator card into the screen key', () => {
  const { getByText, unmount } = render(
    <NavigatorProvider initial={{ name: 'SelectAmount', animationIn: 'push', animationOut: 'pop' }}>
      <Harness />
    </NavigatorProvider>
  );
  expect(getCurrentScreen().key).toBe('/send > SelectAmount');
  act(() => getByText('go').click());
  expect(getCurrentScreen().key).toBe('/send > Review');
  unmount();
  expect(getCurrentScreen().key).toBe('/send');
});
```

> Implementer note: match the real `NavigatorProvider` prop name for the initial card (read `Navigator.tsx:37-48`). If it's not `initial`, adjust the test and the code together — the assertion behavior is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/components/Navigator.screenkey.test.tsx`
Expected: FAIL — card part never published (`key` stays `/send`).

- [ ] **Step 3: Write minimal implementation**

In `NavigatorProvider` body (after `activeRoute` is computed), add:

```tsx
import { setCardPart } from 'lib/e2e/screen-key';
// ...
useEffect(() => {
  if (process.env.MIDEN_E2E_TEST !== 'true') return;
  setCardPart(activeRoute?.name ?? null);
  return () => setCardPart(null);
}, [activeRoute]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/components/Navigator.screenkey.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/Navigator.tsx src/components/Navigator.screenkey.test.tsx
git commit -m "feat(e2e): publish Navigator card into screen key"
```

---

## Task 4: Overlay part (drawers, modals, dialogs) + optional `screenKey` prop

**Files:**
- Modify: `src/lib/ui/drawer.tsx` (`Drawer`, `:26-37`; props `:20-24`) — add optional `screenKey?: string`; publish on `open`.
- Modify: `src/app/atoms/CustomModal.tsx` (`:12-27`) — add optional `screenKey?: string`; publish on `isOpen`.
- Modify: `src/lib/ui/dialog.tsx` (constate store `:22-27`) — publish on alert/confirm `isOpen`.
- Modify (add `screenKey`): high-value drawer call sites — `SelectToken`, `SelectSwapToken`, `AccountsList`, `SelectNetwork`, `ScanQrDrawer`, `FundWalletDrawer`, `GuardianInfoDrawer`, `RevealSeedPhrase`, `DappActionsSheet`, EVM connect/bridge drawers.
- Test: `src/lib/ui/drawer.screenkey.test.tsx`

**Interfaces:**
- Consumes: `pushOverlay`, `popOverlay` (Task 1).
- Produces: `Drawer` and `CustomModal` accept an optional `screenKey?: string` prop.

Overlay id convention: `drawer:<screenKey|generic>`, `modal:<screenKey|generic>`, `dialog:alert` / `dialog:confirm`. When no `screenKey` is passed, use the generic (`drawer` / `modal`) so open/close is still captured.

- [ ] **Step 1: Write the failing test**

```tsx
// src/lib/ui/drawer.screenkey.test.tsx
import { render } from '@testing-library/react';
import { Drawer } from './drawer';
import { getCurrentScreen, setRoutePart, __resetScreenKeyForTest } from 'lib/e2e/screen-key';

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
  setRoutePart('/send');
});

it('named drawer appends a precise overlay part while open, removes it on close', () => {
  const { rerender } = render(<Drawer open={false} onOpenChange={() => {}} screenKey="token" />);
  expect(getCurrentScreen().key).toBe('/send');

  rerender(<Drawer open onOpenChange={() => {}} screenKey="token" />);
  expect(getCurrentScreen().key).toBe('/send > drawer:token');

  rerender(<Drawer open={false} onOpenChange={() => {}} screenKey="token" />);
  expect(getCurrentScreen().key).toBe('/send');
});

it('unnamed drawer falls back to a generic overlay part', () => {
  const { rerender } = render(<Drawer open={false} onOpenChange={() => {}} />);
  rerender(<Drawer open onOpenChange={() => {}} />);
  expect(getCurrentScreen().key).toBe('/send > drawer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/lib/ui/drawer.screenkey.test.tsx`
Expected: FAIL — no overlay part published; `screenKey` prop unknown.

- [ ] **Step 3: Write minimal implementation**

Add to `DrawerProps` (`drawer.tsx:20-24`): `screenKey?: string;`. Inside the `Drawer` component (near the existing `useHideNavbarWhileOpen(open)` at `:29`):

```tsx
import { useEffect } from 'react';
import { pushOverlay, popOverlay } from 'lib/e2e/screen-key';
// ...
const overlayId = `drawer:${screenKey ?? ''}`.replace(/:$/, '') ; // "drawer:token" or "drawer"
useEffect(() => {
  if (process.env.MIDEN_E2E_TEST !== 'true' || !open) return;
  pushOverlay(overlayId);
  return () => popOverlay(overlayId);
}, [open, overlayId]);
```

Apply the identical pattern to `CustomModal` (`modal:` prefix, keyed on `isOpen`). For `dialog.tsx`, in the constate store publish `dialog:alert` / `dialog:confirm` when the respective `isOpen` flips true and remove it when it flips false (mirror the pattern with `pushOverlay`/`popOverlay` inside a `useEffect` on the store's `isOpen` values, or at the dispatch open/close points — whichever is cleaner in that file).

Then pass `screenKey` at the high-value call sites, e.g. `<SelectToken ... />`'s `Drawer` gets `screenKey="token"`, `SelectSwapToken` → `"swap-token"`, `AccountsList` → `"accounts"`, `SelectNetwork` → `"network"`, `ScanQrDrawer` → `"scan-qr"`, `FundWalletDrawer` → `"fund"`, `GuardianInfoDrawer` → `"guardian-info"`, `RevealSeedPhrase` → `"reveal-seed"`, `DappActionsSheet` → `"dapp-actions"`, EVM drawers → `"evm-connect"` / `"evm-bridge-token"` / `"evm-switch-wallet"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/lib/ui/drawer.screenkey.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/drawer.tsx src/app/atoms/CustomModal.tsx src/lib/ui/dialog.tsx src/lib/ui/drawer.screenkey.test.tsx src/**/*Drawer*.tsx src/**/SelectToken*.tsx
git commit -m "feat(e2e): publish drawer/modal/dialog overlays into screen key"
```

---

## Task 5: Shared harness capture utilities

**Files:**
- Create: `playwright/e2e/harness/screen-capture.ts`
- Test: `playwright/e2e/harness/screen-capture.test.ts`

**Interfaces:**
- Consumes: nothing app-specific.
- Produces:
  - `screenShotName(seq: number, key: string, label: string): string`
  - `captureBestEffort(grab: (path: string) => Promise<void>, dir: string, seq: number, key: string, label: string): Promise<void>`
  - `startScreenPoll(opts: { intervalMs: number; read: () => Promise<{ key: string; seq: number } | null>; grab: (path: string) => Promise<void>; dir: string; label: string }): { stop: () => void }`

Notes: `screenShotName` slugifies `key` to filesystem-safe chars and zero-pads `seq` to 3 digits so lexical = chronological. `startScreenPoll` remembers the last seq and grabs only on change; everything best-effort (try/catch) so a transient CDP hiccup never fails a test.

- [ ] **Step 1: Write the failing test**

```ts
// playwright/e2e/harness/screen-capture.test.ts
import { screenShotName, startScreenPoll } from './screen-capture';

describe('screenShotName', () => {
  it('zero-pads seq and slugifies the key', () => {
    expect(screenShotName(4, '/send > SelectAmount > drawer:token', 'A'))
      .toBe('screen-004-send-SelectAmount-drawer-token-wallet-a.png');
  });
});

describe('startScreenPoll', () => {
  it('grabs once per seq change, not on unchanged reads', async () => {
    jest.useFakeTimers();
    const grabs: string[] = [];
    let state: { key: string; seq: number } | null = { key: '/a', seq: 1 };
    const poll = startScreenPoll({
      intervalMs: 100,
      read: async () => state,
      grab: async (p) => { grabs.push(p); },
      dir: '/out',
      label: 'A',
    });
    await jest.advanceTimersByTimeAsync(100); // seq 1 -> grab
    await jest.advanceTimersByTimeAsync(100); // unchanged -> no grab
    state = { key: '/b', seq: 2 };
    await jest.advanceTimersByTimeAsync(100); // seq 2 -> grab
    poll.stop();
    expect(grabs).toEqual([
      '/out/screen-001-a-wallet-a.png',
      '/out/screen-002-b-wallet-a.png',
    ]);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test playwright/e2e/harness/screen-capture.test.ts`
Expected: FAIL — module not found.

> If Playwright dir files aren't in the Jest test roots, run with an explicit config or place the test where Jest picks it up; confirm by seeing the "module not found" failure (not "no tests found").

- [ ] **Step 3: Write minimal implementation**

```ts
// playwright/e2e/harness/screen-capture.ts
import * as path from 'path';

export function screenShotName(seq: number, key: string, label: string): string {
  const slug = key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen';
  const padded = String(seq).padStart(3, '0');
  return `screen-${padded}-${slug}-wallet-${label.toLowerCase()}.png`;
}

export async function captureBestEffort(
  grab: (p: string) => Promise<void>,
  dir: string,
  seq: number,
  key: string,
  label: string,
): Promise<void> {
  try {
    await grab(path.join(dir, screenShotName(seq, key, label)));
  } catch {
    // best-effort: page/context may be mid-navigation or torn down
  }
}

export function startScreenPoll(opts: {
  intervalMs: number;
  read: () => Promise<{ key: string; seq: number } | null>;
  grab: (p: string) => Promise<void>;
  dir: string;
  label: string;
}): { stop: () => void } {
  let lastSeq = -1;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const s = await opts.read();
      if (s && s.seq !== lastSeq) {
        lastSeq = s.seq;
        await captureBestEffort(opts.grab, opts.dir, s.seq, s.key, opts.label);
      }
    } catch {
      // ignore a single bad read
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test playwright/e2e/harness/screen-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add playwright/e2e/harness/screen-capture.ts playwright/e2e/harness/screen-capture.test.ts
git commit -m "feat(e2e): shared screen-capture harness utils"
```

---

## Task 6: Chrome reactive capture

**Files:**
- Modify: `playwright/e2e/fixtures/two-wallets.ts` — add `installScreenCapture`; call it after launch (`walletA`/`walletB` fixtures `:746-791`), after `relaunch()` (`:513-521`), and after the load-retry `page.reload()` (`:481`).

**Interfaces:**
- Consumes: `screenShotName`/`captureBestEffort` (Task 5); the app's `window.__e2eScreenChanged` (Tasks 1-4); the harness `outputDir` (from `steps`/`timeline.getOutputDir()`, `:157-160`).
- Produces: `installScreenCapture(page: import('@playwright/test').Page, label: string, screensDir: string): Promise<void>`.

- [ ] **Step 1: Implement `installScreenCapture`**

```ts
// playwright/e2e/fixtures/two-wallets.ts
import * as path from 'path';
import { captureBestEffort } from '../harness/screen-capture';

export async function installScreenCapture(page: Page, label: string, outputDir: string): Promise<void> {
  const screensDir = path.join(outputDir, 'screens');
  const handler = (key: string, seq: number) =>
    captureBestEffort((p) => page.screenshot({ path: p }), screensDir, seq, key, label);
  // exposeFunction throws if already registered on this page — guard for reloads
  try {
    await page.exposeFunction('__e2eScreenChanged', handler);
  } catch {
    // already exposed on this page instance (e.g. soft reload kept the binding)
  }
}
```

- [ ] **Step 2: Wire it into the fixture lifecycle**

In the `walletA` fixture (right after `steps.registerSnapshotCaps('A', ...)`, `:749`):

```ts
await installScreenCapture(instance.page, 'A', steps.outputDir);
```
Do the same for `'B'`. Add re-registration calls immediately after `relaunch()` (`:513-521`) and after the load-retry `page.reload()` (`:481`) — a fresh page loses the binding.

> `steps.outputDir` is `private` today (`test-step.ts:56-62`). Expose it: add `readonly outputDir: string` set in the `TestStepRunner` constructor (change `private outputDir` → assign to a public readonly). Keep the field name identical so `test-step.ts` internals are unaffected.

- [ ] **Step 3: Verify locally (real e2e)**

Run a single Chrome spec against localhost (fast):

```bash
source ~/.nvm/nvm.sh && nvm use 22
yarn test:e2e:blockchain:localhost playwright/e2e/tests/send-public.spec.ts
```
Expected: after the run, the test's output dir contains `screens/screen-*.png` including frames for the send flow (amount → review → generating → receipt) and a token-drawer open/close pair.

Inspect:
```bash
ls -1 test-results/run-*/tests/*/screens/ | sort | tail -40
```

- [ ] **Step 4: Commit**

```bash
git add playwright/e2e/fixtures/two-wallets.ts playwright/e2e/harness/test-step.ts
git commit -m "feat(e2e): chrome reactive screen-change capture"
```

---

## Task 7: iOS poll capture

**Files:**
- Modify: `playwright/e2e/ios/fixtures/two-simulators.ts` — start a poll per wallet after wallets are up (`_simPair` `:362-408`), clear in teardown.

**Interfaces:**
- Consumes: `startScreenPoll` (Task 5); iOS `cdp.eval` (`ios/helpers/cdp-bridge.ts:100-109`), `IosWalletPage.screenshot` (`ios/helpers/ios-wallet-page.ts:101-103`); harness `outputDir` (`two-simulators.ts:61-64`).

- [ ] **Step 1: Implement the poll wiring**

```ts
// playwright/e2e/ios/fixtures/two-simulators.ts
import * as path from 'path';
import { startScreenPoll } from '../../harness/screen-capture';

// after both wallets are launched and `steps` outputDir is known:
const screensDir = path.join(steps.outputDir, 'screens');
const polls = [
  { label: 'A', wallet: walletA, cdp: cdpA },
  { label: 'B', wallet: walletB, cdp: cdpB },
].map(({ label, wallet, cdp }) =>
  startScreenPoll({
    intervalMs: 250,
    read: async () => {
      const raw = await cdp.eval<string>('return JSON.stringify(window.__TEST_SCREEN__ || null)', { timeoutMs: 5000 });
      return raw ? (JSON.parse(raw) as { key: string; seq: number }) : null;
    },
    grab: (p) => wallet.screenshot({ path: p }),
    dir: screensDir,
    label,
  }),
);
// ... existing `await use({...})` ...
// teardown:
polls.forEach((p) => p.stop());
```

> Match the real fixture's variable names for the cdp session + wallet page (read `two-simulators.ts:232-245` `readStore` for how `eval` is already used per wallet). Keep the poll read tiny — iOS CDP is one serial socket.

- [ ] **Step 2: Verify on a booted simulator**

```bash
source ~/.nvm/nvm.sh && nvm use 22
# boot iPhone 17 sim per repo tooling, then:
yarn test:e2e:mobile:devnet playwright/e2e/ios/tests/send-public.ios.spec.ts
ls -1 test-results-ios/run-*/tests/*/screens/ | sort | tail -40
```
Expected: `screens/` filmstrip for the iOS send flow (accepting occasional sub-250ms transient misses).

- [ ] **Step 3: Commit**

```bash
git add playwright/e2e/ios/fixtures/two-simulators.ts
git commit -m "feat(e2e): ios poll-based screen-change capture"
```

---

## Task 8: Android poll capture

**Files:**
- Modify: `playwright/e2e/android/fixtures/two-emulators.ts` — same poll pattern, using Android CDP + `adb` grab.

**Interfaces:**
- Consumes: `startScreenPoll` (Task 5); Android `cdp.evaluate` (`android/helpers/cdp-bridge.ts:162-170`), `AndroidWalletPage.screenshot` (`android/helpers/android-wallet-page.ts:58-60`); harness `outputDir` (`two-emulators.ts:62-64`).

- [ ] **Step 1: Implement the poll wiring**

```ts
// playwright/e2e/android/fixtures/two-emulators.ts
import * as path from 'path';
import { startScreenPoll } from '../../harness/screen-capture';

const screensDir = path.join(steps.outputDir, 'screens');
const polls = [
  { label: 'A', wallet: walletA },
  { label: 'B', wallet: walletB },
].map(({ label, wallet }) =>
  startScreenPoll({
    intervalMs: 250,
    read: () => wallet.evaluate(() => (window as unknown as { __TEST_SCREEN__?: { key: string; seq: number } }).__TEST_SCREEN__ ?? null),
    grab: (p) => wallet.screenshot({ path: p }),
    dir: screensDir,
    label,
  }),
);
// teardown: polls.forEach((p) => p.stop());
```

> `AndroidWalletPage.evaluate(fn)` delegates to real CDP `Runtime.evaluate` with `returnByValue` (`android-wallet-page.ts:62-64`), so returning the plain object directly is fine (no JSON.stringify needed, unlike iOS).

- [ ] **Step 2: Verify on a booted emulator (if available locally)**

```bash
source ~/.nvm/nvm.sh && nvm use 22
yarn test:e2e:android:devnet playwright/e2e/android/tests/mint-and-balance.android.spec.ts
ls -1 test-results-android/run-*/tests/*/screens/ | sort | tail -40
```
Expected: `screens/` filmstrip. (If no local emulator, rely on the `e2e-android.yml` CI run in Task 10's dry-run — note this in the commit.)

- [ ] **Step 3: Commit**

```bash
git add playwright/e2e/android/fixtures/two-emulators.ts
git commit -m "feat(e2e): android poll-based screen-change capture"
```

---

## Task 9: CI — promote PR suites to main gates + capture on green

**Files:**
- Modify: `.github/workflows/pr-e2e-swap.yml`, `pr-e2e-earn.yml`, `pr-e2e-guardian-lifecycle.yml`, `pr-e2e-bridge-guardian.yml`
- Modify: `.github/workflows/e2e-resilience.yml`

**Interfaces:** none (CI config).

- [ ] **Step 1: Add the `main` push trigger to the four PR suites**

For each of the four `pr-e2e-*.yml`, change:
```yaml
on:
  pull_request:
  workflow_dispatch: {}
```
to:
```yaml
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch: {}
```
These become blocking gates on `main` (jobs are not `continue-on-error`; a failure reds `main`).

- [ ] **Step 2: Upload artifacts on green too**

In each of the four workflows, change the `actions/upload-artifact` step condition from `if: failure()` to `if: always()`, and set `retention-days: 7` (match the other main-push E2E workflows).

- [ ] **Step 3: Fix resilience upload to keep green filmstrips**

In `e2e-resilience.yml` (`:139-143`), change the upload from `if: failure()` to `if: always()` and add `retention-days: 7`.

- [ ] **Step 4: Validate the YAML**

Run:
```bash
for f in pr-e2e-swap pr-e2e-earn pr-e2e-guardian-lifecycle pr-e2e-bridge-guardian e2e-resilience; do
  python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/$f.yml')); print('$f OK')"
done
```
Expected: all `OK`. Grep to confirm each now has both `pull_request` and `push:` with `branches: [main]`, and `if: always()` on the upload.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pr-e2e-swap.yml .github/workflows/pr-e2e-earn.yml .github/workflows/pr-e2e-guardian-lifecycle.yml .github/workflows/pr-e2e-bridge-guardian.yml .github/workflows/e2e-resilience.yml
git commit -m "ci: run swap/earn/guardian-lifecycle/bridge-guardian on main + upload screens on green"
```

---

## Task 10: Integration verification (empirical "done" gate)

**Files:** none (verification only).

- [ ] **Step 1: Prove the filmstrip on Chrome**

```bash
source ~/.nvm/nvm.sh && nvm use 22
yarn test:e2e:blockchain:localhost playwright/e2e/tests/send-public.spec.ts
ls test-results/run-*/tests/*/screens/*.png | wc -l
ls -1 test-results/run-*/tests/*/screens/ | sort
```
Confirm ordered frames covering amount → review → generating → receipt AND a drawer open/close pair. Open a couple of PNGs to eyeball they show settled UI (not blank/spinner).

- [ ] **Step 2: Prove coverage of a no-`steps.step` suite (the key risk)**

```bash
yarn test:e2e:swap playwright/e2e/tests/swap/swap-smoke.spec.ts   # or the swap script name in package.json
ls -1 test-results/run-*/tests/*/screens/ | sort | tail -20
```
Confirm screenshots ARE produced even though swap specs never call `steps.step(...)` — this is the evidence the app-side approach covers swap/earn/bridge.

- [ ] **Step 3: Confirm prod tree-shaking**

```bash
yarn build   # a normal (non-E2E) production build
grep -r "__TEST_SCREEN__\|__e2eScreenChanged" dist/ && echo "LEAKED — investigate" || echo "clean: no test hooks in prod bundle"
```
Expected: `clean` — the `MIDEN_E2E_TEST` gate tree-shook everything out.

- [ ] **Step 4: CI dry-run on the branch**

Push the branch (only when the user asks) and trigger the promoted workflows via `workflow_dispatch`; confirm `screens/` artifacts upload on a GREEN run for at least one Chrome suite and `e2e-android`.

- [ ] **Step 5: Record results**

Append a short "Verification results" section to the design doc with the frame counts and any transient-miss observations. Commit.

```bash
git add docs/superpowers/plans/2026-08-17-e2e-screen-change-screenshots-design.md
git commit -m "docs: record screen-change capture verification results"
```

---

## Self-Review

**Spec coverage:**
- §5.1 screen-key signal → Tasks 1-4. Woozie/Navigator/overlay sources each have a task.
- §5.2 Chrome reactive → Task 6. §5.3 iOS/Android poll → Tasks 7-8. §5.4 naming/output → Task 5 (+ used by 6-8).
- §5.5 CI → Task 9. Verification (§7) → Task 10.
- Drawer identity (optional prop + fallback) → Task 4. WASM-lock safety → enforced by reading a plain object in Tasks 7-8 (Global Constraints).

**Type consistency:** `ScreenState = { key; seq }` used identically in Tasks 1, 5, 7, 8. `window.__e2eScreenChanged(key, seq)` signature matches between Task 1 (caller) and Task 6 (handler). `setRoutePart/setCardPart/pushOverlay/popOverlay` names consistent across Tasks 1-4. `screenShotName`/`startScreenPoll`/`captureBestEffort` names consistent across Tasks 5-8. `steps.outputDir` made public in Task 6 and consumed in Tasks 6-8.

**Placeholder scan:** no TBD/TODO; every code step has concrete code; verification steps have concrete commands. Call-site prop names in Task 4 are enumerated. The only implementer-judgment notes are flagged inline (real `NavigatorProvider` initial-prop name; real cdp/wallet variable names in the mobile fixtures) — these are "match the existing symbol" instructions, not missing content.
