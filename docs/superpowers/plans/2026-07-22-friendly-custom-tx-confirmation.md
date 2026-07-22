# Human-readable custom-transaction & signature confirmation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wallet's custom-transaction confirm screen show a wallet-derived, human-readable asset-change summary (instant declared decode → ground-truth `executeForSummary` verification), and make truly-opaque signature requests visually distinct with a blind-sign warning.

**Architecture:** Purely `miden-wallet` (extension). The background gains a dry-run `simulateCustomTransaction` (import notes locally → sync → `executeForSummary`, no prove/submit) reached from the open confirm popup via a new `DAppSimulateTransactionRequest` intercom round-trip threaded through `requestConfirm`. The confirm UI decodes the request bytes client-side for an instant "declared" paint, then swaps in the verified `TransactionSummary` delta. Decode logic (SDK bytes → plain view-model) is split from rendering so both paths share one `<TransactionAssetView>` and everything is unit-testable behind the jest SDK mock.

**Tech Stack:** TypeScript, React 18, `@miden-sdk/miden-sdk@0.15.2` (WASM, imported via the `/lazy` subpath), `@openzeppelin/miden-multisig-client` (`executeForSummary`), jest + `@testing-library/react` + `@swc/jest`, Chrome-extension i18n (`t()` + `public/_locales/en/messages.json`).

## Global Constraints

