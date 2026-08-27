# Web SDK Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@miden-sdk/miden-sdk` a vendor-neutral observability interface — operation name, outcome, duration — plus two opt-in vendor binding packages, so consumers can wire the Miden stack into their own telemetry without the SDK ever transporting anything itself.

**Architecture:** A single observer registry emits one observation per client operation, hooked into `_serializeWasmCall` — the one function every async client path already funnels through. Observations carry safe fields always; a high-fidelity field carrying identifiers and raw error text is populated only when explicitly enabled at client construction, and is absent from the object otherwise. Vendor bindings (`telemetry-sentry`, `telemetry-otel`) are separate workspace packages that consume observations and depend on their vendor as a `peerDependency`; the core has no telemetry dependency and no network capability.

**Tech Stack:** JavaScript (ESM) + TypeScript declaration files, pnpm workspaces, vitest, rollup. Rust/WASM is untouched — this is entirely the `js/` wrapper layer.

**Spec:** `docs/superpowers/specs/2026-08-20-wallet-telemetry-design.md` (in the `0xMiden/wallet` repo; read the "Web SDK observability" section before starting)

**Repository:** This plan executes in **`0xMiden/web-sdk`**, not the wallet repo. Clone it and work there. The wallet plan (`2026-08-20-wallet-telemetry.md`) consumes the version this plan publishes.

## Global Constraints

- **The core SDK must never gain a telemetry dependency.** `@sentry/*`, OTel packages, and any analytics SDK are forbidden in `crates/web-client/package.json` — including as `optionalDependencies` or `peerDependencies`.
- **The core observability module must have no network capability.** No `fetch`, no `XMLHttpRequest`, no `navigator.sendBeacon`, no `WebSocket`.
- **Observation emission must never throw into the caller.** Every observer invocation is wrapped in try/catch. A throwing observer degrades to silence, never to a failed client operation.
- **Observation emission must never make an operation async that wasn't.** Observers are called synchronously.
- **`observeSensitive` defaults to `false`**, and when false the `sensitive` field is **absent from the observation object** — not `undefined`, not `{}`. Assert with `"sensitive" in observation === false`.
- **`SYNC_METHODS` stay raw-bound.** Do not route them through the observer; they are synchronous and cheap, and wrapping them would change their call semantics. See `crates/web-client/js/index.js:269-271`.
- Package manager is **pnpm**. Use `pnpm --filter <pkg>`, never `npm` or `yarn`.
- Existing CI gates must keep passing: `pnpm run check:knip`, `pnpm run check:publint`, `pnpm run check:attw`, `node scripts/check-method-classification.js`.

---

### Task 1: Core observability module

The observer registry and the observation factory. No consumers yet — this task stands alone and is fully unit-testable.

**Files:**
- Create: `crates/web-client/js/observability.js`
- Test: `crates/web-client/js/__tests__/observability.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `setObserver(observer)` — `observer` is `(observation) => void` or `null` to clear. Returns an unsubscribe function `() => void`.
  - `emitObservation({ op, outcome, durationMs, sensitive })` — `void`. `sensitive` is omitted from the delivered object unless provided.
  - `hasObserver()` — `boolean`. Lets callers skip timing work entirely when nobody is listening.
  - `__resetObserverForTest()` — `void`.

- [ ] **Step 1: Write the failing test**

```javascript
// crates/web-client/js/__tests__/observability.test.js
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setObserver,
  emitObservation,
  hasObserver,
  __resetObserverForTest,
} from "../observability.js";

afterEach(() => __resetObserverForTest());