- **Repo / branch:** work in the worktree `/Users/celrisen/miden/miden-wallet/.claude/worktrees/friendly-custom-tx-confirmation` on branch `feat/friendly-custom-tx-confirmation` (off `origin/main`). Run all commands from that worktree root.
- **Coverage gate: 95%** on branches / functions / lines / statements (`jest.config.ts` `coverageThreshold.global`). `collectCoverageFrom: src/**/*.{ts,tsx}` — every NEW `src` file counts; an untested new file reports 0% and fails the gate. Every task that adds a `src` file adds its test in the same task.
- **CI gates (`.github/workflows/pr.yml`, `changelog.yml`):** ESLint, `tsc`, jest unit tests, 95% coverage, `yarn lint:i18n` (no non-i18n'd JSX string literals), Playwright E2E, and `scripts/check-changelog.sh` (a `CHANGELOG.md` change is required). Node 22.
- **i18n:** add new copy ONLY to `public/_locales/en/messages.json` (entry shape `{ "message": "...", "englishSource": "..." }`). CI's "Update Translation Files" job auto-generates and commits the other 13 locales — do NOT hand-edit them.
- **SDK in jest:** `@miden-sdk/miden-sdk` (+ `/lazy`, `/mt`, `/mt/lazy`) is module-mapped to `__mocks__/wasmMock.js`. That mock lacks most members, so tests that use SDK statics MUST add a per-file `jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ ... }))` providing exactly the surface used — follow the existing pattern at the top of `src/app/ConfirmPage.test.tsx`. `@openzeppelin/miden-multisig-client` is mapped to a mock that already exports `executeForSummary = jest.fn()`.
- **Wire contract is stable:** the `MidenTransaction.type` string values `'send' | 'consume' | 'custom'` and message-type string enums are the dApp↔wallet contract — do not rename.
- **`preview: any` stays.** The spec noted it as dead; removing it touches 8 unrelated call sites. This plan leaves it untouched (deferred cleanup) and only ADDS fields.
- **Never trust dApp-supplied descriptions.** The recipient string is shown only as "declared by site"; the authoritative asset view comes from `executeForSummary`.
- Commit after each task with the message shown in its final step.

## File Structure

**New:**
- `src/lib/miden/back/simulate-custom-tx.ts` — `simulateCustomTransaction(input): Promise<SimulateCustomTxResult>` dry-run (import→sync→executeForSummary). + test.
- `src/app/confirm/decode.ts` — pure SDK-bytes → `TxAssetView` decoders (`summaryToView`, `summaryBytesToView`, `declaredRequestToView`). + test.
- `src/app/confirm/TransactionAssetView.tsx` — renders a `TxAssetView` (verified or declared mode) with token metadata. + test.
- `src/app/confirm/AdvancedDetails.tsx` — collapsible raw-details disclosure. + test.

**Modified:**
- `src/lib/miden/types.ts` — extend `MidenDAppTransactionPayload`; add simulate message enum members + interfaces + union registration.
- `src/lib/store/index.ts`, `src/lib/store/types.ts`, `src/lib/miden/front/client.ts` — `simulateCustomTransaction(id)` transport.
- `src/lib/miden/back/dapp.ts` — custom-tx payload gains decode fields; `requestConfirm` gains `handleSimulate`; custom flow wires it to `simulateCustomTransaction`.
- `src/app/ConfirmPage.tsx` — custom-tx state machine + opaque-sign warnings; extract `TransactionAssetView` usage.
- `public/_locales/en/messages.json` — new keys.
- `CHANGELOG.md` — entry.

---

### Task 1: Types & message plumbing

**Files:**
- Modify: `src/lib/miden/types.ts` (payload interface ~66-70; enum ~138-163; message interfaces ~208-217; `MidenRequest` ~165-179; `MidenResponse` ~181-191)

**Interfaces:**
- Produces: extended `MidenDAppTransactionPayload` with optional `txKind`, `requestBytes`, `importNotes`, `recipientAddress`, `decodeStatus`; new `MidenMessageType.DAppSimulateTransactionRequest/Response`; new `MidenDAppSimulateTransactionRequest { type; id: string }` and `MidenDAppSimulateTransactionResponse { type; summaryBytes?: string; error?: string }`, both registered in the request/response unions.

- [ ] **Step 1: Extend `MidenDAppTransactionPayload`.** Replace the interface (currently at `src/lib/miden/types.ts:66-70`) with:

```ts
export interface MidenDAppTransactionPayload extends MidenDAppPayloadBase {
  type: 'transaction';
  sourcePublicKey: string;
  preview: any;
  transactionMessages: string[];
  // Custom-transaction decode support. Undefined for the `send` sub-flow, which
  // keeps rendering via `transactionMessages`. For `custom`, the confirm UI
  // decodes `requestBytes` client-side for an instant "declared" view, then
  // requests a verified summary via `simulateCustomTransaction`.
  txKind?: 'send' | 'custom';
  requestBytes?: string; // base64 serialized Miden-SDK TransactionRequest
  importNotes?: string[]; // base64 serialized notes carried by the request
  recipientAddress?: string; // dApp-declared recipient (shown as "declared by site")
  decodeStatus?: 'declared' | 'undecodable';
}
```

- [ ] **Step 2: Add enum members.** In the `MidenMessageType` enum (`src/lib/miden/types.ts`), after `DAppConsumableNotesConfirmationResponse` (line ~162), add:

```ts
  ,
  DAppSimulateTransactionRequest = 'MIDEN_DAPP_SIMULATE_TRANSACTION_REQUEST',
  DAppSimulateTransactionResponse = 'MIDEN_DAPP_SIMULATE_TRANSACTION_RESPONSE'
```

(Ensure the preceding member keeps/gets its trailing comma; add the two new members as the last entries.)

- [ ] **Step 3: Add message interfaces.** After `MidenDAppGetPayloadResponse` (ends ~line 217), add:

```ts
export interface MidenDAppSimulateTransactionRequest extends WalletMessageBase {
  type: MidenMessageType.DAppSimulateTransactionRequest;
  id: string;
}

export interface MidenDAppSimulateTransactionResponse extends WalletMessageBase {
  type: MidenMessageType.DAppSimulateTransactionResponse;
  summaryBytes?: string; // base64 serialized TransactionSummary
  error?: string;
}
```

- [ ] **Step 4: Register in the unions.** In `MidenRequest` (the `| Miden...Request` union) add `  | MidenDAppSimulateTransactionRequest`, and in `MidenResponse` add `  | MidenDAppSimulateTransactionResponse`.

- [ ] **Step 5: Verify types compile.**

Run: `yarn tsc --noEmit`
Expected: PASS (no new errors). If `tsc` isn't a bare script, use `yarn typecheck` or `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/miden/types.ts
git commit -m "feat(confirm): add custom-tx decode fields + simulate message types"
```

---

### Task 2: Background dry-run — `simulate-custom-tx.ts`

**Files:**
- Create: `src/lib/miden/back/simulate-custom-tx.ts`
- Test: `src/lib/miden/back/simulate-custom-tx.test.ts`

**Interfaces:**
- Consumes: `getMidenClient`, `withWasmClientLock` from `lib/miden/sdk/miden-client`; `accountIdStringToSdk` from `lib/miden/sdk/helpers`; `executeForSummary` from `@openzeppelin/miden-multisig-client`; `TransactionRequest` from `@miden-sdk/miden-sdk/lazy`; `b64ToU8`, `u8ToB64` from `lib/shared/helpers`. `getMidenClient()` resolves a `MidenClientInterface` with `.client` (raw WebClient), `.importNoteBytes(Uint8Array)`, `.syncState()`.
- Produces: `simulateCustomTransaction(input: SimulateCustomTxInput): Promise<SimulateCustomTxResult>` where `SimulateCustomTxInput = { address: string; transactionRequest: string; importNotes?: string[] }` and `SimulateCustomTxResult = { summaryBytes?: string; error?: string }`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/miden/back/simulate-custom-tx.test.ts`:

```ts
const importNoteBytes = jest.fn(async () => 'noteid');
const syncState = jest.fn(async () => undefined);
const fakeClient = {};

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(async () => ({ client: fakeClient, importNoteBytes, syncState })),
  withWasmClientLock: jest.fn((fn: any) => fn())
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: jest.fn((s: string) => ({ __accountId: s }))
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn((bytes: Uint8Array) => ({ __req: bytes })) }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  executeForSummary: jest.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) }))
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length])),
  u8ToB64: jest.fn((u: Uint8Array) => `b64:${Array.from(u).join('-')}`)
}));

import { executeForSummary } from '@openzeppelin/miden-multisig-client';
import { simulateCustomTransaction } from './simulate-custom-tx';

describe('simulateCustomTransaction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('imports notes, syncs, executes for summary and returns serialized summary', async () => {
    const res = await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importNoteBytes).toHaveBeenCalledTimes(2);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(executeForSummary).toHaveBeenCalledWith(fakeClient, { __accountId: 'mtst1abc' }, { __req: expect.any(Uint8Array) });
    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
  });

  it('tolerates a missing importNotes list', async () => {
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importNoteBytes).not.toHaveBeenCalled();
    expect(res.summaryBytes).toBe('b64:1-2-3');
  });

  it('returns { error } when execution throws, without rethrowing', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(new Error('note not found'));
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toEqual({ error: 'note not found' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/lib/miden/back/simulate-custom-tx.test.ts`
Expected: FAIL — `Cannot find module './simulate-custom-tx'`.

- [ ] **Step 3: Write the implementation.** Create `src/lib/miden/back/simulate-custom-tx.ts`:

```ts
import { executeForSummary } from '@openzeppelin/miden-multisig-client';
import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

export interface SimulateCustomTxInput {
  /** Bech32 sending account address (the custom-tx `address` field). */
  address: string;
  /** Base64 serialized Miden-SDK TransactionRequest. */
  transactionRequest: string;
  /** Base64 serialized notes the request consumes (imported locally to simulate). */
  importNotes?: string[];
}

export interface SimulateCustomTxResult {
  /** Base64 serialized TransactionSummary when the dry run succeeded. */
  summaryBytes?: string;
  /** Human-oriented error message when the dry run could not be produced. */
  error?: string;
}

/**
 * Locally executes a custom transaction to derive its ground-truth
 * TransactionSummary WITHOUT proving or submitting — a dry run. Imports the
 * request's carried notes and syncs first so execution can resolve its inputs.
 * All WASM work runs inside a single `withWasmClientLock` scope (the client is
 * single-threaded). Never throws: failures are returned as `{ error }` so the
 * confirm UI can fall back to the declared view.
 */
export async function simulateCustomTransaction(input: SimulateCustomTxInput): Promise<SimulateCustomTxResult> {
  try {
    return await withWasmClientLock(async () => {
      const client = await getMidenClient();

      for (const noteB64 of input.importNotes ?? []) {
        await client.importNoteBytes(b64ToU8(noteB64));
      }
      await client.syncState();

      const accountId = accountIdStringToSdk(input.address);
      const request = TransactionRequest.deserialize(b64ToU8(input.transactionRequest));
      const summary = await executeForSummary(client.client, accountId, request);

      return { summaryBytes: u8ToB64(summary.serialize()) };
    });
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `yarn jest src/lib/miden/back/simulate-custom-tx.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/miden/back/simulate-custom-tx.ts src/lib/miden/back/simulate-custom-tx.test.ts
git commit -m "feat(confirm): background dry-run simulateCustomTransaction (executeForSummary)"
```

---

### Task 3: Store transport — `simulateCustomTransaction(id)`

**Files:**
- Modify: `src/lib/store/index.ts` (add store action next to `getDAppPayload` ~421-428; `request`/`assertResponse` helpers at 26-39)
- Modify: `src/lib/store/types.ts` (next to `getDAppPayload` at ~170)
- Modify: `src/lib/miden/front/client.ts` (bind ~70, `useCallback` ~240, expose in context ~380)
- Test: `src/lib/store/simulate-custom-tx.store.test.ts`

**Interfaces:**
- Consumes: message types from Task 1; the `request()` intercom helper in `src/lib/store/index.ts`.
- Produces: store method `simulateCustomTransaction(id: string): Promise<{ summaryBytes?: string; error?: string }>`, exposed on the Miden context object returned by `useMidenContext()`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/store/simulate-custom-tx.store.test.ts`:

```ts
const intercomRequest = jest.fn();
jest.mock('lib/intercom/client', () => ({
  getIntercom: () => ({ request: intercomRequest })
}));

import { MidenMessageType } from 'lib/miden/types';
import { useWalletStore } from 'lib/store';

describe('store.simulateCustomTransaction', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends a simulate request and returns { summaryBytes }', async () => {
    intercomRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      summaryBytes: 'sumB64'
    });
    const out = await useWalletStore.getState().simulateCustomTransaction('confirm-id-1');
    expect(intercomRequest).toHaveBeenCalledWith({
      type: MidenMessageType.DAppSimulateTransactionRequest,
      id: 'confirm-id-1'
    });
    expect(out).toEqual({ summaryBytes: 'sumB64', error: undefined });
  });

  it('passes through an { error }', async () => {
    intercomRequest.mockResolvedValueOnce({
      type: MidenMessageType.DAppSimulateTransactionResponse,
      error: 'sim failed'
    });
    const out = await useWalletStore.getState().simulateCustomTransaction('id');
    expect(out).toEqual({ summaryBytes: undefined, error: 'sim failed' });
  });
});
```

> If the real intercom module path differs, match the import path used by the other `src/lib/store/*.test.ts` files (grep for `jest.mock('lib/intercom` in the repo) — the mechanism is: mock the intercom client so `request()` resolves your response.

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/lib/store/simulate-custom-tx.store.test.ts`
Expected: FAIL — `simulateCustomTransaction is not a function`.

- [ ] **Step 3: Add the store action.** In `src/lib/store/index.ts`, immediately after the `getDAppPayload` action (ends ~line 428), add:

```ts
    simulateCustomTransaction: async (id: string) => {
      const res = await request({
        type: MidenMessageType.DAppSimulateTransactionRequest,
        id
      });
      assertResponse(res.type === MidenMessageType.DAppSimulateTransactionResponse);
      return { summaryBytes: res.summaryBytes, error: res.error };
    },
```

- [ ] **Step 4: Add the store-type signature.** In `src/lib/store/types.ts`, after `getDAppPayload` (~line 170):

```ts
  simulateCustomTransaction: (id: string) => Promise<{ summaryBytes?: string; error?: string }>;
```

- [ ] **Step 5: Expose on the Miden context.** In `src/lib/miden/front/client.ts`: after the `storeGetDAppPayload` bind (line ~70) add `const storeSimulateCustomTransaction = useWalletStore(s => s.simulateCustomTransaction);`; after the `getDAppPayload` `useCallback` (~240) add:

```ts
  const simulateCustomTransaction = useCallback(
    async (id: string) => {
      return storeSimulateCustomTransaction(id);
    },
    [storeSimulateCustomTransaction]
  );
```

and in the returned context object (near `getDAppPayload,` at ~line 380) add `    simulateCustomTransaction,`.

- [ ] **Step 6: Run the test to verify it passes.**

Run: `yarn jest src/lib/store/simulate-custom-tx.store.test.ts`
Expected: PASS (2 tests). Then `yarn tsc --noEmit` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/store/index.ts src/lib/store/types.ts src/lib/miden/front/client.ts src/lib/store/simulate-custom-tx.store.test.ts
git commit -m "feat(confirm): simulateCustomTransaction store + context transport"
```

---

### Task 4: `requestConfirm` handleSimulate + custom-tx payload wiring

**Files:**
- Modify: `src/lib/miden/back/dapp.ts` (`RequestConfirmParams` 1467-1472; `requestConfirm` intercom closure 1500-1517; custom flow payload 1093-1103; custom flow closure scope ~1024-1142)
- Test: `src/lib/miden/back/dapp.simulate-wiring.test.ts`

**Interfaces:**
- Consumes: `simulateCustomTransaction` (Task 2); `MidenMessageType.DAppSimulateTransaction*` (Task 1).
- Produces: `RequestConfirmParams` gains optional `handleSimulate?: (req: MidenRequest) => Promise<any>`; `requestConfirm` answers `DAppSimulateTransactionRequest` (matched by `req.id === id`) via `handleSimulate` WITHOUT closing the window; the custom-tx confirm payload carries `txKind: 'custom'`, `requestBytes`, `importNotes`, `recipientAddress`, `decodeStatus: 'declared'`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/miden/back/dapp.simulate-wiring.test.ts`. This unit-tests the pure helper that builds the custom-tx confirm payload and the simulate handler, which Step 3 extracts so they are testable without the popup/browser machinery:

```ts
jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: jest.fn(async () => ({ summaryBytes: 'sumB64' }))
}));

import { MidenMessageType } from 'lib/miden/types';

import { buildCustomTxConfirmPayload, makeSimulateHandler } from './dapp';
import { simulateCustomTransaction } from './simulate-custom-tx';

const customTx = {
  address: 'mtst1sender',
  recipientAddress: 'mtst1recipient',
  transactionRequest: 'reqB64',
  inputNoteIds: ['n1'],
  importNotes: ['noteB64']
};

describe('buildCustomTxConfirmPayload', () => {
  it('carries the raw material + declared status, not just messages', () => {
    const p = buildCustomTxConfirmPayload({
      origin: 'https://dapp.test',
      networkRpc: 'rpc',
      appMeta: { name: 'DApp' },
      sourcePublicKey: 'pk',
      transactionMessages: ['a', 'b'],
      customTransaction: customTx as any
    });
    expect(p).toMatchObject({
      type: 'transaction',
      txKind: 'custom',
      requestBytes: 'reqB64',
      importNotes: ['noteB64'],
      recipientAddress: 'mtst1recipient',
      decodeStatus: 'declared'
    });
  });
});

describe('makeSimulateHandler', () => {
  it('responds to a matching simulate request with the summary, no throw', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'confirm-id' } as any);
    expect(simulateCustomTransaction).toHaveBeenCalledWith({
      address: 'mtst1sender',
      transactionRequest: 'reqB64',
      importNotes: ['noteB64']
    });
    expect(out).toEqual({ type: MidenMessageType.DAppSimulateTransactionResponse, summaryBytes: 'sumB64', error: undefined });
  });

  it('ignores a simulate request for a different id', async () => {
    const handler = makeSimulateHandler('confirm-id', customTx as any);
    const out = await handler({ type: MidenMessageType.DAppSimulateTransactionRequest, id: 'other' } as any);
    expect(out).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/lib/miden/back/dapp.simulate-wiring.test.ts`
Expected: FAIL — `buildCustomTxConfirmPayload`/`makeSimulateHandler` are not exported.

- [ ] **Step 3: Add the two exported helpers to `dapp.ts`.** Add the import near the other back imports: `import { simulateCustomTransaction } from './simulate-custom-tx';`. Then add (place them just above `generatePromisifyTransaction`, ~line 977):

```ts
export function buildCustomTxConfirmPayload(args: {
  origin: string;
  networkRpc: string;
  appMeta: DappMetadata;
  sourcePublicKey: string;
  transactionMessages: string[];
  customTransaction: MidenCustomTransaction;
}): MidenDAppTransactionPayload {
  const { customTransaction: tx } = args;
  return {
    type: 'transaction',
    origin: args.origin,
    networkRpc: args.networkRpc,
    appMeta: args.appMeta,
    sourcePublicKey: args.sourcePublicKey,
    transactionMessages: args.transactionMessages,
    preview: null,
    txKind: 'custom',
    requestBytes: tx.transactionRequest,
    importNotes: tx.importNotes,
    recipientAddress: tx.recipientAddress || undefined,
    decodeStatus: 'declared'
  };
}

/**
 * Builds the intercom handler that answers a `DAppSimulateTransactionRequest`
 * for THIS confirm popup (matched by id) with the ground-truth summary. Returns
 * `undefined` for non-matching requests so the caller keeps dispatching.
 */
export function makeSimulateHandler(id: string, tx: MidenCustomTransaction) {
  return async (req: MidenRequest): Promise<any | undefined> => {
    if (req?.type !== MidenMessageType.DAppSimulateTransactionRequest || (req as any).id !== id) {
      return undefined;
    }
    const { summaryBytes, error } = await simulateCustomTransaction({
      address: tx.address,
      transactionRequest: tx.transactionRequest,
      importNotes: tx.importNotes
    });
    return { type: MidenMessageType.DAppSimulateTransactionResponse, summaryBytes, error };
  };
}
```

- [ ] **Step 4: Use the payload builder + thread `handleSimulate`.** In `generatePromisifyTransaction`'s extension branch, replace the inline `payload: { ... }` object passed to `requestConfirm` (dapp.ts:1095-1103) with a call to the builder, and pass `handleSimulate`. The custom transaction is destructured once for scope:

```ts
  const customTransaction = req.transaction.payload as MidenCustomTransaction;

  await requestConfirm({
    id,
    payload: buildCustomTxConfirmPayload({
      origin,
      networkRpc,
      appMeta: dApp.appMeta,
      sourcePublicKey: req.sourcePublicKey,
      transactionMessages,
      customTransaction
    }),
    handleSimulate: makeSimulateHandler(id, customTransaction),
    onDecline: () => {
      reject(new Error(MidenDAppErrorType.NotGranted));
    },
    handleIntercomRequest: async (confirmReq, decline) => {
      /* unchanged body from lines 1108-1141 */
    }
  });
```

(Keep the existing `handleIntercomRequest` body exactly as-is.)

- [ ] **Step 5: Add `handleSimulate` to `requestConfirm`.** In `src/lib/miden/back/dapp.ts`, extend `RequestConfirmParams` (1467-1472):

```ts
type RequestConfirmParams = {
  id: string;
  payload: MidenDAppPayload;
  onDecline: () => void;
  handleIntercomRequest: (req: MidenRequest, decline: () => void) => Promise<any>;
  handleSimulate?: (req: MidenRequest) => Promise<any>;
};
```

Update the destructure (line 1474) to `async function requestConfirm({ id, payload, onDecline, handleIntercomRequest, handleSimulate }: RequestConfirmParams) {`. Then, inside the `intercom.onRequest` closure (1500-1517), add a branch after the `DAppGetPayloadRequest` branch and BEFORE the `else`:

```ts
    if (req?.type === MidenMessageType.DAppSimulateTransactionRequest && (req as any).id === id) {
      knownPort = port;
      if (!handleSimulate) {
        return { type: MidenMessageType.DAppSimulateTransactionResponse, error: 'unsupported' };
      }
      return await handleSimulate(req); // must NOT close() — the popup stays open
    }
```

Restructure so the three branches are sequential `if`s (payload → simulate → default), and the default (`handleIntercomRequest` + `close()`) stays in a final `else`/fallthrough guarded by `if (knownPort !== port) return;`.

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `yarn jest src/lib/miden/back/dapp.simulate-wiring.test.ts src/lib/miden/back/dapp.confirm-internals.test.ts`
Expected: PASS (new wiring tests + the existing confirm-internals suite still green). Then `yarn tsc --noEmit` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/miden/back/dapp.ts src/lib/miden/back/dapp.simulate-wiring.test.ts
git commit -m "feat(confirm): thread simulate handler through requestConfirm; carry custom-tx bytes"
```

---

### Task 5: Client-side decode helpers — `decode.ts`

**Files:**
- Create: `src/app/confirm/decode.ts`
- Test: `src/app/confirm/decode.test.ts`

**Interfaces:**
- Consumes: `TransactionRequest`, `TransactionSummary`, `Note` from `@miden-sdk/miden-sdk/lazy`; `getBech32AddressFromAccountId` from `lib/miden/sdk/helpers`; `b64ToU8` from `lib/shared/helpers`.
- Produces:
  - `interface AssetAmount { faucetId: string; amount: bigint }`
  - `interface TxAssetView { account?: string; outgoing: AssetAmount[]; incoming: AssetAmount[]; inputNotesConsumed: number; outputNotesCreated: number; storageChanged: boolean }`
  - `summaryToView(ts: TransactionSummary): TxAssetView`
  - `summaryBytesToView(summaryB64: string): TxAssetView`
  - `declaredRequestToView(requestB64: string, importNotes?: string[]): TxAssetView`

- [ ] **Step 1: Write the failing test.** Create `src/app/confirm/decode.test.ts`:

```ts
const fa = (faucetId: string, amount: bigint) => ({
  faucetId: () => ({ toString: () => faucetId }),
  amount: () => amount
});
const note = (assets: any[]) => ({ assets: () => ({ fungibleAssets: () => assets }) });

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn() },
  TransactionSummary: { deserialize: jest.fn() },
  Note: { deserialize: jest.fn() }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn(() => 'mtst1account')
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length]))
}));

import { Note, TransactionRequest, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { declaredRequestToView, summaryToView } from './decode';

describe('summaryToView', () => {
  it('maps a TransactionSummary account delta to outgoing/incoming + note counts', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [fa('fA', 10n)], addedFungibleAssets: () => [fa('fB', 3n)] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      outputNotes: () => ({ numNotes: () => 2 })
    };
    expect(summaryToView(ts as any)).toEqual({
      account: 'mtst1account',
      outgoing: [{ faucetId: 'fA', amount: 10n }],
      incoming: [{ faucetId: 'fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: false
    });
  });
});

describe('declaredRequestToView', () => {
  it('derives outgoing from expected output notes and incoming from imported notes', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({
      expectedOutputOwnNotes: () => [note([fa('fA', 10n)])]
    });
    (Note.deserialize as jest.Mock).mockReturnValueOnce(note([fa('fB', 3n)]));

    const view = declaredRequestToView('reqB64', ['imported']);
    expect(view).toEqual({
      account: undefined,
      outgoing: [{ faucetId: 'fA', amount: 10n }],
      incoming: [{ faucetId: 'fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 1,
      storageChanged: false
    });
  });

  it('handles a request with no output/imported notes', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({ expectedOutputOwnNotes: () => [] });
    const view = declaredRequestToView('reqB64');
    expect(view.outgoing).toEqual([]);
    expect(view.incoming).toEqual([]);
    expect(view.outputNotesCreated).toBe(0);
    expect(view.inputNotesConsumed).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/app/confirm/decode.test.ts`
Expected: FAIL — `Cannot find module './decode'`.

- [ ] **Step 3: Write the implementation.** Create `src/app/confirm/decode.ts`:

```ts
import { Note, TransactionRequest, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { b64ToU8 } from 'lib/shared/helpers';

export interface AssetAmount {
  faucetId: string;
  amount: bigint;
}

export interface TxAssetView {
  /** Bech32 account address; only known on the verified (executed) path. */
  account?: string;
  /** Assets leaving the account (created output notes / removed vault assets). */
  outgoing: AssetAmount[];
  /** Assets entering the account (consumed notes / added vault assets). */
  incoming: AssetAmount[];
  inputNotesConsumed: number;
  outputNotesCreated: number;
  storageChanged: boolean;
}

function toAmounts(assets: Array<{ faucetId(): { toString(): string }; amount(): bigint }>): AssetAmount[] {
  return assets.map(a => ({ faucetId: a.faucetId().toString(), amount: a.amount() }));
}

function noteAssets(note: { assets(): { fungibleAssets(): any[] } | undefined } | undefined): AssetAmount[] {
  const na = note?.assets();
  return na ? toAmounts(na.fungibleAssets()) : [];
}

/** Ground-truth view from an executed TransactionSummary (authoritative). */
export function summaryToView(ts: TransactionSummary): TxAssetView {
  const delta = ts.accountDelta();
  const vault = delta.vault();
  return {
    account: getBech32AddressFromAccountId(delta.id()),
    outgoing: toAmounts(vault.removedFungibleAssets()),
    incoming: toAmounts(vault.addedFungibleAssets()),
    inputNotesConsumed: ts.inputNotes().numNotes(),
    outputNotesCreated: ts.outputNotes().numNotes(),
    storageChanged: !delta.storage().isEmpty()
  };
}

export function summaryBytesToView(summaryB64: string): TxAssetView {
  return summaryToView(TransactionSummary.deserialize(b64ToU8(summaryB64)));
}

/**
 * Declared (unverified) view decoded statically from the TransactionRequest:
 * outgoing = its expected output notes' assets; incoming = the assets of the
 * notes it consumes (carried as `importNotes`). No execution, so `account` and
 * `storageChanged` are unknown/false. These values are dApp-declared — the UI
 * must label them as such.
 */
export function declaredRequestToView(requestB64: string, importNotes: string[] = []): TxAssetView {
  const request = TransactionRequest.deserialize(b64ToU8(requestB64));
  const outputNotes = request.expectedOutputOwnNotes();
  const consumed = importNotes.map(b64 => Note.deserialize(b64ToU8(b64)));

  return {
    account: undefined,
    outgoing: outputNotes.flatMap(n => noteAssets(n)),
    incoming: consumed.flatMap(n => noteAssets(n)),
    inputNotesConsumed: consumed.length,
    outputNotesCreated: outputNotes.length,
    storageChanged: false
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `yarn jest src/app/confirm/decode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/app/confirm/decode.ts src/app/confirm/decode.test.ts
git commit -m "feat(confirm): SDK-bytes to asset-view decoders (verified + declared)"
```

---

### Task 6: Shared `<TransactionAssetView>` + refactor SigningInputs renderer

**Files:**
- Create: `src/app/confirm/TransactionAssetView.tsx`
- Test: `src/app/confirm/TransactionAssetView.test.tsx`
- Modify: `src/app/ConfirmPage.tsx` (refactor `SigningInputsPayloadContent` 277-474 to compute a `TxAssetView` via `summaryToView` and render `<TransactionAssetView>`)

**Interfaces:**
- Consumes: `TxAssetView`, `AssetAmount` (Task 5); `getTokenMetadata` (`lib/miden/metadata/utils`), `formatAmount` (`lib/shared/format`), `truncateAddress` (`utils/string`), `Icon`/`IconName` (`app/icons/v2`).
- Produces: `interface TransactionAssetViewProps { view: TxAssetView; mode: 'verified' | 'declared'; onDownload?: () => void }` and `const TransactionAssetView: React.FC<TransactionAssetViewProps>`.

- [ ] **Step 1: Write the failing test.** Create `src/app/confirm/TransactionAssetView.test.tsx`:

```tsx
import React from 'react';

import { render, screen, waitFor } from '@testing-library/react';

import { getTokenMetadata } from 'lib/miden/metadata/utils';

import { TransactionAssetView } from './TransactionAssetView';

const t = (k: string) => k;
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('lib/miden/metadata/utils', () => ({ getTokenMetadata: jest.fn() }));
jest.mock('lib/shared/format', () => ({ formatAmount: (a: bigint, d: number) => `${a}/${d}` }));
jest.mock('utils/string', () => ({ truncateAddress: (s: string) => `trunc(${s})` }));
jest.mock('app/icons/v2', () => ({ Icon: () => <i />, IconName: { Globe: 'globe', WarningFill: 'warn' } }));

const view = {
  account: 'mtst1acct',
  outgoing: [{ faucetId: 'fA', amount: 10n }],
  incoming: [{ faucetId: 'fB', amount: 3n }],
  inputNotesConsumed: 1,
  outputNotesCreated: 2,
  storageChanged: false
};

beforeEach(() => {
  (getTokenMetadata as jest.Mock).mockImplementation(async (id: string) => ({
    decimals: 6,
    symbol: id === 'fA' ? 'miZK' : 'rETH'
  }));
});

it('renders outgoing and incoming asset rows with symbol + amount (verified)', async () => {
  render(<TransactionAssetView view={view as any} mode="verified" />);
  await waitFor(() => expect(screen.getByText('10/6 miZK')).toBeInTheDocument());
  expect(screen.getByText('3/6 rETH')).toBeInTheDocument();
  expect(screen.getByText('trunc(mtst1acct)')).toBeInTheDocument();
  expect(screen.getByText('outputNotesCreated')).toBeInTheDocument();
});

it('shows the declared/unverified label in declared mode', () => {
  render(<TransactionAssetView view={{ ...view, account: undefined } as any} mode="declared" />);
  expect(screen.getByText('declaredBySiteVerifying')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/app/confirm/TransactionAssetView.test.tsx`
Expected: FAIL — `Cannot find module './TransactionAssetView'`.

- [ ] **Step 3: Write the component.** Create `src/app/confirm/TransactionAssetView.tsx`:

```tsx
import React, { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { formatAmount } from 'lib/shared/format';
import { truncateAddress } from 'utils/string';

import { Icon, IconName } from '../icons/v2';
import { AssetAmount, TxAssetView } from './decode';

export interface TransactionAssetViewProps {
  view: TxAssetView;
  mode: 'verified' | 'declared';
  /** Optional download handler (verified path exposes the raw summary bytes). */
  onDownload?: () => void;
}

interface ResolvedAsset {
  faucetId: string;
  amount: bigint;
  symbol: string;
  decimals: number;
}

function useResolvedAssets(assets: AssetAmount[]): ResolvedAsset[] {
  const [resolved, setResolved] = useState<ResolvedAsset[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = await Promise.all(
        assets.map(async a => {
          const md = await getTokenMetadata(a.faucetId);
          return { faucetId: a.faucetId, amount: a.amount, symbol: md.symbol, decimals: md.decimals };
        })
      );
      if (!cancelled) setResolved(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [assets]);
  return resolved;
}

export const TransactionAssetView: React.FC<TransactionAssetViewProps> = ({ view, mode, onDownload }) => {
  const { t } = useTranslation();
  const outgoing = useResolvedAssets(view.outgoing);
  const incoming = useResolvedAssets(view.incoming);
  const hasAssets = view.outgoing.length > 0 || view.incoming.length > 0;

  return (
    <div className="flex flex-col items-center justify-center">
      {mode === 'declared' && (
        <span className="text-text-muted text-xs mb-2 self-start">{t('declaredBySiteVerifying')}</span>
      )}

      <div className="flex flex-col border border-gray-100 rounded-2xl mb-4 w-full p-4">
        {view.account && (
          <div className={`flex flex-row w-full items-center justify-between border-gray-100 ${hasAssets ? 'border-b pb-4' : ''}`}>
            <div className="flex flex-row text-md items-center gap-x-3">
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <span className="text-text-muted">{t('account')}</span>
            </div>
            <div>{truncateAddress(view.account)}</div>
          </div>
        )}

        {hasAssets && (
          <div className="flex flex-col w-full pt-4">
            <span className="text-text-muted">{t('assetChanges')}</span>
            {outgoing.map(a => (
              <div key={`out-${a.faucetId}`} className="flex flex-col w-full my-2 text-sm">
                <span className="font-heading text-black-500 text-lg font-semibold">{`-${formatAmount(a.amount, a.decimals)} ${a.symbol ?? t('unknown')}`}</span>
              </div>
            ))}
            {incoming.map(a => (
              <div key={`in-${a.faucetId}`} className="flex flex-col w-full my-2 text-sm">
                <span className="font-heading text-green-500 text-lg font-semibold">{`+${formatAmount(a.amount, a.decimals)} ${a.symbol ?? t('unknown')}`}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col w-full border-b border-gray-100 pb-4">
        <div className="flex flex-row w-full items-center justify-between pb-1">
          <span className="text-text-muted">{t('inputNotesConsumed')}</span>
          <span>{view.inputNotesConsumed}</span>
        </div>
        <div className="flex flex-row w-full items-center justify-between pb-1">
          <span className="text-text-muted">{t('outputNotesCreated')}</span>
          <span>{view.outputNotesCreated}</span>
        </div>
        {mode === 'verified' && (
          <div className="flex flex-row w-full items-center justify-between">
            <span className="text-text-muted">{t('storageChanged')}</span>
            {view.storageChanged ? (
              <div className="flex flex-row items-center gap-x-2">
                <Icon name={IconName.WarningFill} fill="orange" size="md" />
                <span>{t('yes')}</span>
              </div>
            ) : (
              <span>{t('no')}</span>
            )}
          </div>
        )}
      </div>

      {onDownload && (
        <button type="button" className="w-full mt-2 py-3 text-black font-medium hover:bg-gray-100 rounded-4xl" onClick={onDownload}>
          {t('downloadFullSummary')}
        </button>
      )}
    </div>
  );
};
```

- [ ] **Step 4: Run the component test to verify it passes.**

Run: `yarn jest src/app/confirm/TransactionAssetView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `SigningInputsPayloadContent` to use it.** In `src/app/ConfirmPage.tsx`, replace the entire `TransactionSummary` case body (lines 359-460) so it computes a `TxAssetView` and delegates rendering; keep the `Arbitrary`/`Blind` cases untouched for now (Task 8 hardens them). Replace the whole `SigningInputsPayloadContent` component's per-asset state/effects (the four `useState` + three `useEffect` blocks, 279-351) — they move into `TransactionAssetView`. New body:

```tsx
const SigningInputsPayloadContent: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
  const { t } = useTranslation();

  const signingInputs = useMemo(() => {
    try {
      return SigningInputs.deserialize(bytes);
    } catch (e) {
      console.error('Failed to deserialize payload for sign:', e);
      return null;
    }
  }, [bytes]);

  if (!signingInputs) {
    return <div className="text-md text-center my-6">{t('failedToParseSigningPayload')}</div>;
  }

  switch (signingInputs.variantType) {
    case SigningInputsType.TransactionSummary:
      return (
        <TransactionAssetView
          view={summaryToView(signingInputs.transactionSummaryPayload())}
          mode="verified"
          onDownload={() => downloadBytes('transaction_summary.bin', bytes)}
        />
      );
    case SigningInputsType.Arbitrary:
      return <div className="text-md text-center my-6">{t('signArbitraryPayload')}</div>;
    case SigningInputsType.Blind:
      return <div className="text-md text-center my-6">{t('signBlindCommitment')}</div>;
    default:
      return <div className="text-md text-center my-6">{t('noPreview')}</div>;
  }
};
```

Add imports at the top of `ConfirmPage.tsx`: `import { TransactionAssetView } from './confirm/TransactionAssetView';` and `import { summaryToView } from './confirm/decode';`. Remove now-unused symbols if the linter flags them (`FungibleAsset`, `Address`, `AssetMetadata`, `getTokenMetadata`, `formatAmount`, `useTippy`, `getNetworkId`, `MIDEN_METADATA`, `FungibleAssetDetails` type) — delete only those no longer referenced elsewhere in the file (verify with `yarn lint`).

- [ ] **Step 6: Verify the Sign flow still renders + full suite for the file.**

Run: `yarn jest src/app/ConfirmPage.test.tsx src/app/confirm/TransactionAssetView.test.tsx`
Expected: PASS. Then `yarn tsc --noEmit` and `yarn lint src/app/ConfirmPage.tsx src/app/confirm` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/app/confirm/TransactionAssetView.tsx src/app/confirm/TransactionAssetView.test.tsx src/app/ConfirmPage.tsx
git commit -m "refactor(confirm): shared TransactionAssetView; Sign flow uses it"
```

---

### Task 7: `<AdvancedDetails>` collapsible

**Files:**
- Create: `src/app/confirm/AdvancedDetails.tsx`
- Test: `src/app/confirm/AdvancedDetails.test.tsx`

**Interfaces:**
- Produces: `interface AdvancedDetailsProps { label?: string; children: React.ReactNode }` and `const AdvancedDetails: React.FC<AdvancedDetailsProps>` — a keyboard-accessible disclosure that hides its children until toggled.

- [ ] **Step 1: Write the failing test.** Create `src/app/confirm/AdvancedDetails.test.tsx`:

```tsx
import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AdvancedDetails } from './AdvancedDetails';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

it('hides children until toggled, then reveals them', () => {
  render(
    <AdvancedDetails>
      <div>secret-json</div>
    </AdvancedDetails>
  );
  expect(screen.queryByText('secret-json')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'advancedDetails' }));
  expect(screen.getByText('secret-json')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/app/confirm/AdvancedDetails.test.tsx`
Expected: FAIL — `Cannot find module './AdvancedDetails'`.

- [ ] **Step 3: Write the component.** Create `src/app/confirm/AdvancedDetails.tsx`:

```tsx
import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

export interface AdvancedDetailsProps {
  label?: string;
  children: React.ReactNode;
}

export const AdvancedDetails: React.FC<AdvancedDetailsProps> = ({ label, children }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full mt-3">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between text-sm text-text-muted py-2"
        onClick={() => setOpen(o => !o)}
      >
        <span>{label ?? t('advancedDetails')}</span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="text-xs bg-gray-50 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-words">{children}</pre>
      )}
    </div>
  );
};
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `yarn jest src/app/confirm/AdvancedDetails.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit.**

```bash
git add src/app/confirm/AdvancedDetails.tsx src/app/confirm/AdvancedDetails.test.tsx
git commit -m "feat(confirm): AdvancedDetails collapsible disclosure"
```

---

### Task 8: ConfirmPage — custom-tx state machine + opaque-sign warnings

**Files:**
- Modify: `src/app/ConfirmPage.tsx` (add a `CustomTransactionContent` component; branch `case 'transaction'` on `payload.txKind`; harden `case 'sign'` `kind:'word'` and the `Arbitrary`/`Blind` variants; use `useMidenContext().simulateCustomTransaction`)
- Modify (tests): `src/app/ConfirmPage.test.tsx`

**Interfaces:**
- Consumes: `declaredRequestToView`, `summaryBytesToView`, `TxAssetView` (Task 5); `TransactionAssetView` (Task 6); `AdvancedDetails` (Task 7); `Alert` (`./atoms/Alert`, `type="warn"`); `simulateCustomTransaction(id)` from `useMidenContext()` (Task 3).
- Produces: rendered custom-tx flow with states `declared → verifying → verified | undecodable`; opaque-sign warning banner + raw-under-advanced.

- [ ] **Step 1: Write the failing tests.** Append to `src/app/ConfirmPage.test.tsx`. (No change to the existing `@miden-sdk/miden-sdk/lazy` per-file mock is needed — the new code paths reach the SDK only through `./confirm/decode`, which these tests mock directly.)

The suite already provides: a `ctx` object (the `useMidenContext` mock return, ~line 192), `setPayload(payload)` (sets `useRetryableSWR` → `{ data }`), `baseFields()`, `b64()`, `mockWord`, and `mockUseLocation` returning `?id=req-1` (so the confirm id is `req-1`). Two edits to the top-of-file mock section, then the tests.

First, add `simulateCustomTransaction: jest.fn()` to the `ctx` object literal (the one containing `getDAppPayload`, `confirmDAppTransaction`, … around line 192-202).

Second, add these two `jest.mock` blocks alongside the other `jest.mock('./...')` calls near the top (the decode module is mocked so these UI tests don't touch the WASM SDK; the shared view is stubbed so mode/account are assertable):

```tsx
jest.mock('./confirm/decode', () => ({
  declaredRequestToView: jest.fn(() => ({
    outgoing: [{ faucetId: 'fA', amount: 10n }],
    incoming: [],
    inputNotesConsumed: 0,
    outputNotesCreated: 1,
    storageChanged: false
  })),
  summaryBytesToView: jest.fn(() => ({
    account: 'mtst1acct',
    outgoing: [{ faucetId: 'fA', amount: 10n }],
    incoming: [{ faucetId: 'fB', amount: 3n }],
    inputNotesConsumed: 1,
    outputNotesCreated: 1,
    storageChanged: false
  }))
}));
jest.mock('./confirm/TransactionAssetView', () => ({
  TransactionAssetView: ({ mode, view }: any) => (
    <div data-testid="asset-view" data-mode={mode} data-account={view.account ?? ''} />
  )
}));
```

Then the tests (place at the end of the file, before the final closing):

```tsx
describe('ConfirmPage custom transaction', () => {
  const customPayload = (over: any = {}) => ({
    type: 'transaction',
    txKind: 'custom',
    requestBytes: 'reqB64',
    importNotes: [],
    recipientAddress: 'mtst1recipient',
    decodeStatus: 'declared',
    transactionMessages: [],
    ...baseFields(),
    ...over
  });

  it('swaps the declared view for the verified view after simulation', async () => {
    (ctx as any).simulateCustomTransaction.mockResolvedValue({ summaryBytes: 'sumB64' });
    setPayload(customPayload());
    render(<ConfirmPage />);

    await waitFor(() => expect(screen.getByTestId('asset-view')).toHaveAttribute('data-mode', 'verified'));
    expect(screen.getByTestId('asset-view')).toHaveAttribute('data-account', 'mtst1acct');
    expect((ctx as any).simulateCustomTransaction).toHaveBeenCalledWith('req-1');
  });

  it('keeps the declared view with a caveat when simulation errors', async () => {
    (ctx as any).simulateCustomTransaction.mockResolvedValue({ error: 'boom' });
    setPayload(customPayload());
    render(<ConfirmPage />);

    await waitFor(() => expect(screen.getByText('couldNotVerifyBySimulation')).toBeInTheDocument());
    expect(screen.getByTestId('asset-view')).toHaveAttribute('data-mode', 'declared');
  });

  it('shows could-not-decode when requestBytes is absent', () => {
    (ctx as any).simulateCustomTransaction.mockResolvedValue({ error: 'x' });
    setPayload(customPayload({ requestBytes: undefined, decodeStatus: 'undecodable' }));
    render(<ConfirmPage />);

    expect(screen.getByText('couldNotDecodeTransaction')).toBeInTheDocument();
  });
});

describe('ConfirmPage opaque signature', () => {
  it('shows a blind-sign warning for a raw word signature', () => {
    mockWord.deserialize.mockReturnValue({ toHex: () => '0xabc' });
    setPayload({ type: 'sign', kind: 'word', payload: b64('w'), ...baseFields() });
    render(<ConfirmPage />);

    // The Alert mock (top of file) renders its `description`; `t` echoes keys.
    expect(screen.getByText('opaqueSignatureWarning')).toBeInTheDocument();
  });
});
```

> The declared-first transient (mode="declared" before simulation resolves) is intentionally not asserted directly — it is inherently racy — but it is covered indirectly: the error test proves the declared view renders and persists when no verified summary arrives.

- [ ] **Step 2: Run it to verify it fails.**

Run: `yarn jest src/app/ConfirmPage.test.tsx -t "custom transaction"`
Expected: FAIL — declared/verified behavior not implemented.

- [ ] **Step 3: Add `CustomTransactionContent` to `ConfirmPage.tsx`.** Add imports: `import { declaredRequestToView, summaryBytesToView, TxAssetView } from './confirm/decode';`, `import { AdvancedDetails } from './confirm/AdvancedDetails';`. Add the component (near `SigningInputsPayloadContent`):

```tsx
const CustomTransactionContent: React.FC<{ payload: Extract<MidenDAppPayload, { type: 'transaction' }>; id: string }> = ({
  payload,
  id
}) => {
  const { t } = useTranslation();
  const { simulateCustomTransaction } = useMidenContext();

  const declaredView = useMemo<TxAssetView | null>(() => {
    if (!payload.requestBytes) return null;
    try {
      return declaredRequestToView(payload.requestBytes, payload.importNotes ?? []);
    } catch (e) {
      console.error('Failed to decode declared custom transaction:', e);
      return null;
    }
  }, [payload.requestBytes, payload.importNotes]);

  const [verifiedView, setVerifiedView] = useState<TxAssetView | null>(null);
  const [simError, setSimError] = useState(false);

  useEffect(() => {
    if (!payload.requestBytes) return;
    let cancelled = false;
    (async () => {
      const { summaryBytes, error } = await simulateCustomTransaction(id);
      if (cancelled) return;
      if (summaryBytes) {
        try {
          setVerifiedView(summaryBytesToView(summaryBytes));
          return;
        } catch (e) {
          console.error('Failed to decode simulated summary:', e);
        }
      }
      if (error || !summaryBytes) setSimError(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, payload.requestBytes, simulateCustomTransaction]);

  const advanced = (
    <AdvancedDetails>
      {JSON.stringify(
        {
          recipient: payload.recipientAddress,
          importNotes: payload.importNotes?.length ?? 0,
          requestBytes: payload.requestBytes
        },
        null,
        2
      )}
    </AdvancedDetails>
  );

  if (verifiedView) {
    return (
      <>
        <TransactionAssetView view={verifiedView} mode="verified" />
        {advanced}
      </>
    );
  }

  if (declaredView) {
    return (
      <>
        <TransactionAssetView view={declaredView} mode="declared" />
        {simError && <div className="text-xs text-text-muted my-2">{t('couldNotVerifyBySimulation')}</div>}
        {advanced}
      </>
    );
  }

  return (
    <div>
      <div className="text-sm my-4">{t('couldNotDecodeTransaction')}</div>
      {advanced}
    </div>
  );
};
```

- [ ] **Step 4: Branch `case 'transaction'` on `txKind`.** In `PayloadContent`, at the start of `case 'transaction':` (line 173), add:

```tsx
    case 'transaction': {
      if (payload.txKind === 'custom') {
        content = <CustomTransactionContent payload={payload} id={viewKey ?? ''} />;
        break;
      }
      // ...existing send rendering unchanged...
```

Thread the confirm id into `PayloadContent`: it already receives `viewKey?: string` in `PayloadContentProps` (line 110) — pass the `id` from `ConfirmDAppForm` when rendering `<PayloadContent ... viewKey={id} />` (line 832).

- [ ] **Step 5: Harden the opaque-signature leaves.** In `case 'sign'` `case 'word'` (123-137), wrap the word in a warning + advanced:

```tsx
        case 'word': {
          let wordHex = t('invalidPayload');
          try {
            wordHex = Word.deserialize(bytes).toHex();
          } catch (e) {
            console.error('Failed to deserialize payload for sign:', e);
          }
          content = (
            <>
              <Alert type="warn" title={t('opaqueSignatureTitle')} description={t('opaqueSignatureWarning')} className="my-2" />
              <AdvancedDetails label={t('rawValue')}>{wordHex}</AdvancedDetails>
            </>
          );
          break;
        }
```

And in `SigningInputsPayloadContent` (Task 6 body) replace the `Arbitrary` and `Blind` returns with the same warning treatment:

```tsx
    case SigningInputsType.Arbitrary:
    case SigningInputsType.Blind:
      return (
        <>
          <Alert type="warn" title={t('opaqueSignatureTitle')} description={t('opaqueSignatureWarning')} className="my-2" />
          <AdvancedDetails label={t('rawValue')}>{signingInputs.variantType === SigningInputsType.Arbitrary ? t('signArbitraryPayload') : t('signBlindCommitment')}</AdvancedDetails>
        </>
      );
```

(Add `import Alert from './atoms/Alert';` if not already present — it is imported at line 31 — and the `AdvancedDetails` import from Task 6/7.)

- [ ] **Step 6: Run the ConfirmPage suite to verify it passes.**

Run: `yarn jest src/app/ConfirmPage.test.tsx`
Expected: PASS (existing + new tests). Then `yarn tsc --noEmit` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/app/ConfirmPage.tsx src/app/ConfirmPage.test.tsx
git commit -m "feat(confirm): decoded custom-tx state machine + opaque-sign warnings"
```

---

### Task 9: Locale strings

**Files:**
- Modify: `public/_locales/en/messages.json`

**Interfaces:**
- Consumes: the `t('...')` keys referenced in Tasks 6-8.
- Produces: English entries for every new key (CI auto-translates the other locales).

- [ ] **Step 1: Add the new keys.** Insert these entries into `public/_locales/en/messages.json` (alphabetical placement is not required; keep valid JSON — mind the trailing comma on the preceding entry):

```json
  "declaredBySiteVerifying": {
    "message": "Declared by site — verifying by simulation…",
    "englishSource": "Declared by site — verifying by simulation…"
  },
  "couldNotVerifyBySimulation": {
    "message": "Could not verify by simulation. Amounts below are as declared by the site.",
    "englishSource": "Could not verify by simulation. Amounts below are as declared by the site."
  },
  "couldNotDecodeTransaction": {
    "message": "This dApp is requesting a custom transaction. The wallet could not decode its details — only continue if you know exactly what it does.",
    "englishSource": "This dApp is requesting a custom transaction. The wallet could not decode its details — only continue if you know exactly what it does."
  },
  "advancedDetails": {
    "message": "Advanced details",
    "englishSource": "Advanced details"
  },
  "rawValue": {
    "message": "Raw value",
    "englishSource": "Raw value"
  },
  "opaqueSignatureTitle": {
    "message": "Opaque signature request",
    "englishSource": "Opaque signature request"
  },
  "opaqueSignatureWarning": {
    "message": "This site asked you to sign a raw value. The wallet cannot show what it authorizes. Only continue if you fully trust this site.",
    "englishSource": "This site asked you to sign a raw value. The wallet cannot show what it authorizes. Only continue if you fully trust this site."
  }
```

- [ ] **Step 2: Validate JSON + regenerate locale files locally.**

Run: `node -e "JSON.parse(require('fs').readFileSync('public/_locales/en/messages.json','utf8')); console.log('en messages.json OK')"`
Then: `node format-locales.js`
Expected: prints each locale dir name, no error; `public/_locales/en/en.json` updated.

- [ ] **Step 3: Commit.**

```bash
git add public/_locales/en/messages.json public/_locales/en/en.json
git commit -m "feat(confirm): en copy for decoded custom-tx + opaque-sign warning"
```

---

### Task 10: Full verification + changelog

**Files:**
- Modify: `CHANGELOG.md` (add an entry under `## 1.15.9 (TBD)`)

- [ ] **Step 1: Run the full gate battery locally.**

```bash
yarn tsc --noEmit
yarn lint
yarn lint:i18n
yarn jest --coverage
```

Expected: tsc clean; ESLint clean; `lint:i18n` reports 0 warnings; jest green with **coverage ≥ 95%** on branches/functions/lines/statements. If coverage on any NEW file is below 95%, add the missing-branch tests (e.g. the `!signingInputs` path, the empty-notes decode path, the simulate error path) until the gate clears — do NOT lower the threshold.

- [ ] **Step 2: Add the changelog entry.** Under `## 1.15.9 (TBD)` in `CHANGELOG.md`, add to `### Features` (create the section if absent, above `### Fixes`):

```markdown
* [FEATURE][extension] **The custom-transaction confirmation now shows what the transaction actually does instead of an opaque "custom transaction" notice.** The wallet decodes the request for an instant declared preview, then runs a local dry-run (`executeForSummary`, no prove/submit) to show the ground-truth asset changes (what you send / receive), notes consumed/created, and storage impact — with the raw request under an Advanced disclosure. Genuinely-opaque signature requests (blind word / arbitrary / blind-commitment) now carry an explicit "you are blind-signing" warning so they are visually distinct from real transactions.
```

- [ ] **Step 3: Verify the changelog check passes.**

Run: `./scripts/check-changelog.sh` (if it expects a base ref, run it the way CI does, or simply confirm `CHANGELOG.md` shows as modified in `git status`).
Expected: PASS / `CHANGELOG.md` is in the diff.

- [ ] **Step 4: Commit.**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): human-readable custom-tx & signature confirmation"
```

- [ ] **Step 5: Final full run (sanity).**

```bash
yarn jest --coverage && yarn tsc --noEmit && yarn lint:i18n
```

Expected: all green, coverage ≥ 95%.

---

## Self-Review notes (spec coverage)

- Custom-tx decoded asset summary → Tasks 2,5,6,8. Static-first + background verify → Task 8 state machine + Task 2/4 simulate. Pre-confirm import+sync → Task 2. Opaque-sign hardening → Task 8. Advanced/JSON → Task 7 + Task 8. Undecodable fallback → Task 8. Shared renderer refactor → Task 6. Transport → Tasks 1,3,4. i18n → Task 9. 95% coverage + CI → Tasks (each) + Task 10.
- Deviation from spec (recorded): `preview: any` is NOT removed (kept minimal-impact). Declared "incoming" uses consumed `importNotes` assets rather than `expectedFutureNotes()` — swap-return notes decode is deferred; the verified `executeForSummary` delta remains the authoritative view. `expectedFutureNotes()` enrichment is a future enhancement.
- Out of scope (unchanged from spec): mobile/desktop `dappConfirmationStore` path (this plan wires simulate through the extension `requestConfirm` popup only), fiat pricing, orphan-note cleanup after cancel, non-fungible asset richness.