describe("observability", () => {
  it("reports no observer until one is set", () => {
    expect(hasObserver()).toBe(false);
    setObserver(() => {});
    expect(hasObserver()).toBe(true);
  });

  it("delivers safe fields to the observer", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 12 });
    expect(seen).toEqual([{ op: "syncState", outcome: "ok", durationMs: 12 }]);
  });

  it("omits the sensitive key entirely when not supplied", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect("sensitive" in seen[0]).toBe(false);
  });

  it("includes the sensitive key only when supplied", () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    emitObservation({
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      sensitive: { errorMessage: "boom" },
    });
    expect(seen[0].sensitive).toEqual({ errorMessage: "boom" });
  });

  it("is a no-op when no observer is registered", () => {
    expect(() =>
      emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 })
    ).not.toThrow();
  });

  it("swallows an observer that throws", () => {
    setObserver(() => {
      throw new Error("observer blew up");
    });
    expect(() =>
      emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 })
    ).not.toThrow();
  });

  it("unsubscribes via the returned function", () => {
    const observer = vi.fn();
    const off = setObserver(observer);
    off();
    emitObservation({ op: "syncState", outcome: "ok", durationMs: 1 });
    expect(observer).not.toHaveBeenCalled();
    expect(hasObserver()).toBe(false);
  });

  it("clears the observer when passed null", () => {
    setObserver(() => {});
    setObserver(null);
    expect(hasObserver()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run crates/web-client/js/__tests__/observability.test.js`
Expected: FAIL — cannot resolve `../observability.js`.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// crates/web-client/js/observability.js
/**
 * Vendor-neutral observability sink.
 *
 * The SDK emits one observation per client operation. It never transports
 * anything: there is deliberately no fetch/beacon/socket in this module, so a
 * consumer can prove by inspection that the SDK cannot phone home. Vendor
 * bindings live in separate opt-in packages.
 *
 * Emission must never affect an operation: a throwing observer is swallowed,
 * and observers are invoked synchronously so an operation's timing and
 * async-ness are unchanged.
 */

let currentObserver = null;

/**
 * Register the observation sink. Replaces any existing observer.
 *
 * @param {((observation: object) => void) | null} observer
 * @returns {() => void} unsubscribe
 */
export function setObserver(observer) {
  currentObserver = typeof observer === "function" ? observer : null;
  const registered = currentObserver;
  return () => {
    if (currentObserver === registered) {
      currentObserver = null;
    }
  };
}

/** @returns {boolean} whether anyone is listening. */
export function hasObserver() {
  return currentObserver !== null;
}

/**
 * Deliver one observation. `sensitive` is omitted from the delivered object
 * unless explicitly supplied, so `"sensitive" in observation` is a truthful
 * test of whether the high-fidelity channel is active.
 *
 * @param {{op: string, outcome: "ok" | "error", durationMs: number, sensitive?: object}} fields
 */
export function emitObservation({ op, outcome, durationMs, sensitive }) {
  if (currentObserver === null) return;
  const observation = { op, outcome, durationMs };
  if (sensitive !== undefined) {
    observation.sensitive = sensitive;
  }
  try {
    currentObserver(observation);
  } catch {
    // An observer must never be able to fail a client operation.
  }
}

/** Test-only: drop the registered observer. */
export function __resetObserverForTest() {
  currentObserver = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run crates/web-client/js/__tests__/observability.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the no-network guard test**

This is a standing guarantee, not a one-off check, so it belongs in the suite.

```javascript
// append to crates/web-client/js/__tests__/observability.test.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("observability has no network capability", () => {
  it("contains no egress primitive", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../observability.js", import.meta.url)),
      "utf8"
    );
    for (const forbidden of [
      "fetch",
      "XMLHttpRequest",
      "sendBeacon",
      "WebSocket",
      "EventSource",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 6: Run the guard test**

Run: `pnpm vitest run crates/web-client/js/__tests__/observability.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add crates/web-client/js/observability.js crates/web-client/js/__tests__/observability.test.js
git commit -m "feat(observability): add vendor-neutral observation sink"
```

---

### Task 2: Emit observations from the operation choke point

Hook the sink into `_serializeWasmCall`, the one function every async client path funnels through.

**Files:**
- Modify: `crates/web-client/js/index.js:576-583` (`_serializeWasmCall`)
- Modify: `crates/web-client/js/index.js:254-282` (`createClientProxy` — pass the property name as the op name)
- Test: `crates/web-client/js/__tests__/observability-wiring.test.js`

**Interfaces:**
- Consumes: `emitObservation`, `hasObserver` from `./observability.js` (Task 1).
- Produces: `_serializeWasmCall(fn, opName)` — the second parameter is optional; when omitted or when no observer is registered, behavior is byte-for-byte the previous behavior. Callers inside `index.js` pass a `MethodName` value or the proxied property name.

**Why here:** `createClientProxy` (line 254) only intercepts *fallthrough* properties — anything defined on the `WebClient` wrapper itself is returned by `Reflect.get` and never sees the proxy's wrapping. So the proxy is not a universal choke point. `_serializeWasmCall` is: the proxy's fallthrough path calls it (line 273), and every explicitly-wrapped worker-forwarded method calls it (`newWallet` 805, `newFaucet` 820, `newAccount` 835, `newAccountWithSecretKey` 842, `submitNewTransaction` 849, `submitNewTransactionWithProver` 880, `executeTransaction` 917, `proveTransaction` 946, `applyTransaction` 977, and the three sync methods at 1024, 1054, 1080).

- [ ] **Step 1: Write the failing test**

```javascript
// crates/web-client/js/__tests__/observability-wiring.test.js
import { describe, it, expect, afterEach } from "vitest";
import {
  setObserver,
  __resetObserverForTest,
} from "../observability.js";

afterEach(() => __resetObserverForTest());

// Minimal stand-in exercising _serializeWasmCall's contract in isolation:
// a serialized async call chain that reports op name, outcome, and duration.
// Replace the import below with the real WebClient once Step 3 lands.
import { __serializeWasmCallForTest as serialize } from "../index.js";

describe("_serializeWasmCall observation", () => {
  it("emits ok with the op name and a numeric duration", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => "value", "syncState");
    expect(seen).toHaveLength(1);
    expect(seen[0].op).toBe("syncState");
    expect(seen[0].outcome).toBe("ok");
    expect(typeof seen[0].durationMs).toBe("number");
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits error and rethrows the original error", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const boom = new Error("wasm exploded");
    await expect(
      serialize(async () => {
        throw boom;
      }, "proveTransaction")
    ).rejects.toBe(boom);
    expect(seen[0]).toMatchObject({
      op: "proveTransaction",
      outcome: "error",
    });
  });

  it("omits sensitive by default even on error", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => {
      throw new Error("secret-bearing message");
    }, "syncState").catch(() => {});
    expect("sensitive" in seen[0]).toBe(false);
  });

  it("does not emit when no op name is supplied", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => "value");
    expect(seen).toHaveLength(0);
  });

  it("returns the resolved value unchanged", async () => {
    setObserver(() => {});
    await expect(serialize(async () => 42, "syncState")).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run crates/web-client/js/__tests__/observability-wiring.test.js`
Expected: FAIL — `__serializeWasmCallForTest` is not exported from `index.js`.

- [ ] **Step 3: Modify `_serializeWasmCall`**

Add the import at the top of `crates/web-client/js/index.js`, alongside the other local imports:

```javascript
import {
  emitObservation,
  hasObserver,
} from "./observability.js";
```

Replace the body of `_serializeWasmCall` (currently `index.js:576-583`) with:

```javascript
  _serializeWasmCall(fn, opName) {
    // Observation is opt-in twice over: no observer registered, or no op name
    // supplied, and this is the original code path with no added work.
    const observed = opName !== undefined && hasObserver();
    const wrapped = observed
      ? async () => {
          const startedAt = performance.now();
          try {
            const value = await fn();
            emitObservation({
              op: opName,
              outcome: "ok",
              durationMs: performance.now() - startedAt,
            });
            return value;
          } catch (error) {
            emitObservation({
              op: opName,
              outcome: "error",
              durationMs: performance.now() - startedAt,
            });
            throw error;
          }
        }
      : fn;

    if (this._withInnerLockDepth > 0) {
      return Promise.resolve().then(wrapped);
    }
    const result = this._wasmCallChain.catch(() => {}).then(wrapped);
    this._wasmCallChain = result.catch(() => {});
    return result;
  }
```

- [ ] **Step 4: Pass the op name from the proxy fallthrough path**

In `createClientProxy` (`index.js:272-275`), pass the property name:

```javascript
          return (...args) =>
            target._serializeWasmCall(
              () => value.apply(target.wasmWebClient, args),
              prop
            );
```

- [ ] **Step 5: Pass the op name from every explicitly-wrapped method**

Add the second argument at each `_serializeWasmCall` call site in `index.js`. Use the `MethodName` constant where one exists (`crates/web-client/js/constants.js:15-30`), otherwise the method's own name as a string literal:

| Line | Method | Second argument |
|---|---|---|
| 805 | `newWallet` | `"newWallet"` |
| 820 | `newFaucet` | `"newFaucet"` |
| 835 | `newAccount` | `"newAccount"` |
| 842 | `newAccountWithSecretKey` | `"newAccountWithSecretKey"` |
| 849 | `submitNewTransaction` | `MethodName.SUBMIT_NEW_TRANSACTION` |
| 880 | `submitNewTransactionWithProver` | `MethodName.SUBMIT_NEW_TRANSACTION_WITH_PROVER` |
| 917 | `executeTransaction` | `MethodName.EXECUTE_TRANSACTION` |
| 946 | `proveTransaction` | `MethodName.PROVE_TRANSACTION` |
| 977 | `applyTransaction` | `MethodName.APPLY_TRANSACTION` |
| 1024 | `syncState` | `MethodName.SYNC_STATE` |
| 1054 | `syncNoteTransport` | `MethodName.SYNC_NOTE_TRANSPORT` |
| 1080 | `syncChain` | `MethodName.SYNC_CHAIN` |

Leave the `MockWebClient` call sites (1202, 1248, 1293) unchanged for now — mock clients are test infrastructure and emitting from them would pollute consumer observations during tests.

- [ ] **Step 6: Export the test seam**

At the end of `crates/web-client/js/index.js`, add:

```javascript
/**
 * @internal Test-only seam. Exercises `_serializeWasmCall`'s observation
 * contract without constructing a real WASM-backed client.
 */
export function __serializeWasmCallForTest(fn, opName) {
  const host = {
    _withInnerLockDepth: 0,
    _wasmCallChain: Promise.resolve(),
    _serializeWasmCall: WebClient.prototype._serializeWasmCall,
  };
  return host._serializeWasmCall(fn, opName);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run crates/web-client/js/__tests__/observability-wiring.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 8: Run the full suite to confirm nothing regressed**

Run: `pnpm test && node scripts/check-method-classification.js`
Expected: PASS. The method-classification lint must still pass — you added arguments but no new methods, so `SYNC_METHODS` / `WRITE_METHODS` / `READ_METHODS` are unchanged.

- [ ] **Step 9: Commit**

```bash
git add crates/web-client/js/index.js crates/web-client/js/__tests__/observability-wiring.test.js
git commit -m "feat(observability): emit observations from the wasm call choke point"
```

---

### Task 3: Wire the observer through `ClientOptions`

Make the sink reachable from the public construction API, and add the opt-in high-fidelity flag.

**Files:**
- Modify: `crates/web-client/js/types/api-types.d.ts:164` (`ClientOptions`)
- Modify: `crates/web-client/js/index.js` (client creation path — apply `options.observer`)
- Create: `crates/web-client/js/__tests__/client-options-observer.test.js`

**Interfaces:**
- Consumes: `setObserver` from `./observability.js` (Task 1); the observation shape from Task 2.
- Produces: two new optional `ClientOptions` fields —
  - `observer?: (observation: MidenObservation) => void`
  - `observeSensitive?: boolean` (default `false`)

  and two exported types: `MidenObservation` and `MidenObservationSensitive`.

- [ ] **Step 1: Write the failing test**

```javascript
// crates/web-client/js/__tests__/client-options-observer.test.js
import { describe, it, expect, afterEach, vi } from "vitest";
import { __applyObserverOptionsForTest } from "../index.js";
import { hasObserver, __resetObserverForTest } from "../observability.js";

afterEach(() => {
  __resetObserverForTest();
  vi.restoreAllMocks();
});

describe("ClientOptions observer wiring", () => {
  it("registers nothing when no observer option is given", () => {
    __applyObserverOptionsForTest({});
    expect(hasObserver()).toBe(false);
  });

  it("registers the supplied observer", () => {
    __applyObserverOptionsForTest({ observer: () => {} });
    expect(hasObserver()).toBe(true);
  });

  it("does not warn when observeSensitive is absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __applyObserverOptionsForTest({ observer: () => {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns exactly once when observeSensitive is enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __applyObserverOptionsForTest({ observer: () => {}, observeSensitive: true });
    __applyObserverOptionsForTest({ observer: () => {}, observeSensitive: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("observeSensitive");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run crates/web-client/js/__tests__/client-options-observer.test.js`
Expected: FAIL — `__applyObserverOptionsForTest` is not exported.

- [ ] **Step 3: Implement the option application**

Add to `crates/web-client/js/index.js`:

```javascript
let sensitiveWarningEmitted = false;

/**
 * Apply the observability fields of `ClientOptions`. Enabling the
 * high-fidelity channel warns once per process: routing account ids and raw
 * error text into a third party should never happen by accident.
 *
 * @param {{observer?: (o: object) => void, observeSensitive?: boolean}} options
 * @returns {boolean} whether the high-fidelity channel is enabled
 */
function applyObserverOptions(options = {}) {
  if (typeof options.observer === "function") {
    setObserver(options.observer);
  }
  const observeSensitive = options.observeSensitive === true;
  if (observeSensitive && !sensitiveWarningEmitted) {
    sensitiveWarningEmitted = true;
    console.warn(
      "[miden-sdk] observeSensitive is enabled: observations will carry account " +
        "identifiers and raw error text. Do not enable this in an application " +
        "that must not disclose user data to its telemetry provider."
    );
  }
  return observeSensitive;
}

/** @internal Test-only seam for `applyObserverOptions`. */
export function __applyObserverOptionsForTest(options) {
  return applyObserverOptions(options);
}
```

Import `setObserver` alongside the Task 2 imports:

```javascript
import {
  emitObservation,
  hasObserver,
  setObserver,
} from "./observability.js";
```

Then call `applyObserverOptions(options)` on the `MidenClient` creation path, storing the returned boolean on the instance as `this._observeSensitive` so Task 4 can read it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run crates/web-client/js/__tests__/client-options-observer.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the public types**

In `crates/web-client/js/types/api-types.d.ts`, immediately before `export interface ClientOptions {` (line 164), add:

```typescript
/**
 * High-fidelity observation detail. Present **only** when the client was
 * constructed with `observeSensitive: true`. Carries account identifiers and
 * verbatim error text, so an application with confidentiality obligations to
 * its users must leave `observeSensitive` unset and never read this field.
 */
export interface MidenObservationSensitive {
  /** Verbatim error message, when the operation failed. */
  errorMessage?: string;
  /** Verbatim error stack, when the operation failed. */
  errorStack?: string;
  /** Account the operation acted on, when the operation targets one. */
  accountId?: string;
}

/** One observed client operation. */
export interface MidenObservation {
  /** Client operation name, e.g. `"syncState"`, `"proveTransaction"`. */
  op: string;
  outcome: "ok" | "error";
  /** Wall time the caller waited, in milliseconds. */
  durationMs: number;
  /**
   * Absent unless the client was constructed with `observeSensitive: true`.
   * Test with `"sensitive" in observation`.
   */
  sensitive?: MidenObservationSensitive;
}
```

Then add these two fields inside `ClientOptions`:

```typescript
  /**
   * Observation sink. Called synchronously once per client operation with the
   * operation name, outcome, and duration.
   *
   * The SDK never transports observations itself — it has no telemetry
   * dependency and no network capability in this path. Forward them to your
   * own provider, or use an opt-in binding package
   * (`@miden-sdk/telemetry-sentry`, `@miden-sdk/telemetry-otel`).
   *
   * A throwing observer is swallowed and can never fail a client operation.
   */
  observer?: (observation: MidenObservation) => void;
  /**
   * Populate {@link MidenObservation.sensitive} with account identifiers and
   * verbatim error text. Defaults to `false`, in which case the `sensitive`
   * key is **absent** from every observation. Enabling it logs a one-time
   * console warning.
   */
  observeSensitive?: boolean;
```

- [ ] **Step 6: Type-check and verify the package surface**

Run: `pnpm run build:web-client && pnpm run check:publint && pnpm run check:attw`
Expected: PASS. `attw` must not report the new types as unresolvable.

- [ ] **Step 7: Commit**

```bash
git add crates/web-client/js/index.js crates/web-client/js/types/api-types.d.ts crates/web-client/js/__tests__/client-options-observer.test.js
git commit -m "feat(observability): expose observer and observeSensitive on ClientOptions"
```

---

### Task 4: Populate the high-fidelity channel

Make `observeSensitive: true` actually deliver detail, and prove it delivers nothing when off.

**Files:**
- Modify: `crates/web-client/js/index.js` (`_serializeWasmCall` — read `this._observeSensitive`)
- Test: `crates/web-client/js/__tests__/observability-sensitive.test.js`

**Interfaces:**
- Consumes: `_serializeWasmCall(fn, opName)` from Task 2; `this._observeSensitive` from Task 3; `MidenObservationSensitive` from Task 3.
- Produces: no new exports. `_serializeWasmCall` now passes a `sensitive` object to `emitObservation` when `this._observeSensitive === true` and the operation failed.

- [ ] **Step 1: Write the failing test**

```javascript
// crates/web-client/js/__tests__/observability-sensitive.test.js
import { describe, it, expect, afterEach } from "vitest";
import { __serializeWasmCallForTest as serialize } from "../index.js";
import { setObserver, __resetObserverForTest } from "../observability.js";

afterEach(() => __resetObserverForTest());

describe("high-fidelity channel", () => {
  it("carries error message and stack when enabled", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    const boom = new Error("account mtst1abc has insufficient balance 4200");
    await serialize(
      async () => {
        throw boom;
      },
      "syncState",
      { observeSensitive: true }
    ).catch(() => {});
    expect(seen[0].sensitive.errorMessage).toBe(
      "account mtst1abc has insufficient balance 4200"
    );
    expect(seen[0].sensitive.errorStack).toBe(boom.stack);
  });

  it("omits the sensitive key when disabled, even on error", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error("account mtst1abc has insufficient balance 4200");
      },
      "syncState",
      { observeSensitive: false }
    ).catch(() => {});
    expect("sensitive" in seen[0]).toBe(false);
  });

  it("omits the sensitive key on success even when enabled", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(async () => "fine", "syncState", {
      observeSensitive: true,
    });
    expect("sensitive" in seen[0]).toBe(false);
  });

  it("never leaks error text into safe fields", async () => {
    const seen = [];
    setObserver((o) => seen.push(o));
    await serialize(
      async () => {
        throw new Error("mtst1secretaddress");
      },
      "syncState",
      { observeSensitive: false }
    ).catch(() => {});
    expect(JSON.stringify(seen[0])).not.toContain("mtst1secretaddress");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run crates/web-client/js/__tests__/observability-sensitive.test.js`
Expected: FAIL — the test seam takes two arguments and no `sensitive` field is produced.

- [ ] **Step 3: Extend the error path in `_serializeWasmCall`**

Replace the `catch` block added in Task 2 Step 3 with:

```javascript
          } catch (error) {
            const sensitive = observeSensitive
              ? {
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                  ...(error instanceof Error && error.stack
                    ? { errorStack: error.stack }
                    : {}),
                }
              : undefined;
            emitObservation({
              op: opName,
              outcome: "error",
              durationMs: performance.now() - startedAt,
              ...(sensitive !== undefined ? { sensitive } : {}),
            });
            throw error;
          }
```

and read the flag at the top of the method:

```javascript
  _serializeWasmCall(fn, opName, observabilityConfig) {
    const observeSensitive =
      (observabilityConfig?.observeSensitive ?? this._observeSensitive) === true;
```

- [ ] **Step 4: Extend the test seam to accept the config**

Update `__serializeWasmCallForTest` from Task 2 Step 6:

```javascript
export function __serializeWasmCallForTest(fn, opName, observabilityConfig) {
  const host = {
    _withInnerLockDepth: 0,
    _wasmCallChain: Promise.resolve(),
    _observeSensitive: false,
    _serializeWasmCall: WebClient.prototype._serializeWasmCall,
  };
  return host._serializeWasmCall(fn, opName, observabilityConfig);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run crates/web-client/js/__tests__/`
Expected: PASS — all observability suites green.

- [ ] **Step 6: Commit**

```bash
git add crates/web-client/js/index.js crates/web-client/js/__tests__/observability-sensitive.test.js
git commit -m "feat(observability): populate the high-fidelity channel when explicitly enabled"
```

---

### Task 5: `@miden-sdk/telemetry-sentry` binding package

**Files:**
- Create: `packages/telemetry-sentry/package.json`
- Create: `packages/telemetry-sentry/src/index.ts`
- Create: `packages/telemetry-sentry/tsconfig.json`
- Create: `packages/telemetry-sentry/README.md`
- Create: `packages/telemetry-sentry/src/__tests__/index.test.ts`
- Modify: `pnpm-workspace.yaml` (add `packages/telemetry-sentry`)
- Modify: `package.json` (add the package to the `check:publint` and `check:attw` filter lists)
- Modify: `knip.jsonc` (register the new workspace so the unused-export check covers it)

**Interfaces:**
- Consumes: `MidenObservation` from `@miden-sdk/miden-sdk` (Task 3).
- Produces: `createSentryObserver(options)` → `(observation: MidenObservation) => void`.
  `options` is `{ client, minDurationMs?, includeSensitive? }` where `client` is any object with a `captureMessage(message, context)` method (matching Sentry's `BrowserClient`/`Scope` surface). Returns an observer suitable for `ClientOptions.observer`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/telemetry-sentry/src/__tests__/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { createSentryObserver } from "../index";

const fakeClient = () => ({ captureMessage: vi.fn() });

describe("createSentryObserver", () => {
  it("forwards a failed operation", () => {
    const client = fakeClient();
    const observe = createSentryObserver({ client });
    observe({ op: "proveTransaction", outcome: "error", durationMs: 21_000 });
    expect(client.captureMessage).toHaveBeenCalledTimes(1);
    const [message, context] = client.captureMessage.mock.calls[0];
    expect(message).toContain("proveTransaction");
    expect(context.tags.op).toBe("proveTransaction");
    expect(context.tags.outcome).toBe("error");
    expect(context.extra.durationMs).toBe(21_000);
  });

  it("ignores a successful operation below the duration threshold", () => {
    const client = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });
    observe({ op: "syncState", outcome: "ok", durationMs: 12 });
    expect(client.captureMessage).not.toHaveBeenCalled();
  });

  it("forwards a slow successful operation", () => {
    const client = fakeClient();
    const observe = createSentryObserver({ client, minDurationMs: 1_000 });
    observe({ op: "syncState", outcome: "ok", durationMs: 5_000 });
    expect(client.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("drops sensitive detail unless includeSensitive is set", () => {
    const client = fakeClient();
    const observe = createSentryObserver({ client });
    observe({
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      sensitive: { errorMessage: "mtst1secret" },
    });
    const [, context] = client.captureMessage.mock.calls[0];
    expect(JSON.stringify(context)).not.toContain("mtst1secret");
  });

  it("forwards sensitive detail when includeSensitive is set", () => {
    const client = fakeClient();
    const observe = createSentryObserver({ client, includeSensitive: true });
    observe({
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      sensitive: { errorMessage: "mtst1secret" },
    });
    const [, context] = client.captureMessage.mock.calls[0];
    expect(context.extra.errorMessage).toBe("mtst1secret");
  });

  it("never throws when the client throws", () => {
    const client = {
      captureMessage: () => {
        throw new Error("transport down");
      },
    };
    const observe = createSentryObserver({ client });
    expect(() =>
      observe({ op: "syncState", outcome: "error", durationMs: 1 })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/telemetry-sentry`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Create the package manifest**

```json
{
  "name": "@miden-sdk/telemetry-sentry",
  "version": "0.0.0",
  "description": "Opt-in Sentry binding for Miden SDK observations",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test:unit": "vitest run"
  },
  "peerDependencies": {
    "@miden-sdk/miden-sdk": "workspace:*"
  },
  "license": "MIT"
}
```

Note: `@sentry/*` is deliberately **not** a dependency. The binding accepts any object with a `captureMessage` method, so the consumer owns the Sentry version and the SDK never pulls Sentry into anyone's tree.

- [ ] **Step 4: Write the implementation**

```typescript
// packages/telemetry-sentry/src/index.ts
import type { MidenObservation } from "@miden-sdk/miden-sdk";

/** The slice of a Sentry client this binding uses. */
export interface SentryLikeClient {
  captureMessage(
    message: string,
    context: { tags: Record<string, string>; extra: Record<string, unknown> }
  ): unknown;
}

export interface SentryObserverOptions {
  client: SentryLikeClient;
  /**
   * Forward successful operations only when they took at least this long.
   * Failures are always forwarded. Defaults to `Infinity` — failures only.
   */
  minDurationMs?: number;
  /**
   * Forward `observation.sensitive` (account identifiers, verbatim error
   * text) when the SDK supplies it. Defaults to `false`: the field is dropped
   * even if present, so enabling `observeSensitive` on the client does not by
   * itself disclose anything through this binding.
   */
  includeSensitive?: boolean;
}

/**
 * Build an observer for `ClientOptions.observer` that reports Miden SDK
 * operations to a Sentry client.
 */
export function createSentryObserver(
  options: SentryObserverOptions
): (observation: MidenObservation) => void {
  const {
    client,
    minDurationMs = Number.POSITIVE_INFINITY,
    includeSensitive = false,
  } = options;

  return (observation) => {
    try {
      const isFailure = observation.outcome === "error";
      if (!isFailure && observation.durationMs < minDurationMs) return;

      const extra: Record<string, unknown> = {
        durationMs: observation.durationMs,
      };
      if (includeSensitive && observation.sensitive) {
        Object.assign(extra, observation.sensitive);
      }

      client.captureMessage(
        `miden.${observation.op} ${observation.outcome}`,
        {
          tags: { op: observation.op, outcome: observation.outcome },
          extra,
        }
      );
    } catch {
      // A telemetry binding must never fail a client operation.
    }
  };
}
```

- [ ] **Step 5: Create the tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/__tests__"]
}
```

- [ ] **Step 6: Register the workspace**

In `pnpm-workspace.yaml`, add under `packages:`:

```yaml
  - 'packages/telemetry-sentry'
```

In the root `package.json`, add `--filter @miden-sdk/telemetry-sentry` to both the `check:publint` and `check:attw` scripts, matching the existing filter chain.

In `knip.jsonc`, add a workspace entry for `packages/telemetry-sentry` mirroring the shape used for `packages/react-sdk`.

- [ ] **Step 7: Write the README**

```markdown
# @miden-sdk/telemetry-sentry

Opt-in Sentry binding for Miden SDK observations.

`@miden-sdk/miden-sdk` emits observations but never transports them. This
package forwards them to a Sentry client you own and configure.

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";
import { createSentryObserver } from "@miden-sdk/telemetry-sentry";

const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: createSentryObserver({ client: sentryClient, minDurationMs: 5000 }),
});
```

Sentry is a peer concern: this package does not depend on `@sentry/*`. Pass
anything with a `captureMessage(message, { tags, extra })` method.

## Sensitive detail

`sensitive` (account identifiers, verbatim error text) is dropped by default
even when the SDK supplies it. Forwarding it requires **both**
`observeSensitive: true` on the client and `includeSensitive: true` here. Do
not enable either in an application with confidentiality obligations to its
users.
```

- [ ] **Step 8: Install, test, and verify the package surface**

Run: `pnpm install && pnpm vitest run packages/telemetry-sentry && pnpm run check:knip`
Expected: PASS, 6 tests, and knip reports no unused exports.

- [ ] **Step 9: Commit**

```bash
git add packages/telemetry-sentry pnpm-workspace.yaml package.json knip.jsonc pnpm-lock.yaml
git commit -m "feat(telemetry-sentry): add opt-in Sentry binding for SDK observations"
```

---

### Task 6: `@miden-sdk/telemetry-otel` binding package

Same shape as Task 5, emitting OpenTelemetry spans instead. The code is repeated rather than cross-referenced because this task may be implemented independently.

**Files:**
- Create: `packages/telemetry-otel/package.json`
- Create: `packages/telemetry-otel/src/index.ts`
- Create: `packages/telemetry-otel/tsconfig.json`
- Create: `packages/telemetry-otel/README.md`
- Create: `packages/telemetry-otel/src/__tests__/index.test.ts`
- Modify: `pnpm-workspace.yaml`, `package.json`, `knip.jsonc` (same registrations as Task 5)

**Interfaces:**
- Consumes: `MidenObservation` from `@miden-sdk/miden-sdk` (Task 3).
- Produces: `createOtelObserver(options)` → `(observation: MidenObservation) => void`.
  `options` is `{ tracer, includeSensitive? }` where `tracer` has `startSpan(name, opts)` returning an object with `setAttribute`, `setStatus`, and `end`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/telemetry-otel/src/__tests__/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { createOtelObserver } from "../index";

const fakeSpan = () => ({
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
});

const fakeTracer = (span: ReturnType<typeof fakeSpan>) => ({
  startSpan: vi.fn(() => span),
});

describe("createOtelObserver", () => {
  it("starts and ends a span named for the operation", () => {
    const span = fakeSpan();
    const tracer = fakeTracer(span);
    createOtelObserver({ tracer })({
      op: "syncState",
      outcome: "ok",
      durationMs: 30,
    });
    expect(tracer.startSpan).toHaveBeenCalledWith("miden.syncState", {
      startTime: expect.any(Number),
    });
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("records duration as an attribute", () => {
    const span = fakeSpan();
    createOtelObserver({ tracer: fakeTracer(span) })({
      op: "syncState",
      outcome: "ok",
      durationMs: 30,
    });
    expect(span.setAttribute).toHaveBeenCalledWith("miden.duration_ms", 30);
  });

  it("marks a failed operation with an error status", () => {
    const span = fakeSpan();
    createOtelObserver({ tracer: fakeTracer(span) })({
      op: "proveTransaction",
      outcome: "error",
      durationMs: 21_000,
    });
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
  });

  it("drops sensitive detail unless includeSensitive is set", () => {
    const span = fakeSpan();
    createOtelObserver({ tracer: fakeTracer(span) })({
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      sensitive: { errorMessage: "mtst1secret" },
    });
    const written = JSON.stringify(span.setAttribute.mock.calls);
    expect(written).not.toContain("mtst1secret");
  });

  it("forwards sensitive detail when includeSensitive is set", () => {
    const span = fakeSpan();
    createOtelObserver({ tracer: fakeTracer(span), includeSensitive: true })({
      op: "syncState",
      outcome: "error",
      durationMs: 1,
      sensitive: { errorMessage: "mtst1secret" },
    });
    expect(span.setAttribute).toHaveBeenCalledWith(
      "miden.error_message",
      "mtst1secret"
    );
  });

  it("never throws when the tracer throws", () => {
    const tracer = {
      startSpan: () => {
        throw new Error("no tracer provider");
      },
    };
    expect(() =>
      createOtelObserver({ tracer })({
        op: "syncState",
        outcome: "ok",
        durationMs: 1,
      })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/telemetry-otel`
Expected: FAIL — the package does not exist.

- [ ] **Step 3: Create the package manifest**

```json
{
  "name": "@miden-sdk/telemetry-otel",
  "version": "0.0.0",
  "description": "Opt-in OpenTelemetry binding for Miden SDK observations",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test:unit": "vitest run"
  },
  "peerDependencies": {
    "@miden-sdk/miden-sdk": "workspace:*"
  },
  "license": "MIT"
}
```

`@opentelemetry/*` is deliberately **not** a dependency — the binding accepts any tracer-shaped object, so the consumer owns the OTel version.

- [ ] **Step 4: Write the implementation**

```typescript
// packages/telemetry-otel/src/index.ts
import type { MidenObservation } from "@miden-sdk/miden-sdk";

/** The slice of an OpenTelemetry span this binding uses. */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number }): unknown;
  end(): unknown;
}

/** The slice of an OpenTelemetry tracer this binding uses. */
export interface TracerLike {
  startSpan(name: string, options: { startTime: number }): SpanLike;
}

export interface OtelObserverOptions {
  tracer: TracerLike;
  /**
   * Forward `observation.sensitive` (account identifiers, verbatim error
   * text) when the SDK supplies it. Defaults to `false`: the field is dropped
   * even if present.
   */
  includeSensitive?: boolean;
}

/** OpenTelemetry `SpanStatusCode.ERROR`, inlined to avoid the dependency. */
const SPAN_STATUS_ERROR = 2;

/**
 * Build an observer for `ClientOptions.observer` that records Miden SDK
 * operations as OpenTelemetry spans.
 *
 * The span is created retroactively: the SDK reports an operation after it
 * completes, so the span is started at `now - durationMs` and ended
 * immediately, which reproduces the real interval.
 */
export function createOtelObserver(
  options: OtelObserverOptions
): (observation: MidenObservation) => void {
  const { tracer, includeSensitive = false } = options;

  return (observation) => {
    try {
      const span = tracer.startSpan(`miden.${observation.op}`, {
        startTime: Date.now() - observation.durationMs,
      });
      span.setAttribute("miden.duration_ms", observation.durationMs);
      span.setAttribute("miden.outcome", observation.outcome);
      if (observation.outcome === "error") {
        span.setStatus({ code: SPAN_STATUS_ERROR });
      }
      if (includeSensitive && observation.sensitive) {
        const { errorMessage, errorStack, accountId } = observation.sensitive;
        if (errorMessage) span.setAttribute("miden.error_message", errorMessage);
        if (errorStack) span.setAttribute("miden.error_stack", errorStack);
        if (accountId) span.setAttribute("miden.account_id", accountId);
      }
      span.end();
    } catch {
      // A telemetry binding must never fail a client operation.
    }
  };
}
```

- [ ] **Step 5: Create the tsconfig**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/__tests__"]
}
```

- [ ] **Step 6: Register the workspace**

In `pnpm-workspace.yaml`, add under `packages:`:

```yaml
  - 'packages/telemetry-otel'
```

Add `--filter @miden-sdk/telemetry-otel` to the root `package.json` `check:publint` and `check:attw` scripts, and add a `knip.jsonc` workspace entry mirroring `packages/react-sdk`.

- [ ] **Step 7: Write the README**

```markdown
# @miden-sdk/telemetry-otel

Opt-in OpenTelemetry binding for Miden SDK observations.

```ts
import { MidenClient } from "@miden-sdk/miden-sdk";
import { createOtelObserver } from "@miden-sdk/telemetry-otel";

const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: createOtelObserver({ tracer: trace.getTracer("my-app") }),
});
```

OpenTelemetry is a peer concern: this package does not depend on
`@opentelemetry/*`. Pass anything with a `startSpan(name, { startTime })`
method.

Spans are created retroactively — the SDK reports an operation once it has
finished, so the span is backdated by its duration.

## Sensitive detail

`sensitive` is dropped by default. Forwarding it requires **both**
`observeSensitive: true` on the client and `includeSensitive: true` here.
```

- [ ] **Step 8: Install, test, and verify**

Run: `pnpm install && pnpm vitest run packages/telemetry-otel && pnpm run check:knip && pnpm run check:publish`
Expected: PASS, 6 tests; publint and attw clean for all five published packages.

- [ ] **Step 9: Commit**

```bash
git add packages/telemetry-otel pnpm-workspace.yaml package.json knip.jsonc pnpm-lock.yaml
git commit -m "feat(telemetry-otel): add opt-in OpenTelemetry binding for SDK observations"
```

---

### Task 7: Guard the core against telemetry dependencies

The wallet's privacy claim rests on the core being incapable of egress. Make that a CI gate rather than a convention.

**Files:**
- Create: `crates/web-client/js/__tests__/no-telemetry-dependency.test.js`

**Interfaces:**
- Consumes: `crates/web-client/package.json`.
- Produces: no exports — a standing assertion.

- [ ] **Step 1: Write the test**

```javascript
// crates/web-client/js/__tests__/no-telemetry-dependency.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8"
  )
);

const FORBIDDEN = ["@sentry/", "@opentelemetry/", "posthog", "mixpanel", "@amplitude/", "@segment/"];

describe("core SDK carries no telemetry dependency", () => {
  it("declares none in any dependency field", () => {
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    });
    const offenders = declared.filter((name) =>
      FORBIDDEN.some((prefix) => name.startsWith(prefix) || name.includes(prefix))
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm vitest run crates/web-client/js/__tests__/no-telemetry-dependency.test.js`
Expected: PASS. It should pass immediately — this locks in the current state rather than fixing a violation.

- [ ] **Step 3: Verify the guard actually catches a violation**

A guard that can't fail is worthless. Temporarily add `"@sentry/browser": "^8.0.0"` to `crates/web-client/package.json` `dependencies`, re-run the test, confirm it FAILS naming `@sentry/browser`, then revert the manifest.

Run: `pnpm vitest run crates/web-client/js/__tests__/no-telemetry-dependency.test.js`
Expected: FAIL while the line is present, PASS after reverting. Confirm `git diff crates/web-client/package.json` is empty before continuing.

- [ ] **Step 4: Commit**

```bash
git add crates/web-client/js/__tests__/no-telemetry-dependency.test.js
git commit -m "test(observability): assert the core SDK carries no telemetry dependency"
```

---

### Task 8: Document the interface and publish

**Files:**
- Modify: `crates/web-client/README.md` (add an Observability section)
- Modify: `CHANGELOG.md` (root — add the entry under the next unreleased version)
- Modify: `crates/web-client/package.json` (version bump)

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: a published `@miden-sdk/miden-sdk` version plus two new published packages, which the wallet plan pins.

- [ ] **Step 1: Add the README section**

Append to `crates/web-client/README.md`:

```markdown
## Observability

The client emits one observation per operation — name, outcome, duration —
through a sink you register at construction:

```ts
const client = await MidenClient.create({
  rpcUrl: "testnet",
  observer: (o) => console.log(o.op, o.outcome, o.durationMs),
});
```

The SDK never transports observations. It has no telemetry dependency and no
network capability in this path, which is enforced by a test. Forward them
yourself, or use an opt-in binding: `@miden-sdk/telemetry-sentry`,
`@miden-sdk/telemetry-otel`.

A throwing observer is swallowed and can never fail a client operation.
Observers are called synchronously and do not change an operation's timing.

### Sensitive detail

By default the `sensitive` key is **absent** from every observation — test with
`"sensitive" in observation`. Passing `observeSensitive: true` at construction
populates it with account identifiers and verbatim error text, and logs a
one-time console warning.

Leave it unset in any application with confidentiality obligations to its
users. A wallet, for example, must never enable it.
```

- [ ] **Step 2: Verify the documented example type-checks**

Run: `pnpm run build:web-client && pnpm run typedoc`
Expected: PASS, and the new `MidenObservation` / `MidenObservationSensitive`
types appear in the generated docs.

- [ ] **Step 3: Bump the version and add the changelog entry**

Bump the `version` in `crates/web-client/package.json` by one minor (this is an additive, backward-compatible API). Set both new binding packages to the same version. Add one `CHANGELOG.md` entry describing the observability interface and the two binding packages.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm run check:publish && node scripts/check-method-classification.js && pnpm run check:knip`
Expected: all PASS.

- [ ] **Step 5: Commit and open the PR**

```bash
git add crates/web-client/README.md crates/web-client/package.json packages/telemetry-sentry/package.json packages/telemetry-otel/package.json CHANGELOG.md
git commit -m "docs(observability): document the observation interface and bump for release"
```

Open the PR against `0xMiden/web-sdk`. **Record the PR number** — the wallet PR needs the verbatim marker `Web SDK PR: #N` on its own line, or the linked-PR CI pipeline does not trigger.

---

## Self-Review

**Spec coverage.** Every "Web SDK observability" requirement in the spec maps to a task: the neutral emission interface (Tasks 1-2), the `ClientOptions` surface and opt-in flag with its one-time warning (Task 3), the absent-when-off high-fidelity channel (Task 4), the two binding packages with vendors as peers (Tasks 5-6), the no-telemetry-dependency guarantee as a test (Task 7), and documentation plus the release the wallet pins (Task 8). The synchronous / never-throws / no-op-when-unsubscribed contracts are covered by Task 1's tests and re-asserted per binding.

**Two spec items are deliberately out of this plan.** The wallet-side `resolve.dedupe` re-verification after the version bump, and `prove-telemetry.ts` becoming a consumer, both live in the wallet repo and belong to the wallet plan.

**One spec item is knowingly narrowed.** The spec mentions prove path and fallback as SDK-internal facts worth surfacing. This plan emits observations for `proveTransaction` as a whole, but does not decompose delegate-versus-local-versus-native or the fallback flag, because that logic lives in `js/resources/transactions.js` `prove()` and the Rust prover selection, and reaching it is a materially larger change than the choke-point hook. The interface added here is the right shape to carry it — a follow-on can add `sensitive`-free fields to the observation without a breaking change. Flagged rather than silently dropped.

**Type consistency.** `setObserver` / `emitObservation` / `hasObserver` / `__resetObserverForTest` are used with consistent signatures in Tasks 1-4. `_serializeWasmCall(fn, opName, observabilityConfig)` reaches its final three-parameter form in Task 4 and the Task 2 test seam is updated there rather than left stale. `MidenObservation` and `MidenObservationSensitive` are defined once in Task 3 and imported by both bindings. Both bindings expose `includeSensitive` with identical default and meaning.

**Placeholder scan.** No TBDs, and every code step carries the actual content. Task 7 Step 3 deliberately instructs a temporary edit and its revert, which is a verification procedure rather than a placeholder.
