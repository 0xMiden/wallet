# Fund-Your-Wallet Faucet Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Home "Fund your wallet" card asks the public faucet for an amount within its cap. If the cap changes, it retries once at the cap the faucet names. A rate limit or a cap refusal reads in plain words. The request stops sending the parameter, and reading the field, that faucet 0.17.0 removed.

**Architecture:**
- **`src/lib/miden-chain/faucet-protocol.ts` (new).** Holds the rules for reading a faucet reply: the grant amount, the cap a refusal names and the wait a refusal names. It imports nothing, so it stays pure and a Node process can load it without the SDK.
- **`faucet-api.ts`.** Raises two typed refusals, each keeping its current message. `mintFromMidenFaucet` asks for `max(token_amounts) * 10^decimals` (or `base_amount`) and retries once at the cap. It stops sending `is_private_note` and reading `tx_id`.
- **`HomePrompts.tsx`.** Keeps the failure as an `Error` and turns the two typed refusals into plain copy when it renders. Every other failure keeps its own message.
- **`playwright/e2e/helpers/public-faucet.ts`.** Drops the same two wire fields. It asks for the same amount through `faucetGrantAmount` and retries once at the cap as the wallet does, inside its existing 5xx and 429 loop.

**Tech Stack:** TypeScript, React 18, Jest 30 with @swc/jest and jsdom, Testing Library, Playwright (E2E helper only), i18next with `$name$` interpolation, Chrome `messages.json` locales.

**Spec:** there is no separate spec. Three of the four approved scope items are the spec; the fourth, the Activity "Faucet Request" label, is its own later PR (`docs/superpowers/plans/2026-10-10-faucet-request-label.md`).
- **Grant amount.** The Fund button requests `max(token_amounts) * 10^decimals` when `/get_metadata` carries `token_amounts`, else `base_amount`. It retries exactly once at the cap `M` parsed from a 400 "maximum claimable amount of M". It retries only when `0 < M < requested` and the wallet chose the amount.
- **Plain-language card copy.** The Home card shows plain words for the faucet's 400 over-cap refusal and its 429 rate limit, with the wait when the faucet names one, instead of the raw server text. Every other failure keeps its raw text (#425).
- **Dead wire fields.** Remove the `is_private_note` request parameter and the never-returned `tx_id`/`txId` mapping, in the wallet and in the E2E faucet helper.

Each change gets a failing-first test.

## Global Constraints

**Scope decisions**

The Activity label is split out by decision.

| Piece | Decision | Why |
|---|---|---|
| Activity labels a native-asset grant from the faucet's funding account a "Faucet Request" (approved item 3) | Separate later PR, with its own plan gate (decided) | Plan: `docs/superpowers/plans/2026-10-10-faucet-request-label.md`. It runs on a branch that contains this PR. This PR leaves every Activity classifier untouched. |

**Workspace and commands**
- Worktree: `~/miden/wt-fund-faucet`, branch `wiktor/fund-faucet-cap` off `origin/main` 964ebbc04. Never run `yarn install` or any build.
- Every command starts with `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`.
- Run tests with `yarn jest <paths> --maxWorkers=2`. This calls the jest binary; package.json `test` is plain `jest`.
- Lint and format each touched source or test file with `npx prettier --write <files> && npx eslint --max-warnings 0 <files>`. The root `.eslintrc` runs `prettier/prettier` and also parses the playwright files.
- Never run prettier on `public/_locales/**`:
  - `en/messages.json` is generator-owned: `utility/generateLanguageFiles.ts` `generateEnglishMessages()` writes it with `JSON.stringify` and no final newline;
  - the CI translations commit would undo any reformat.
- `yarn ts` (tsc over `src` and `playwright/**`) runs in CI's Unit tests job. Do not run it locally. The Delivery D1 scan is the local check for the one type-level removal.

**Faucet facts (verified 2026-10-10)**
- Testnet runs 0.17.1 and devnet runs 0.17.0.
- A grant is exactly the requested `asset_amount`, up to the operator cap. The cap moved 100 -> 10 -> 0.01 -> 1 -> 100 USDCx in 3 days.
- Over the cap, the faucet answers 400 `requested amount N exceeds the maximum claimable amount of M`, with M in base units:
  - testnet answers at `/pow`, before any proof of work;
  - devnet answers only at `/get_tokens`, after the proof of work and before anything is minted (`get_tokens.rs:157` checks the cap before `submit_challenge` at `:172`).
- `base_amount` is the proof-of-work pivot (`complexity = amount / base_amount + 1`), not the cap.
- `token_amounts` is in whole tokens (for example `[1,10,100]`). It is present on 0.17.1 only, and the faucet checks it against its cap at startup.
- 429 means `Account is rate limited for N more seconds.`, per account, and only `/get_tokens` sends it. The wallet reads the seconds from the body because `Retry-After` is not exposed to a cross-origin reader.
- The grant is a public P2ID note.
- The `/get_tokens` response is `{"note_id": "0x..."}` only.

**Error messages and comments**
- Keep the current error messages byte for byte:
  - `Faucet PoW request failed with status ${status}: ${detail}`
  - `Faucet token request failed with status ${status}: ${detail}`
  - `Faucet metadata base_amount must be a positive safe integer`
  - `Faucet metadata request failed with status ${status}: ${detail}`
  - `Public faucet PoW request failed (${status}): ${body}`
- Comment density must match each file's norm (awk recipe in Delivery):
  - `faucet-api.ts` 17%, `HomePrompts.tsx` 23%, `public-faucet.ts` 20%;
  - repo `src` non-test `.ts` 33%, `.tsx` 16%, tests about 5%.
  - The new `faucet-protocol.ts` lands between 17% and 33% (the Task 1 code measures 23%); new tests stay near 5%.
  - Keep comments that explain why or warn of a trap. Never narrate.

**Copy, commits and attribution**
- Never use an em dash (U+2014) or en dash (U+2013) in code, comments, copy, commit messages, CHANGELOG or PR text. Use a plain hyphen.
- English copy goes only into `public/_locales/en/en.json` and `public/_locales/en/messages.json`. The CI `translations` job (DeepL) writes every other locale. Never hand-edit another locale.
- Commits use the exact single-line messages given in each task, with no trailers (no `Co-Authored-By`, no "Generated with"). Never amend. Every `git add` names explicit paths.
- No tool or agent attribution may appear in any commit, comment, CHANGELOG line or PR text.

**Out of scope**
- The Activity "Faucet Request" label and everything it needs: reading the `/get_metadata` `id`, storing funding accounts, the classifiers, the Activity components and the receipt arrow colour (the label PR).
- The proof-of-work solver and its timeout (measure first).
- The hosted faucet page in the dApp browser.
- PR #1100.
- The raw "challenge expired" text from `faucetFetch` replaying a challenge after a readable `Retry-After` (follow-up issue).

## Review Focus

1. **A timeout or abort that lands on the over-cap refusal.** The caller's reason surfaces, no second challenge is requested, and the PoW worker never starts. Pinned in Task 4 by "sends no second challenge when the caller aborts on an over-cap refusal".
2. **Metadata with no usable `token_amounts`.** Devnet's 0.17.0 sends none. A list that is empty, holds a zero, a string or a fraction, is `null` or an object, or comes with missing, negative, fractional or over-19 `decimals` falls back to `base_amount`. A malformed `base_amount` beside a valid list still asks for the list's amount. Pinned in Task 1 by the "falls back to base_amount for $name" table (its first row is the 0.17.0 shape) and "keeps the offered amount when base_amount is malformed", and in Task 4 by the devnet retry test, whose first request is the `base_amount`. The E2E helper reads the metadata through the same function; Task 7 pins its malformed-`base_amount` case ("asks for an offered token amount when base_amount is malformed").
3. **An over-cap refusal the retry must leave alone.** A cap equal to or above the chosen amount, a cap of 0, a 400 whose cap does not parse, a 400 about something else, and an amount the caller chose each send exactly one request and reject with the faucet's own message. Pinned in Task 4 by the "asks only once when %s" table and "asks only once for an amount the caller chose", in Task 2 by "keeps any other refusal a plain error", and in Task 1 by "reads no cap from %p". The E2E helper keeps the same boundary, pinned in Task 7 by its own "asks only once when %s" table and "asks only once for an amount the caller chose".
4. **A retry whose second request also fails.** A second over-cap refusal or a rate limit on the retry rejects with that second refusal, typed, and no third request goes out. On devnet both refusals report that nothing is minting, and the retry passes the funding marker's pre-send check a second time. Pinned in Task 4 by "asks at most twice, whatever the second refusal names", "surfaces a rate limit on the retry as the faucet sent it, and asks no third time" and the `wallet-prompts.test.ts` guard "lets a request refused over the cap go out again at the cap, flagged anew". In the E2E helper, Task 7's "asks at most twice, whatever the second refusal names" pins the same limit.
5. **A rate-limit reply that names 0 or 1 seconds, or no number.** The card never says "Try again in 0 seconds" or "1 seconds". It shows the wait-free copy instead. Pinned in Task 5 by the `it.each` over seconds 25, 1, 0 and null.
6. **The E2E helper's ask at the cap inside its own retry loop.** The ask neither resets nor spends the 5xx attempts or the 429 budget; calling `mintFromPublicFaucet` again for it would start both afresh. Pinned in Task 7 by "keeps counting 5xx attempts across the ask at the cap" and "keeps one 429 budget across the ask at the cap".

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/miden-chain/faucet-protocol.ts` | create | Pure readers of a faucet reply: grant amount, cap, wait. Imports nothing, so the wallet and the E2E helper share it. |
| `src/lib/miden-chain/faucet-protocol.test.ts` | create | Parser cases |
| `src/lib/miden-chain/faucet-api.ts` | modify | Typed refusals, dead fields, grant amount plus one cap retry |
| `src/lib/miden-chain/faucet-api.test.ts` | modify | Refusal typing, wire shape, amount, retry |
| `src/lib/wallet-prompts.test.ts` | modify | Drop `txId` from mocks; guard test for the second pre-send flag |
| `src/app/templates/HomePrompts.tsx` (+ test) | modify | `faucetError` holds the Error; `faucetFailureBody` maps typed refusals to copy |
| `public/_locales/en/en.json`, `public/_locales/en/messages.json` | modify | Three copy keys |
| `playwright/e2e/helpers/public-faucet.ts` (+ test), `playwright/e2e/helpers/miden-cli-fee.test.ts` | modify | Drop `is_private_note` and `tx_id`/`txId` (Task 6); the helper asks for `faucetGrantAmount` and retries once at the cap (Task 7) |
| `scripts/e2e-real.mjs` | modify | The preflight's faucet line names `base_amount` instead of calling it the grant (Task 7) |
| `CHANGELOG.md` | modify | One `[FIX][all]` entry under `## 1.17.2 (TBD)` |

### Existing tests that pin current behaviour

| Test | Pins | Plan |
|---|---|---|
| `faucet-api.test.ts:446-470` and the chain test (`:841-867`) | `is_private_note`, `txId` | Updated in Task 3 |
| `faucet-api.test.ts:779-808` | `base_amount` used unchanged; malformed `base_amount` rejected | Unchanged, still pass (no `token_amounts`) |
| `faucet-api.test.ts:142-148`, `532-549`, `741-755`, `757-776` | Refusal messages | Unchanged, still pass. Jest 30 compares Errors by message only. |
| `wallet-prompts.test.ts` (18 `txId` mocks) | Mint result shape | Updated by perl in Task 3 |
| `wallet-prompts.test.ts:336-347` | `faucet()` passes `undefined` as the amount, so the wallet chooses it | Assertion unchanged, passes (Task 3's perl only drops `txId` from its mock); the cap retry depends on it |
| `HomePrompts.test.tsx:1689-1722`, `2006-2039` | Raw message for a plain Error (#425) | Unchanged, pass |
| `public-faucet.test.ts` `txId` expectations | Helper result shape | Updated by perl in Task 6. The `tx_id` replies stay, to show an extra field is ignored. |
| `public-faucet.test.ts:117-130` | Helper asks for `base_amount` when the amount is omitted | Unchanged, pass: the metadata has no `token_amounts`, so Task 7's `faucetGrantAmount` returns `base_amount` |
| `public-faucet.test.ts:132-144`, `308-316` | Helper rejects malformed metadata with the `base_amount` message | Unchanged, pass: none has `token_amounts`, so Task 7's `faucetGrantAmount` falls back to `base_amount` and throws the same message |
| `public-faucet.test.ts:146-171`, `196-290` | One amount across retries; 5xx attempts; 429 waits and budget | Unchanged, pass. Task 7 adds two tests that hold the attempts and the budget across the ask at the cap. |
| `miden-cli-fee.test.ts:101` | Typed helper mock with `txId` | Updated in Task 6 (otherwise `yarn ts` fails on an excess property) |
| `scripts/e2e-real.fetch-stub.mjs:32` | Stub metadata `{ version: 'stub', base_amount: 1 }` | Unchanged; it has no `token_amounts`, so the wallet still asks for `base_amount` |
| `scripts/e2e-real.test.ts` preflight cases | Run the faucet probe line against that stub; no assertion reads its text | Unchanged, pass after Task 7 rewrites that line |
| `locale-bundle-parity` | Translation coverage | 13 expected failures until the translations job runs (Task 5) |

## Design notes (where this plan settles a choice the design left open or adjusts it)

- **The Activity label is its own PR.** Everything that reads or stores the faucet's funding account lives in `2026-10-10-faucet-request-label.md`: the `faucetSenderId` reader, the stored-id-set store, recording on a Fund tap, the History refresh, the classifiers and the Activity components. This PR keeps Activity's current rule (sender equals the native faucet).
- **`fetchFaucetMetadata` returns the raw reply.** `faucet-protocol.ts` parses it after the `faucetFetch` read, so the label PR can read the funding account from the same fetch without reshaping it. A malformed reply still rejects before any `/pow`; the existing "rejects malformed metadata base_amount %s before PoW or mint" test pins that.
- **Open questions settled as the design recommended.**
  - Retry only for wallet-chosen amounts.
  - No minimum cap.
  - The amount formula is exactly the approved one, with no `min(..., base_amount)` guard.

---

### Task 1: The faucet reply readers (`faucet-protocol.ts`)

**Files:**
- Create: `src/lib/miden-chain/faucet-protocol.ts`
- Test: `src/lib/miden-chain/faucet-protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `faucetGrantAmount(metadata: unknown): bigint`. It throws `Error('Faucet metadata base_amount must be a positive safe integer')`.
  - `faucetCapFromRefusal(detail: string): bigint | null`
  - `faucetRateLimitSeconds(detail: string): number | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/miden-chain/faucet-protocol.test.ts`:

```ts
import { faucetCapFromRefusal, faucetGrantAmount, faucetRateLimitSeconds } from './faucet-protocol';

describe('faucetGrantAmount', () => {
  it('asks for the largest offered token amount, in base units', () => {
    expect(faucetGrantAmount({ base_amount: 100_000_000, token_amounts: [1, 10, 100], decimals: 6 })).toBe(
      100_000_000n
    );
    expect(faucetGrantAmount({ base_amount: 100_000_000, token_amounts: [10, 1], decimals: 6 })).toBe(10_000_000n);
  });

  it('keeps the offered amount when base_amount is malformed', () => {
    expect(faucetGrantAmount({ base_amount: '1', token_amounts: [5], decimals: 0 })).toBe(5n);
  });

  it('computes an amount past the safe-integer range exactly', () => {
    expect(faucetGrantAmount({ token_amounts: [1_000_000], decimals: 19 })).toBe(10n ** 25n);
  });

  it.each([
    { name: 'no token amounts (faucet 0.17.0)', metadata: { base_amount: 10_000, decimals: 6 } },
    { name: 'an empty list', metadata: { base_amount: 10_000, token_amounts: [], decimals: 6 } },
    { name: 'a zero amount', metadata: { base_amount: 10_000, token_amounts: [0, 10], decimals: 6 } },
    { name: 'a string amount', metadata: { base_amount: 10_000, token_amounts: ['10'], decimals: 6 } },
    { name: 'a fractional amount', metadata: { base_amount: 10_000, token_amounts: [1.5], decimals: 6 } },
    { name: 'a null list', metadata: { base_amount: 10_000, token_amounts: null, decimals: 6 } },
    { name: 'an object', metadata: { base_amount: 10_000, token_amounts: {}, decimals: 6 } },
    { name: 'no decimals', metadata: { base_amount: 10_000, token_amounts: [10] } },
    { name: 'negative decimals', metadata: { base_amount: 10_000, token_amounts: [10], decimals: -1 } },
    { name: 'fractional decimals', metadata: { base_amount: 10_000, token_amounts: [10], decimals: 1.5 } },
    { name: 'decimals past a u64', metadata: { base_amount: 10_000, token_amounts: [10], decimals: 20 } }
  ])('falls back to base_amount for $name', ({ metadata }) => {
    expect(faucetGrantAmount(metadata)).toBe(10_000n);
  });

  it.each([undefined, null, 'metadata', {}, { base_amount: 0 }, { base_amount: Number.MAX_SAFE_INTEGER + 1 }])(
    'rejects %p, which offers no usable amount, with the message both suites match',
    metadata => {
      expect(() => faucetGrantAmount(metadata)).toThrow('Faucet metadata base_amount must be a positive safe integer');
    }
  );
});

describe('faucetCapFromRefusal', () => {
  it('reads the cap a refusal names, exactly', () => {
    expect(faucetCapFromRefusal('requested amount 100000000 exceeds the maximum claimable amount of 10000000')).toBe(
      10_000_000n
    );
    expect(faucetCapFromRefusal('requested amount 1 exceeds the maximum claimable amount of 18446744073709551615')).toBe(
      18_446_744_073_709_551_615n
    );
  });

  it.each([
    'requested amount 1000 exceeds the maximum claimable amount',
    'requested amount 1000 exceeds the maximum claimable amount of N/A',
    'Please enter a valid recipient address',
    ''
  ])('reads no cap from %p', detail => {
    expect(faucetCapFromRefusal(detail)).toBeNull();
  });
});

describe('faucetRateLimitSeconds', () => {
  it.each([
    { detail: 'Account is rate limited for 25 more seconds.', seconds: 25 },
    { detail: 'Account is rate limited for 1 more second.', seconds: 1 },
    { detail: 'requestor is rate limited for 0 more seconds', seconds: 0 }
  ])('reads the wait in $detail', ({ detail, seconds }) => {
    expect(faucetRateLimitSeconds(detail)).toBe(seconds);
  });

  it.each(['Account is rate limited.', 'rate limited for 99999999999999999999 more seconds', ''])(
    'reads no wait from %p',
    detail => {
      expect(faucetRateLimitSeconds(detail)).toBeNull();
    }
  );
});
```

Mutation notes (each line names the implementation change and the assertion that catches it):
- **Largest amount:** `Math.min` in place of `Math.max` makes `toBe(100_000_000n)` fail.
- **Malformed base:** reading `base_amount` before `token_amounts` throws.
- **Exact big amount:** computing in `Number` before `BigInt` makes `10n ** 25n` fail.
- **Fallback table:**
  - dropping `tokens.length > 0` makes the empty-list case throw (`Math.max()` gives `-Infinity`);
  - dropping `decimals <= MAX_DECIMALS` makes the decimals-20 case return `10n ** 21n`.
- **Rejects:** relaxing `value > 0` lets `{ base_amount: 0 }` return `0n`.
- **Cap:** `Number(cap)` in place of `BigInt(cap)` makes the u64-max case fail.
- **No cap:** a `(\d*)` pattern matches the empty string after `amount of ` in the `N/A` case and returns `0n`.
- **Wait:** dropping `?` from `seconds?` makes the "1 more second." case return null.
- **No wait:** dropping `Number.isSafeInteger` makes the 20-digit case return a number.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-protocol.test.ts --maxWorkers=2`
Expected: FAIL with `Cannot find module './faucet-protocol' from 'src/lib/miden-chain/faucet-protocol.test.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/miden-chain/faucet-protocol.ts`:

```ts
/**
 * What the wallet reads from a 0xMiden faucet reply: the amount to ask for and what a refusal names. It imports
 * nothing, so a Node process such as the E2E faucet helper can load it without the SDK.
 */

// 10^19 is the largest power of ten a u64 base-unit amount holds; the faucet refuses more decimals at startup.
const MAX_DECIMALS = 19;

const field = (record: unknown, name: string): unknown =>
  record !== null && typeof record === 'object' ? Reflect.get(record, name) : undefined;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Base units to ask for: the largest whole-token amount the faucet offers (`token_amounts`, 0.17.1 on, each checked
 * against its cap at startup) at its `decimals`, else `base_amount`, which sets only the proof-of-work difficulty
 * and is within the cap by the operator's choice alone.
 */
export function faucetGrantAmount(metadata: unknown): bigint {
  const tokens = field(metadata, 'token_amounts');
  const decimals = field(metadata, 'decimals');
  if (
    Array.isArray(tokens) &&
    tokens.length > 0 &&
    tokens.every(isPositiveSafeInteger) &&
    typeof decimals === 'number' &&
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= MAX_DECIMALS
  ) {
    return BigInt(Math.max(...tokens)) * 10n ** BigInt(decimals);
  }
  const baseAmount = field(metadata, 'base_amount');
  if (isPositiveSafeInteger(baseAmount)) return BigInt(baseAmount);
  throw new Error('Faucet metadata base_amount must be a positive safe integer');
}

/** The cap, in base units, that an over-cap refusal names ("maximum claimable amount of M"), or null. */
export function faucetCapFromRefusal(detail: string): bigint | null {
  const cap = /maximum claimable amount of (\d+)/.exec(detail)?.[1];
  return cap === undefined ? null : BigInt(cap);
}

/** The wait a rate-limit refusal names ("rate limited for N more seconds"), or null. */
export function faucetRateLimitSeconds(detail: string): number | null {
  const seconds = /(\d+)\s+more\s+seconds?/i.exec(detail)?.[1];
  if (seconds === undefined) return null;
  const value = Number(seconds);
  return Number.isSafeInteger(value) ? value : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-protocol.test.ts --maxWorkers=2 && npx prettier --write src/lib/miden-chain/faucet-protocol.ts src/lib/miden-chain/faucet-protocol.test.ts && npx eslint --max-warnings 0 src/lib/miden-chain/faucet-protocol.ts src/lib/miden-chain/faucet-protocol.test.ts`
Expected: PASS, every test green, no eslint output.

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add src/lib/miden-chain/faucet-protocol.ts src/lib/miden-chain/faucet-protocol.test.ts && git commit -m "feat(faucet): read the grant amount, cap and wait from faucet replies in one module"
```

---

### Task 2: Typed over-cap and rate-limit refusals in `faucet-api.ts`

**Files:**
- Modify: `src/lib/miden-chain/faucet-api.ts:1-5` (imports), `:119-120` (insert the classes after them, before `getPowChallenge` at `:122`), `:130-134` (`/pow` refusal), `:273` (`/get_tokens` refusal)
- Test: `src/lib/miden-chain/faucet-api.test.ts:2-10` (imports); new describe before `describe('mintFromMidenFaucet'` at `:778`

**Interfaces:**
- Consumes: `faucetCapFromRefusal`, `faucetRateLimitSeconds` (Task 1).
- Produces:
  - `export class FaucetAmountOverCapError extends Error { readonly cap: bigint }`, with constructor `(message: string, cap: bigint)` and `name = 'FaucetAmountOverCapError'`.
  - `export class FaucetRateLimitedError extends Error { readonly retryAfterSeconds: number | null }`, with constructor `(message: string, retryAfterSeconds: number | null)` and `name = 'FaucetRateLimitedError'`.
  - `getPowChallenge` and `requestTokens` reject with these on a 429, or on a 400 that names a cap. They reject with a plain `Error` otherwise, and the message never changes.

- [ ] **Step 1: Write the failing test**

In `src/lib/miden-chain/faucet-api.test.ts`, replace the import block at `:2-10`.

Before:
```ts
import {
  FaucetOutcomeUnknownError,
  faucetFetch,
  getFaucetApiUrl,
  getPowChallenge,
  mintFromMidenFaucet,
  requestTokens,
  solvePowChallenge
} from './faucet-api';
```
After:
```ts
import {
  FaucetAmountOverCapError,
  FaucetOutcomeUnknownError,
  FaucetRateLimitedError,
  faucetFetch,
  getFaucetApiUrl,
  getPowChallenge,
  mintFromMidenFaucet,
  requestTokens,
  solvePowChallenge
} from './faucet-api';
```

Insert this block immediately before the line `  describe('mintFromMidenFaucet', () => {` (`:778`):

```ts
  describe('a refusal the user can act on', () => {
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['Faucet PoW request', () => getPowChallenge('https://faucet-api.example', 'mtst1testaddress', 100_000_000n)],
      [
        'Faucet token request',
        () => requestTokens('https://faucet-api.example', 'mtst1testaddress', 100_000_000n, CHALLENGE_HEX, 42)
      ]
    ];

    it.each(calls)('%s types a rate limit, with the wait its body names', async (label, call) => {
      fetchMock.mockResolvedValue(errorResponse(429, 'Account is rate limited for 25 more seconds.'));

      const error = await call().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FaucetRateLimitedError);
      expect(error).toMatchObject({
        message: `${label} failed with status 429: Account is rate limited for 25 more seconds.`,
        retryAfterSeconds: 25
      });
    });

    it.each(calls)('%s types a rate limit whose body names no wait', async (_label, call) => {
      fetchMock.mockResolvedValue(errorResponse(429, 'Too many requests'));

      await expect(call()).rejects.toMatchObject({ name: 'FaucetRateLimitedError', retryAfterSeconds: null });
    });

    it.each(calls)('%s types an amount over the cap, with the cap the faucet names', async (label, call) => {
      const detail = 'requested amount 100000000 exceeds the maximum claimable amount of 10000000';
      fetchMock.mockResolvedValue(errorResponse(400, detail));

      const error = await call().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FaucetAmountOverCapError);
      expect(error).toMatchObject({ message: `${label} failed with status 400: ${detail}`, cap: 10_000_000n });
      expect(error).not.toBeInstanceOf(FaucetOutcomeUnknownError);
    });

    it.each(calls)('%s keeps any other refusal a plain error', async (_label, call) => {
      fetchMock.mockResolvedValue(errorResponse(400, 'Please enter a valid recipient address'));

      const error = await call().catch((e: unknown) => e);

      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    });
  });

```

Mutation notes:
- **Rate limit:** return a plain `Error` for status 429 in `faucetRefusal`, and `toBeInstanceOf(FaucetRateLimitedError)` fails.
- **No wait:** default `retryAfterSeconds` to `0`, and `retryAfterSeconds: null` fails.
- **Over cap:** drop the `status === 400` branch, and `toBeInstanceOf(FaucetAmountOverCapError)` fails.
- **Plain error:** build `FaucetAmountOverCapError` for every 400, and the prototype assertion fails. This test passes before the change too; it guards the boundary.

The existing tests at `:142-148`, `:532-549`, `:741-755` and `:757-776` stay unchanged and must still pass. Jest 30's `equals` compares two Errors by message only (`@jest/expect-utils`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-api.test.ts --maxWorkers=2 -t 'a refusal the user can act on'`
Expected: FAIL with `Matcher error: expected value must be a function` (the classes do not exist yet), and `Expected: {"name": "FaucetRateLimitedError" ...}` / `Received: ... "name": "Error"`. The "keeps any other refusal a plain error" cases pass.

- [ ] **Step 3: Write the implementation**

In `src/lib/miden-chain/faucet-api.ts`, edit the imports at `:4-5`.

Before:
```ts
import { MIDEN_FAUCET_API_ENDPOINTS } from './constants';
import { spawnFaucetPowWorker } from './spawn-faucet-pow-worker';
```
After:
```ts
import { MIDEN_FAUCET_API_ENDPOINTS } from './constants';
import { faucetCapFromRefusal, faucetRateLimitSeconds } from './faucet-protocol';
import { spawnFaucetPowWorker } from './spawn-faucet-pow-worker';
```

Insert the classes and the builder immediately before `export async function getPowChallenge(` (`:122`). The anchor is the two lines `  return attempt(read);\n}` at `:119-120`; insert after them.

```ts

/** The faucet refused an amount over its cap and named the cap, in base units. Nothing was minted. */
export class FaucetAmountOverCapError extends Error {
  constructor(
    message: string,
    readonly cap: bigint
  ) {
    super(message);
    this.name = 'FaucetAmountOverCapError';
  }
}

/** The faucet refused because this account asked too recently; `retryAfterSeconds` is the wait its body names. */
export class FaucetRateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = 'FaucetRateLimitedError';
  }
}

// Every refusal keeps the message it always had; the two the user can act on also carry what the faucet named. The
// wait comes from the body because a cross-origin page cannot read Retry-After: the faucet exposes no headers.
function faucetRefusal(label: string, status: number, detail: string): Error {
  const message = `${label} failed with status ${status}: ${detail}`;
  if (status === 429) return new FaucetRateLimitedError(message, faucetRateLimitSeconds(detail));
  const cap = status === 400 ? faucetCapFromRefusal(detail) : null;
  return cap === null ? new Error(message) : new FaucetAmountOverCapError(message, cap);
}
```

Edit the `/pow` refusal at `:132-133`.

Before:
```ts
      const detail = await response.text().catch(() => '');
      throw new Error(`Faucet PoW request failed with status ${response.status}: ${detail}`);
```
After:
```ts
      const detail = await response.text().catch(() => '');
      throw faucetRefusal('Faucet PoW request', response.status, detail);
```

Edit the `/get_tokens` refusal at `:273`.

Before:
```ts
  const failure = new Error(`Faucet token request failed with status ${outcome.status}: ${outcome.detail}`);
```
After:
```ts
  const failure = faucetRefusal('Faucet token request', outcome.status, outcome.detail);
```

A 5xx never matches 429 or 400, so `FaucetOutcomeUnknownError` keeps wrapping a plain `Error` as its cause.

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-api.test.ts --maxWorkers=2 && npx prettier --write src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts && npx eslint --max-warnings 0 src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts`
Expected: PASS, the whole file green, including the pre-existing 429 and 400 message tests.

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts && git commit -m "fix(faucet): type the faucet's over-cap and rate-limit refusals"
```

---

### Task 3: Drop `is_private_note` and the `tx_id`/`txId` mapping (wallet side)

**Files:**
- Modify: `src/lib/miden-chain/faucet-api.ts:12-15` (`MintedNote`), `:226-229` (params), `:242-243` (response mapping). These are the original line numbers; Task 2 shifts everything below `:120` by about 32 lines, so anchor on the text.
- Test: `src/lib/miden-chain/faucet-api.test.ts:446-470` and the chain test; `src/lib/wallet-prompts.test.ts` (18 mocks)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export interface MintedNote { noteId: string }`. `requestTokens` and `mintFromMidenFaucet` resolve to exactly `{ noteId }`. No caller outside `faucet-api.ts` reads `txId`; `faucet()` discards the result.

- [ ] **Step 1: Write the failing test**

In `src/lib/miden-chain/faucet-api.test.ts`, replace this test.

Before (exact):
```ts
    it('requests a public note with the solved challenge', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ tx_id: '0xtx', note_id: '0xnote' }));

      const result = await requestTokens(
        'https://faucet-api.example',
        'mtst1testaddress',
        100_000_000n,
        CHALLENGE_HEX,
        42
      );

      const expectedParams = new URLSearchParams({
        account_id: 'mtst1testaddress',
        is_private_note: 'false',
        asset_amount: '100000000',
        challenge: CHALLENGE_HEX,
        nonce: '42'
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://faucet-api.example/get_tokens?${expectedParams}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual({ txId: '0xtx', noteId: '0xnote' });
    });
```
After:
```ts
    it('requests the grant with the solved challenge and reads back its note id alone', async () => {
      // Faucet 0.17.0 dropped `is_private_note` (every grant is public) and answers with `note_id` only.
      fetchMock.mockResolvedValue(jsonResponse({ note_id: '0xnote' }));

      const result = await requestTokens(
        'https://faucet-api.example',
        'mtst1testaddress',
        100_000_000n,
        CHALLENGE_HEX,
        42
      );

      const expectedParams = new URLSearchParams({
        account_id: 'mtst1testaddress',
        asset_amount: '100000000',
        challenge: CHALLENGE_HEX,
        nonce: '42'
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://faucet-api.example/get_tokens?${expectedParams}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toStrictEqual({ noteId: '0xnote' });
    });
```

In the chain test (`'chains challenge, solve, and token request against the default network endpoint'`), make two replacements.

Replace:
```ts
      expect(tokensUrl.searchParams.get('is_private_note')).toBe('false');
```
with:
```ts
      expect(tokensUrl.searchParams.has('is_private_note')).toBe(false);
```

Then replace the now-unique:
```ts
      expect(result).toEqual({ txId: '0xtx', noteId: '0xnote' });
```
with:
```ts
      expect(result).toStrictEqual({ noteId: '0xnote' });
```

That test's fetch mock still answers `{ tx_id: '0xtx', note_id: '0xnote' }`, which proves an extra field from an older faucet is ignored.

Mutation notes:
- **Grant request:** put `is_private_note: 'false'` back in the params, and the `toHaveBeenCalledWith` URL fails. Put back only `txId: json.tx_id`, and `toStrictEqual` fails on the `txId: undefined` key.
- **Chain test:** put the param back, and `.has(...)).toBe(false)` fails. Put back only `txId`, and `toStrictEqual` fails on `"txId": "0xtx"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-api.test.ts --maxWorkers=2 -t 'reads back its note id alone|chains challenge'`

Expected: FAIL. In each test the first failing assertion is the `is_private_note` one, so the `toStrictEqual` below it does not run yet:
- "reads back its note id alone": the `toHaveBeenCalledWith` URL diff shows `is_private_note=false`.
- The chain test: `Expected: false` / `Received: true` for `has('is_private_note')`.

- [ ] **Step 3: Write the implementation**

In `src/lib/miden-chain/faucet-api.ts`, edit `MintedNote`.

Before:
```ts
export interface MintedNote {
  txId: string;
  noteId: string;
}
```
After:
```ts
// Faucet 0.17.0 answers a grant with its note id alone.
export interface MintedNote {
  noteId: string;
}
```

Edit the params.

Before:
```ts
  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
```
After:
```ts
  const params = new URLSearchParams({
    account_id: accountId,
    asset_amount: amount.toString(),
```

Edit the response mapping.

Before:
```ts
      const json: { tx_id: string; note_id: string } = await response.json();
      return { kind: 'minted', note: { txId: json.tx_id, noteId: json.note_id } };
```
After:
```ts
      const json: { note_id: string } = await response.json();
      return { kind: 'minted', note: { noteId: json.note_id } };
```

Drop `txId` from the 18 `wallet-prompts.test.ts` mocks. Once it is gone, `yarn ts` rejects them as an excess property, because tsconfig includes the tests.

```bash
cd ~/miden/wt-fund-faucet && perl -pi -e "s/\\{ txId: '0xtx', noteId: '0xnote' \\}/{ noteId: '0xnote' }/g" src/lib/wallet-prompts.test.ts && git grep -n "txId: '0xtx'" -- src/lib/wallet-prompts.test.ts src/lib/miden-chain/faucet-api.test.ts; echo "grep exit=$?"
```
Expected: no matching lines and `grep exit=1`.

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts --maxWorkers=2 && npx prettier --write src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts && npx eslint --max-warnings 0 src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts`
Expected: PASS for both files.

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts && git commit -m "fix(faucet): stop sending is_private_note and reading tx_id, both removed in faucet 0.17.0"
```

---

### Task 4: Ask for the offered amount and retry once at the cap

**Files:**
- Modify: `src/lib/miden-chain/faucet-api.ts`:
  - the import block;
  - `mintFromMidenFaucet` and `getFaucetBaseAmount`, which becomes `fetchFaucetMetadata`; these are the last two functions.
- Test:
  - `src/lib/miden-chain/faucet-api.test.ts`: a new describe appended inside the top-level describe;
  - `src/lib/wallet-prompts.test.ts`: a guard test after `:787`.

**Interfaces:**
- Consumes:
  - `faucetGrantAmount` (Task 1);
  - `FaucetAmountOverCapError` and `FaucetRateLimitedError` (Task 2; the second only in the tests).
- Produces:
  - `mintFromMidenFaucet(address, amount?, signal?, onBeforeSubmit?, onMayMint?): Promise<MintedNote>`, with the same signature. With `amount === undefined` it asks for `faucetGrantAmount(metadata)`. On a `FaucetAmountOverCapError` with `0n < cap < chosen` it runs one more `/pow` -> solve -> `onBeforeSubmit` -> `/get_tokens` at `cap`.
  - `fetchFaucetMetadata(baseUrl, signal?): Promise<unknown>`, module-private: the raw `/get_metadata` reply, refused with the current metadata message on a non-OK status.

- [ ] **Step 1: Write the failing tests**

In `src/lib/miden-chain/faucet-api.test.ts`, the imports from Task 2 already cover every name the new block uses (`FaucetAmountOverCapError`, `FaucetRateLimitedError`, `mintFromMidenFaucet`, and the file's own `fetchMock`, `spawnWorkerMock`, `jsonResponse`, `errorResponse`, `MockResponse` and `CHALLENGE_HEX`).

The file ends with:
```ts
      expect(onBeforeSubmit).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('/pow');
    });
  });
});
```
Insert the block below between its last `  });` and the final `});`:

```ts

  describe('the grant amount and the cap retry', () => {
    const ADDRESS = 'mtst1testaddress';
    // Faucet 0.17.1 (testnet) offers token amounts; 0.17.0 (devnet) does not.
    const TESTNET_METADATA = {
      version: '0.17.1',
      decimals: 6,
      base_amount: 100_000_000,
      token_amounts: [1, 10, 100]
    };
    const DEVNET_METADATA = { version: '0.17.0', decimals: 6, base_amount: 100_000_000 };
    const overCap = (requested: bigint, cap: bigint) =>
      `requested amount ${requested} exceeds the maximum claimable amount of ${cap}`;
    const requests = (path: string) =>
      fetchMock.mock.calls.map(([url]) => new URL(url)).filter(url => url.pathname === path);
    const powAmounts = () => requests('/pow').map(url => url.searchParams.get('amount'));
    const grantAmounts = () => requests('/get_tokens').map(url => url.searchParams.get('asset_amount'));

    /** Answers the metadata, then each /pow and /get_tokens from its own queue, OK once a queue is empty. */
    function serveFaucet(metadata: unknown, queued: { pow?: MockResponse[]; tokens?: MockResponse[] } = {}) {
      const pow = [...(queued.pow ?? [])];
      const tokens = [...(queued.tokens ?? [])];
      fetchMock.mockImplementation(async (url: string) => {
        const { pathname } = new URL(url);
        if (pathname === '/get_metadata') return jsonResponse(metadata);
        if (pathname === '/pow') return pow.shift() ?? jsonResponse({ challenge: CHALLENGE_HEX, target: 2 ** 64 });
        return tokens.shift() ?? jsonResponse({ note_id: '0xnote' });
      });
    }

    describe('mintFromMidenFaucet', () => {
      it('asks for the largest token amount the faucet offers, in base units', async () => {
        serveFaucet({ ...TESTNET_METADATA, token_amounts: [1, 10] });

        await mintFromMidenFaucet(ADDRESS);

        expect(powAmounts()).toEqual(['10000000']);
        expect(grantAmounts()).toEqual(['10000000']);
      });

      it('asks for an offered token amount when base_amount is malformed', async () => {
        serveFaucet({ decimals: 6, base_amount: 'x', token_amounts: [5] });

        await mintFromMidenFaucet(ADDRESS);

        expect(powAmounts()).toEqual(['5000000']);
      });

      it('asks once more at the cap a challenge refusal names, from a fresh challenge (testnet)', async () => {
        serveFaucet(TESTNET_METADATA, { pow: [errorResponse(400, overCap(100_000_000n, 10_000_000n))] });
        const onBeforeSubmit = jest.fn(async () => undefined);

        await expect(mintFromMidenFaucet(ADDRESS, undefined, undefined, onBeforeSubmit)).resolves.toStrictEqual({
          noteId: '0xnote'
        });

        expect(powAmounts()).toEqual(['100000000', '10000000']);
        expect(grantAmounts()).toEqual(['10000000']);
        expect(spawnWorkerMock).toHaveBeenCalledTimes(1);
        expect(onBeforeSubmit).toHaveBeenCalledTimes(1);
      });

      it('asks once more at the cap a token refusal names, solving a new challenge (devnet)', async () => {
        serveFaucet(DEVNET_METADATA, { tokens: [errorResponse(400, overCap(100_000_000n, 10_000_000n))] });
        const onBeforeSubmit = jest.fn(async () => undefined);
        const onMayMint = jest.fn();

        await mintFromMidenFaucet(ADDRESS, undefined, undefined, onBeforeSubmit, onMayMint);

        expect(powAmounts()).toEqual(['100000000', '10000000']);
        expect(grantAmounts()).toEqual(['100000000', '10000000']);
        expect(spawnWorkerMock).toHaveBeenCalledTimes(2);
        expect(onBeforeSubmit).toHaveBeenCalledTimes(2);
        // Refused (nothing minting), then the retry goes out and is accepted.
        expect(onMayMint.mock.calls).toEqual([[true], [false], [true], [true]]);
      });

      it('asks at most twice, whatever the second refusal names', async () => {
        serveFaucet(TESTNET_METADATA, {
          pow: [
            errorResponse(400, overCap(100_000_000n, 10_000_000n)),
            errorResponse(400, overCap(10_000_000n, 1_000_000n))
          ]
        });

        const error = await mintFromMidenFaucet(ADDRESS).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(FaucetAmountOverCapError);
        expect(error).toMatchObject({ cap: 1_000_000n });
        expect(powAmounts()).toEqual(['100000000', '10000000']);
      });

      it('surfaces a rate limit on the retry as the faucet sent it, and asks no third time', async () => {
        serveFaucet(DEVNET_METADATA, {
          tokens: [
            errorResponse(400, overCap(100_000_000n, 10_000_000n)),
            errorResponse(429, 'Account is rate limited for 25 more seconds.')
          ]
        });
        const onMayMint = jest.fn();

        const minting = mintFromMidenFaucet(ADDRESS, undefined, undefined, undefined, onMayMint);
        const error = await minting.catch((e: unknown) => e);

        expect(error).toBeInstanceOf(FaucetRateLimitedError);
        expect(error).toMatchObject({ retryAfterSeconds: 25 });
        expect(grantAmounts()).toEqual(['100000000', '10000000']);
        // Both refusals say nothing is minting, so the card may offer the request again.
        expect(onMayMint.mock.calls).toEqual([[true], [false], [true], [false]]);
      });

      it.each([
        ['the cap equals the request', overCap(100_000_000n, 100_000_000n)],
        ['the cap is above the request', overCap(100_000_000n, 1_000_000_000n)],
        ['the cap is zero', overCap(100_000_000n, 0n)],
        ['the refusal names no cap', 'requested amount 100000000 exceeds the maximum claimable amount'],
        ['the refusal is about something else', 'Please enter a valid recipient address']
      ])('asks only once when %s', async (_case, detail) => {
        serveFaucet(TESTNET_METADATA, { pow: [errorResponse(400, detail)] });

        await expect(mintFromMidenFaucet(ADDRESS)).rejects.toThrow(`Faucet PoW request failed with status 400: ${detail}`);

        expect(powAmounts()).toEqual(['100000000']);
      });

      it('asks only once for an amount the caller chose', async () => {
        serveFaucet(TESTNET_METADATA, { pow: [errorResponse(400, overCap(100_000_000n, 10_000_000n))] });

        await expect(mintFromMidenFaucet(ADDRESS, 100_000_000n)).rejects.toBeInstanceOf(FaucetAmountOverCapError);

        expect(powAmounts()).toEqual(['100000000']);
        expect(requests('/get_metadata')).toHaveLength(0);
      });

      it('sends no second challenge when the caller aborts on an over-cap refusal', async () => {
        const controller = new AbortController();
        const reason = new Error('Faucet request timed out');
        fetchMock.mockImplementation(async (url: string) => {
          if (new URL(url).pathname === '/get_metadata') return jsonResponse(TESTNET_METADATA);
          // The request's timeout fires while the refusal is on its way back.
          controller.abort(reason);
          return errorResponse(400, overCap(100_000_000n, 10_000_000n));
        });

        await expect(mintFromMidenFaucet(ADDRESS, undefined, controller.signal)).rejects.toBe(reason);

        expect(powAmounts()).toEqual(['100000000']);
        expect(spawnWorkerMock).not.toHaveBeenCalled();
      });
    });
  });
```

The 429 replies here carry no `Retry-After`, so `faucetFetch` hands them straight to the refusal reader instead of waiting and resending.

Mutation notes:
- **Largest amount:** go back to `base_amount`, and `['10000000']` fails.
- **Malformed base:** read only `base_amount`, and the test rejects `base_amount`.
- **Testnet retry:** drop the `catch` retry, and the call rejects instead of resolving.
- **Devnet retry:** retry by re-sending the old challenge instead of a fresh `mint(cap)`, and `powAmounts` and `spawnWorkerMock` 2 fail.
- **At most twice:** wrap the retry in a loop, and `powAmounts` grows past 2.
- **Rate limit on the retry:**
  - rethrow the first refusal when the retry fails, and `toBeInstanceOf(FaucetRateLimitedError)` fails;
  - retry again on any typed refusal, and a third `/get_tokens` goes out and the call resolves.
- **`it.each`:**
  - drop `error.cap >= chosen`, and the equal and above cases ask twice;
  - write `error.cap > chosen`, and the equal case asks twice;
  - drop `error.cap <= 0n`, and the zero case asks at 0.
- **Caller's amount:** drop the `amount !== undefined` early return, and metadata is fetched.
- **Abort:** run the retry without the caller's signal, and a second `/pow` is sent and the rejection is not `reason`.

Then add the guard test in `src/lib/wallet-prompts.test.ts`, immediately after:
```ts
    // The flag carries when the token request went out: its mint's arrival window starts there.
    expect(seen).toEqual([marker, { ...marker, submitted: true, submittedAt: expect.any(Number) }]);
  });
```
insert:
```ts

  it('lets a request refused over the cap go out again at the cap, flagged anew', async () => {
    const marker = { requestedAt: 1_000, baselineNoteIds: [] };
    const flags: Array<number | undefined> = [];
    mintFromMidenFaucetMock.mockImplementation(
      async (
        _address: string,
        _amount: bigint | undefined,
        _signal?: AbortSignal,
        beforeSubmit?: () => Promise<void>,
        onMayMint?: (mayMint: boolean) => void
      ) => {
        // Devnet refuses over the cap only at the token request: nothing was minted.
        await beforeSubmit?.();
        onMayMint?.(true);
        onMayMint?.(false);
        flags.push((await fetchFaucetFundingMarker('accountCapped'))?.submittedAt);
        // The retry at the cap passes the same pre-send check and is flagged again.
        await beforeSubmit?.();
        onMayMint?.(true);
        flags.push((await fetchFaucetFundingMarker('accountCapped'))?.submittedAt);
        return { noteId: '0xnote' };
      }
    );

    await expect(faucet('accountCapped', marker)).resolves.toBeUndefined();

    expect(flags).toEqual([expect.any(Number), expect.any(Number)]);
    expect(flags[1]!).toBeGreaterThanOrEqual(flags[0]!);
    expect(getFaucetRequestSettledAt('accountCapped', 1_000)).not.toBeNull();
  });
```
Mutation note: add `|| stored.submitted` to the pre-send check in `wallet-prompts.ts:735`. The second `beforeSubmit` then throws `Faucet request was ended before it was sent`, and `resolves.toBeUndefined()` fails. This guard passes before and after the task. It pins the existing behaviour the devnet retry relies on. The existing test "reports a timeout after the faucet refused the token request as a plain failure, safe to retry" (`:705-735`) already covers a timeout landing between the two attempts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts --maxWorkers=2`

Expected: FAIL in `faucet-api.test.ts`:
- `Expected: ["10000000"]` / `Received: ["100000000"]`;
- `Faucet metadata base_amount must be a positive safe integer` for the malformed-base case;
- `Faucet PoW request failed with status 400: requested amount 100000000 exceeds the maximum claimable amount of 10000000` for the testnet retry, and the matching `Faucet token request failed with status 400: ...` for the devnet retry;
- `cap: 10000000n` where `1000000n` is expected, for "asks at most twice";
- `Received constructor: FaucetAmountOverCapError` for the rate limit on the retry;
- the abort case rejects with the over-cap refusal instead of the caller's reason.

The "asks only once" cases and the new `wallet-prompts.test.ts` guard pass: they pin the boundary.

- [ ] **Step 3: Write the implementation**

In `src/lib/miden-chain/faucet-api.ts`, replace the faucet-protocol import (after Task 2).

Before:
```ts
import { faucetCapFromRefusal, faucetRateLimitSeconds } from './faucet-protocol';
```
After:
```ts
import { faucetCapFromRefusal, faucetGrantAmount, faucetRateLimitSeconds } from './faucet-protocol';
```

Replace everything from `export async function mintFromMidenFaucet(` to the end of the file, that is `mintFromMidenFaucet` and `getFaucetBaseAmount`.

Before (exact):
```ts
export async function mintFromMidenFaucet(
  address: string,
  amount?: bigint,
  signal?: AbortSignal,
  // Awaited after the proof of work and immediately before the token request is
  // sent: the last point at which nothing can have been minted yet.
  onBeforeSubmit?: () => Promise<void>,
  onMayMint?: (mayMint: boolean) => void
): Promise<MintedNote> {
  const baseUrl = getFaucetApiUrl();
  const resolvedAmount = amount ?? (await getFaucetBaseAmount(baseUrl, signal));
  const { challenge, target } = await getPowChallenge(baseUrl, address, resolvedAmount, signal);
  const nonce = await solvePowChallenge(challenge, target, { signal });
  await onBeforeSubmit?.();
  return requestTokens(baseUrl, address, resolvedAmount, challenge, nonce, signal, onMayMint);
}

async function getFaucetBaseAmount(baseUrl: string, signal?: AbortSignal): Promise<bigint> {
  return faucetFetch(`${baseUrl}/get_metadata`, { signal }, async response => {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Faucet metadata request failed with status ${response.status}: ${detail}`);
    }
    const metadata: unknown = await response.json();
    const baseAmount = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'base_amount') : undefined;
    if (typeof baseAmount !== 'number' || !Number.isSafeInteger(baseAmount) || baseAmount <= 0) {
      throw new Error('Faucet metadata base_amount must be a positive safe integer');
    }
    return BigInt(baseAmount);
  });
}
```
After:
```ts
export async function mintFromMidenFaucet(
  address: string,
  amount?: bigint,
  signal?: AbortSignal,
  // Awaited after the proof of work and immediately before the token request is
  // sent: the last point at which nothing can have been minted yet.
  onBeforeSubmit?: () => Promise<void>,
  onMayMint?: (mayMint: boolean) => void
): Promise<MintedNote> {
  const baseUrl = getFaucetApiUrl();
  const mint = async (value: bigint): Promise<MintedNote> => {
    const { challenge, target } = await getPowChallenge(baseUrl, address, value, signal);
    const nonce = await solvePowChallenge(challenge, target, { signal });
    await onBeforeSubmit?.();
    return requestTokens(baseUrl, address, value, challenge, nonce, signal, onMayMint);
  };
  if (amount !== undefined) return mint(amount);

  const metadata = await fetchFaucetMetadata(baseUrl, signal);
  const chosen = faucetGrantAmount(metadata);
  try {
    return await mint(chosen);
  } catch (error) {
    // The faucet refuses an amount over its cap before anything is minted, and names the cap. Ask once more for
    // exactly that from a fresh challenge (the first one is bound to the refused amount); a second refusal stands.
    if (!(error instanceof FaucetAmountOverCapError) || error.cap <= 0n || error.cap >= chosen) throw error;
    return mint(error.cap);
  }
}

async function fetchFaucetMetadata(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  return faucetFetch(`${baseUrl}/get_metadata`, { signal }, async response => {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Faucet metadata request failed with status ${response.status}: ${detail}`);
    }
    const metadata: unknown = await response.json();
    return metadata;
  });
}
```

`wallet-prompts.ts` needs no code change.

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts --maxWorkers=2 && npx prettier --write src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts && npx eslint --max-warnings 0 src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts`

Expected: PASS. The pre-existing metadata tests (`'uses advertised base_amount %i unchanged'`, `'rejects malformed metadata base_amount %s before PoW or mint'`, `'bounds and cancels metadata body reads'`) also pass.

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add src/lib/miden-chain/faucet-api.ts src/lib/miden-chain/faucet-api.test.ts src/lib/wallet-prompts.test.ts && git commit -m "fix(faucet): ask for the largest offered amount and retry once at the cap the faucet names"
```

---

### Task 5: Plain-language refusal copy on the Home card

**Files:**
- Modify: `src/app/templates/HomePrompts.tsx:24` (import), after `:175` (helper), `:261` (state type), `:563` and `:656` (setter), `:990-997` (render)
- Modify: `public/_locales/en/en.json` after `:407`; `public/_locales/en/messages.json` after the `faucetRequestAgainAction` entry (`:1871-1874`)
- Test: `src/app/templates/HomePrompts.test.tsx:17` (import), `:68-74` (`t` mock); new describe after `:1722`

**Interfaces:**
- Consumes: `FaucetAmountOverCapError` and `FaucetRateLimitedError` (Task 2).
- Produces: copy keys `faucetRateLimitedWait` (placeholder `$seconds$`), `faucetRateLimited` and `faucetOverCap`. `faucetError` becomes `Error | null`.

- [ ] **Step 1: Write the failing test**

In `src/app/templates/HomePrompts.test.tsx`, replace `:17`.

Before:
```ts
import { FaucetOutcomeUnknownError } from 'lib/miden-chain/faucet-api';
```
After:
```ts
import { FaucetAmountOverCapError, FaucetOutcomeUnknownError, FaucetRateLimitedError } from 'lib/miden-chain/faucet-api';
```

Replace the `t` mock body at `:70-73`.

Before:
```ts
    t: (key: string, values?: { amount?: string; count?: number }) => {
      const value = values?.amount ?? values?.count;
```
After:
```ts
    t: (key: string, values?: { amount?: string; count?: number; seconds?: string }) => {
      const value = values?.amount ?? values?.count ?? values?.seconds;
```

After:
```ts
    await waitFor(() => expect(mockFaucet).toHaveBeenCalledTimes(2));
    // Retrying clears the previous error from the card.
    expect(faucetCard).not.toHaveTextContent('rate limited');
  });
```
insert:
```ts

  describe('a faucet refusal the user can act on', () => {
    const RATE_LIMITED = 'Faucet token request failed with status 429: Account is rate limited for 25 more seconds.';
    const OVER_CAP =
      'Faucet PoW request failed with status 400: requested amount 100000000 exceeds the maximum claimable amount of 10000000';

    const renderFaucetCard = async () => {
      render(
        <HomePrompts
          account={account}
          balances={zeroBalance}
          balancesLoading={false}
          claimableNotes={[]}
          fundingNotes={[]}
          tokenPrices={{}}
        />
      );
      await act(async () => {});
      return screen.getAllByTestId('prompt-card')[0]!;
    };
    const tapFund = async (card: HTMLElement) => {
      fireEvent.click(within(card).getByRole('button', { name: 'faucetPromptTitle' }));
      await waitFor(() => expect(card).toHaveAttribute('data-status', 'failure'));
    };

    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockUseWalletPromptStorage.mockReturnValue(makePromptState());
    });

    it.each([
      { seconds: 25, copy: 'faucetRateLimitedWait:25' },
      { seconds: 1, copy: 'faucetRateLimited' },
      { seconds: 0, copy: 'faucetRateLimited' },
      { seconds: null, copy: 'faucetRateLimited' }
    ])('says a rate limit of $seconds seconds in plain words, never the raw reply', async ({ seconds, copy }) => {
      mockFaucet.mockRejectedValueOnce(new FaucetRateLimitedError(RATE_LIMITED, seconds));
      const card = await renderFaucetCard();

      await tapFund(card);

      expect(within(card).getByText(copy)).toBeInTheDocument();
      expect(card).not.toHaveTextContent('rate limited for');
    });

    it('says an amount over the faucet cap in plain words', async () => {
      mockFaucet.mockRejectedValueOnce(new FaucetAmountOverCapError(OVER_CAP, 10_000_000n));
      const card = await renderFaucetCard();

      await tapFund(card);

      expect(within(card).getByText('faucetOverCap')).toBeInTheDocument();
      expect(card).not.toHaveTextContent('maximum claimable');
    });

    it('says the same when the card re-attaches to a request the faucet refuses', async () => {
      let rejectInFlight!: (error: Error) => void;
      mockGetInFlightFaucetRequest.mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          rejectInFlight = reject;
        })
      );
      const card = await renderFaucetCard();

      await act(async () => {
        rejectInFlight(new FaucetRateLimitedError(RATE_LIMITED, 25));
      });

      await waitFor(() => expect(card).toHaveAttribute('data-status', 'failure'));
      expect(within(card).getByText('faucetRateLimitedWait:25')).toBeInTheDocument();
    });
  });
```

Mutation notes:
- **Rate limit:** return `error.message` for `FaucetRateLimitedError` in `faucetFailureBody`, and `getByText('faucetRateLimitedWait:25')` fails. Change `seconds > 1` to `seconds > 0`, and the 1-second case shows `faucetRateLimitedWait:1`.
- **Over cap:** drop the `FaucetAmountOverCapError` branch, and `getByText('faucetOverCap')` fails.
- **Re-attach:** at `:563` store `new Error(error.message)` instead of the error, and `getByText('faucetRateLimitedWait:25')` fails.

The plain-Error path keeps the raw message. That is pinned by the existing #425 test at `:1689-1722` and by `:2006-2039`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/app/templates/HomePrompts.test.tsx --maxWorkers=2 -t 'a faucet refusal the user can act on'`
Expected: FAIL with `Unable to find an element with the text: faucetRateLimitedWait:25`, and `Unable to find an element with the text: faucetOverCap`.

- [ ] **Step 3: Write the implementation**

In `src/app/templates/HomePrompts.tsx`, replace `:24`.

Before:
```ts
import { FaucetOutcomeUnknownError } from 'lib/miden-chain/faucet-api';
```
After:
```ts
import { FaucetAmountOverCapError, FaucetOutcomeUnknownError, FaucetRateLimitedError } from 'lib/miden-chain/faucet-api';
```

After `:175`:
```ts
const formatUsdTotal = (total: number | null): string | undefined => (total === null ? undefined : formatUsd(total));
```
insert:
```ts

type Translate = (key: string, options?: Record<string, unknown>) => string;

// A refusal the user can act on reads in plain words; any other failure keeps its own message (#425).
const faucetFailureBody = (error: Error, t: Translate): string => {
  if (error instanceof FaucetRateLimitedError) {
    const seconds = error.retryAfterSeconds;
    // A wait of a second or less needs no number, and "1 seconds" reads wrong.
    return seconds !== null && seconds > 1
      ? t('faucetRateLimitedWait', { seconds: String(seconds) })
      : t('faucetRateLimited');
  }
  if (error instanceof FaucetAmountOverCapError) return t('faucetOverCap');
  return error.message;
};
```

Replace `:261`. The comment above it stays.

Before:
```ts
  const [faucetError, setFaucetError] = useState<string | null>(null);
```
After:
```ts
  const [faucetError, setFaucetError] = useState<Error | null>(null);
```

Replace both setters (`:563` and `:656`, at different indents) with one Edit using `replace_all: true` on this exact text.

Before:
```ts
setFaucetError(error instanceof Error ? error.message : String(error));
```
After:
```ts
setFaucetError(error instanceof Error ? error : new Error(String(error)));
```

Replace `:990-997`.

Before:
```ts
            // On failure the body carries the faucet's actual message, so a rate
            // limit, a rejected amount, and an outage read differently. Otherwise a
            // user holding tokens but no MIDEN reads "Add tokens" and reasonably
            // concludes the prompt is not about them -- name the missing asset.
            body:
              faucetStatusIndicator === 'failure' && faucetError
                ? faucetError
```
After:
```ts
            // On failure the body says what went wrong: a rate limit or a refused amount
            // in plain words, anything else in the faucet's own message, so each reads
            // differently. Otherwise a user holding tokens but no MIDEN reads "Add tokens"
            // and reasonably concludes the prompt is not about them -- name the missing asset.
            body:
              faucetStatusIndicator === 'failure' && faucetError
                ? faucetFailureBody(faucetError, t)
```

The memo dependency list at `:1066-1078` already holds `faucetError` and `t`.

In `public/_locales/en/en.json`, after `:407`:
```json
  "faucetRequestAgainAction": "Request again",
```
insert:
```json
  "faucetRateLimitedWait": "You requested funds a moment ago. Try again in $seconds$ seconds.",
  "faucetRateLimited": "You requested funds a moment ago. Try again shortly.",
  "faucetOverCap": "The faucet can't send funds right now. Try again later.",
```

In `public/_locales/en/messages.json`, after:
```json
  "faucetRequestAgainAction": {
    "message": "Request again",
    "englishSource": "Request again"
  },
```
insert:
```json
  "faucetRateLimitedWait": {
    "message": "You requested funds a moment ago. Try again in $seconds$ seconds.",
    "englishSource": "You requested funds a moment ago. Try again in $seconds$ seconds.",
    "placeholders": {
      "seconds": {
        "content": "$1"
      }
    }
  },
  "faucetRateLimited": {
    "message": "You requested funds a moment ago. Try again shortly.",
    "englishSource": "You requested funds a moment ago. Try again shortly."
  },
  "faucetOverCap": {
    "message": "The faucet can't send funds right now. Try again later.",
    "englishSource": "The faucet can't send funds right now. Try again later."
  },
```

This matches the shape `generateEnglishMessages()` writes, in en.json key order. The file has no final newline today; leave its end untouched, and never run prettier on it. Do not touch any other locale.

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/app/templates/HomePrompts.test.tsx src/lib/i18n/key-coverage.test.ts src/lib/i18n/locale-bundle-parity.test.ts --maxWorkers=2; npx prettier --write src/app/templates/HomePrompts.tsx src/app/templates/HomePrompts.test.tsx && npx eslint --max-warnings 0 src/app/templates/HomePrompts.tsx src/app/templates/HomePrompts.test.tsx && git diff --stat -- public/_locales`

Expected:
- `HomePrompts.test.tsx` passes.
- `key-coverage.test.ts` passes.
- In `locale-bundle-parity.test.ts`, exactly 13 cases fail, each listing only `faucetOverCap`, `faucetRateLimited` and `faucetRateLimitedWait` as missing. CI's `translations` job resolves them before the `unit` job runs.
  - 12 are `'%s translates every shipped English key it has a current translation for'` (de, es, fr, ja, ko, pl, pt, ru, tr, uk, zh_CN, zh_TW).
  - 1 is `'has a Spanish entry for every shipped English key (no English fallback)'`.
- These parity cases pass: `'every key in the en.json SOURCE reaches en/messages.json'` and `'en declares every $placeholder$ its messages use'`.
- `git diff --stat` lists only `public/_locales/en/en.json` (3 insertions) and `public/_locales/en/messages.json` (18 insertions).

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add src/app/templates/HomePrompts.tsx src/app/templates/HomePrompts.test.tsx public/_locales/en/en.json public/_locales/en/messages.json && git commit -m "fix(home): say a faucet rate limit or cap refusal in plain words"
```

---

### Task 6: The E2E public-faucet helper drops the removed wire fields

**Files:**
- Modify: `playwright/e2e/helpers/public-faucet.ts:172-176` (`requestGrant` signature), `:189-195` (params), `:205-206` (return), `:240` (`mintFromPublicFaucet` return type)
- Test:
  - `playwright/e2e/helpers/public-faucet.test.ts`: `txId` expectations at `:126, :160, :181, :204, :248, :270, :389`; the last test at `:419-432`; a new test before `:146`;
  - `playwright/e2e/helpers/miden-cli-fee.test.ts:101`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `mintFromPublicFaucet(baseUrl, accountId, amount?, retryDelayMs?, sleep?): Promise<{ noteId: string }>`. The amount logic is unchanged. Existing callers read only `noteId`: `miden-cli.ts:534-536`, `dapp-live-probe.ts:30`, `fee-faucet-discovery.spec.ts:49`.

- [ ] **Step 1: Write the failing tests**

Drop `txId` from every expectation in `playwright/e2e/helpers/public-faucet.test.ts`, single-line and multi-line. The `reply(200, { tx_id: '0xtx', note_id: NOTE_ID })` lines stay, to show an extra field from an older faucet is ignored.
```bash
cd ~/miden/wt-fund-faucet && perl -0pi -e "s/\\{\\s*txId: '0xtx',\\s*noteId: NOTE_ID\\s*\\}/{ noteId: NOTE_ID }/g" playwright/e2e/helpers/public-faucet.test.ts && grep -n "txId" playwright/e2e/helpers/public-faucet.test.ts
```
Expected: one line left, `txId: undefined`, inside the last test.

Replace that last test (`:419-432`).

Before:
```ts
it('accepts the released faucet response containing only the queued note ID', async () => {
  const prior = global.fetch;
  try {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challenge: '00', target: Number.MAX_SAFE_INTEGER }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ note_id: NOTE_ID }) });
    await expect(mintFromPublicFaucet('https://faucet.invalid', 'target', 1n)).resolves.toEqual({
      noteId: NOTE_ID,
      txId: undefined
    });
  } finally {
    global.fetch = prior;
  }
});
```
After:
```ts
it('accepts the released faucet response containing only the queued note ID', async () => {
  const prior = global.fetch;
  try {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ challenge: '00', target: Number.MAX_SAFE_INTEGER }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ note_id: NOTE_ID }) });
    await expect(mintFromPublicFaucet('https://faucet.invalid', 'target', 1n)).resolves.toStrictEqual({
      noteId: NOTE_ID
    });
  } finally {
    global.fetch = prior;
  }
});
```

Inside `describe('mintFromPublicFaucet', ...)`, insert immediately before the line `  it('retains one advertised amount across server and rate-limit retries', async () => {` (`:146`):
```ts
  it('sends no is_private_note, which faucet 0.17.0 removed', async () => {
    const urls = serve([reply(200, { challenge: 'aa', target: EASY_TARGET }), reply(200, { note_id: NOTE_ID })]);
    await mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0);
    expect(new URL(urls[1]!).searchParams.has('is_private_note')).toBe(false);
  });

```

In `playwright/e2e/helpers/miden-cli-fee.test.ts`, replace `:101`.

Before:
```ts
    mint.mockReset().mockResolvedValue({ txId: 'tx', noteId });
```
After:
```ts
    mint.mockReset().mockResolvedValue({ noteId });
```
This is type-level only. Once the helper returns `{ noteId: string }`, the old literal is an excess property and `yarn ts` (CI) fails on it; jest passes either way. The D1 scan pins it locally.

Mutation notes:
- **Note ID only:** put `txId` back in `requestGrant`'s return, and the perl-updated `toEqual({ noteId: NOTE_ID })` assertions fail on `"txId": "0xtx"`, and the last test's `toStrictEqual` fails on `"txId": undefined`.
- **is_private_note:** put the param back, and `has(...)` is true.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest playwright/e2e/helpers/public-faucet.test.ts --maxWorkers=2`
Expected: FAIL:
- the perl-updated tests report `Expected: {"noteId": "0x0101..."}` / `Received: {"noteId": "0x0101...", "txId": "0xtx"}`;
- the last test reports `Received: {"noteId": "0x0101...", "txId": undefined}`;
- the new test reports `Expected: false` / `Received: true`.

- [ ] **Step 3: Write the implementation**

In `playwright/e2e/helpers/public-faucet.ts`, make four replacements.

`requestGrant` signature (`:172-176`).

Before:
```ts
async function requestGrant(
  baseUrl: string,
  accountId: string,
  amount: bigint
): Promise<{ txId?: string; noteId: string }> {
```
After:
```ts
async function requestGrant(baseUrl: string, accountId: string, amount: bigint): Promise<{ noteId: string }> {
```

Params (`:189-192`).

Before:
```ts
  const params = new URLSearchParams({
    account_id: accountId,
    is_private_note: 'false',
    asset_amount: amount.toString(),
```
After:
```ts
  const params = new URLSearchParams({
    account_id: accountId,
    asset_amount: amount.toString(),
```

Return (`:205-206`).

Before:
```ts
    const txId = Reflect.get(json as object, 'tx_id');
    return { txId: typeof txId === 'string' ? txId : undefined, noteId };
```
After:
```ts
    return { noteId };
```

`mintFromPublicFaucet` return type (`:240`).

Before:
```ts
): Promise<{ txId?: string; noteId: string }> {
  let resolvedAmount = amount;
```
After:
```ts
): Promise<{ noteId: string }> {
  let resolvedAmount = amount;
```

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && find playwright/e2e/helpers -maxdepth 1 -name '*.test.ts' | xargs yarn jest --maxWorkers=2 && npx prettier --write playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-faucet.test.ts playwright/e2e/helpers/miden-cli-fee.test.ts && npx eslint --max-warnings 0 playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-faucet.test.ts playwright/e2e/helpers/miden-cli-fee.test.ts && yarn lint:e2e`

Expected:
- every helper suite passes, including `dapp-live-probe.test.ts`, `funding-source.test.ts`, `miden-cli-mint.test.ts`, `miden-cli-fee.test.ts` and `dapp-cells.test.ts`;
- no eslint output;
- `lint:e2e` reports no new violations.

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-faucet.test.ts playwright/e2e/helpers/miden-cli-fee.test.ts && git commit -m "test(e2e): stop sending is_private_note and reading tx_id in the public-faucet helper"
```

---

### Task 7: The E2E public-faucet helper asks for the offered amount and retries once at the cap

**Files:**
- Modify: `playwright/e2e/helpers/public-faucet.ts`. Line numbers are after Task 6, which moves nothing above `:172`; anchor on the text.
  - the end of the header comment and the imports (`:21-29`);
  - a new class before `failedResponse`, and `failedResponse` itself (`:161-170`);
  - `advertisedGrantAmount` (`:204-214`);
  - the `mintFromPublicFaucet` docblock (`:216-227`) and its loop (`:235-251`).
- Modify: `scripts/e2e-real.mjs:521` (the preflight's faucet line).
- Test: `playwright/e2e/helpers/public-faucet.test.ts`: a new describe inside `describe('mintFromPublicFaucet', ...)`, before its `names the faucet in every failure` describe (`:292`, the same line before and after Task 6).

**Interfaces:**
- Consumes: `faucetGrantAmount` and `faucetCapFromRefusal` (Task 1). The helper imports them from `../../../src/lib/miden-chain/faucet-protocol`, the way `balance-truth.ts:31` and `claim-drain.ts:14` already import runtime modules from `src`. `faucet-protocol.ts` imports nothing, so no SDK comes with it.
- Produces: `mintFromPublicFaucet(baseUrl, accountId, amount?, retryDelayMs?, sleep?): Promise<{ noteId: string }>`, the same signature.
  - With `amount` omitted it asks for `faucetGrantAmount(metadata)`. On a 400 naming a cap with `0n < cap < asked` it asks once more at that cap.
  - The 5xx attempts and the 429 budget carry on across that ask: it neither resets nor spends them.
  - Every caller omits the amount: `miden-cli.ts:534`, `dapp-live-probe.ts:30` and `fee-faucet-discovery.spec.ts:49`.

Why: the helper's header (`:17-20`) says its protocol mirrors `faucet-api.ts`. After Task 4 the wallet asks for the offered amount and retries at the cap, while the helper still asks for `base_amount`. If the operator cap drops below `base_amount`, every real-network suite that funds itself through `miden-cli.ts:534` fails at funding.

- [ ] **Step 1: Write the failing tests**

`public-faucet.test.ts` runs under `@jest-environment node`. Its `serve` answers each `fetch` with the next queued response, in order, and returns the list of requested URLs; `reply` builds a `Response`. Insert this block immediately before the line `  describe('names the faucet in every failure, so a dApp journey classifies it as infrastructure', () => {` (`:292`). It uses the enclosing describe's `serve`, `reply`, `BASE`, `ACCOUNT` and `EASY_TARGET`, and the file's `NOTE_ID` and `PublicFaucetError`, which `:7` already imports.

```ts
  describe('the amount it asks for, and one more ask at a lower cap the faucet names', () => {
    // Faucet 0.17.1 (testnet) offers token amounts and checks the cap at /pow; 0.17.0 (devnet) does neither.
    const TESTNET_METADATA = { version: '0.17.1', decimals: 6, base_amount: 100_000_000, token_amounts: [1, 10, 100] };
    const DEVNET_METADATA = { version: '0.17.0', decimals: 6, base_amount: 100_000_000 };
    const overCap = (requested: bigint, cap: bigint) =>
      `requested amount ${requested} exceeds the maximum claimable amount of ${cap}`;
    const challenge = (hex: string) => reply(200, { challenge: hex, target: EASY_TARGET });
    const minted = () => reply(200, { note_id: NOTE_ID });
    const asked = (urls: string[], path: '/pow' | '/get_tokens') =>
      urls
        .map(url => new URL(url))
        .filter(url => url.pathname === path)
        .map(url => url.searchParams.get(path === '/pow' ? 'amount' : 'asset_amount'));

    it('asks for the largest token amount the faucet offers, in base units', async () => {
      const urls = serve([reply(200, { ...TESTNET_METADATA, token_amounts: [1, 10] }), challenge('aa'), minted()]);

      await expect(mintFromPublicFaucet(BASE, ACCOUNT)).resolves.toStrictEqual({ noteId: NOTE_ID });

      expect(asked(urls, '/pow')).toEqual(['10000000']);
      expect(asked(urls, '/get_tokens')).toEqual(['10000000']);
    });

    it('asks for an offered token amount when base_amount is malformed', async () => {
      const urls = serve([
        reply(200, { decimals: 6, base_amount: 'x', token_amounts: [5] }),
        challenge('aa'),
        minted()
      ]);

      await mintFromPublicFaucet(BASE, ACCOUNT);

      expect(asked(urls, '/pow')).toEqual(['5000000']);
    });

    it('asks once more at the cap a challenge refusal names, from a fresh challenge (testnet)', async () => {
      const urls = serve([
        reply(200, TESTNET_METADATA),
        reply(400, overCap(100_000_000n, 10_000_000n)),
        challenge('bb'),
        minted()
      ]);

      await expect(mintFromPublicFaucet(BASE, ACCOUNT)).resolves.toStrictEqual({ noteId: NOTE_ID });

      expect(asked(urls, '/pow')).toEqual(['100000000', '10000000']);
      expect(asked(urls, '/get_tokens')).toEqual(['10000000']);
      expect(urls.filter(url => url.endsWith('/get_metadata'))).toHaveLength(1);
    });

    it('asks once more at the cap a mint refusal names, solving a new challenge (devnet)', async () => {
      const urls = serve([
        reply(200, DEVNET_METADATA),
        challenge('aa'),
        reply(400, overCap(100_000_000n, 10_000_000n)),
        challenge('bb'),
        minted()
      ]);

      await expect(mintFromPublicFaucet(BASE, ACCOUNT)).resolves.toStrictEqual({ noteId: NOTE_ID });

      expect(asked(urls, '/pow')).toEqual(['100000000', '10000000']);
      expect(asked(urls, '/get_tokens')).toEqual(['100000000', '10000000']);
      expect(urls[4]).toContain('challenge=bb');
    });

    it('asks at most twice, whatever the second refusal names', async () => {
      const second = overCap(10_000_000n, 1_000_000n);
      const urls = serve([
        reply(200, TESTNET_METADATA),
        reply(400, overCap(100_000_000n, 10_000_000n)),
        reply(400, second)
      ]);

      const error = await mintFromPublicFaucet(BASE, ACCOUNT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PublicFaucetError);
      expect(error).toMatchObject({ message: `Public faucet PoW request failed (400): ${second}` });
      expect(asked(urls, '/pow')).toEqual(['100000000', '10000000']);
    });

    it.each([
      ['the cap equals the request', overCap(100_000_000n, 100_000_000n)],
      ['the cap is above the request', overCap(100_000_000n, 1_000_000_000n)],
      ['the cap is zero', overCap(100_000_000n, 0n)],
      ['the refusal names no cap', 'requested amount 100000000 exceeds the maximum claimable amount'],
      ['the refusal is about something else', 'Please enter a valid recipient address']
    ])('asks only once when %s', async (_case, detail) => {
      const urls = serve([reply(200, TESTNET_METADATA), reply(400, detail)]);

      await expect(mintFromPublicFaucet(BASE, ACCOUNT)).rejects.toThrow(
        `Public faucet PoW request failed (400): ${detail}`
      );

      expect(asked(urls, '/pow')).toEqual(['100000000']);
    });

    it('asks only once for an amount the caller chose', async () => {
      const urls = serve([reply(400, overCap(100_000_000n, 10_000_000n))]);

      await expect(mintFromPublicFaucet(BASE, ACCOUNT, 100_000_000n, 0)).rejects.toThrow(
        `Public faucet PoW request failed (400): ${overCap(100_000_000n, 10_000_000n)}`
      );

      expect(urls).toHaveLength(1);
      expect(asked(urls, '/pow')).toEqual(['100000000']);
    });

    it('keeps counting 5xx attempts across the ask at the cap', async () => {
      const urls = serve([
        reply(200, TESTNET_METADATA),
        challenge('aa'),
        reply(502, 'Bad Gateway'),
        reply(400, overCap(100_000_000n, 10_000_000n)),
        challenge('bb'),
        reply(502, 'Bad Gateway'),
        challenge('cc'),
        reply(502, 'Bad Gateway')
      ]);

      await expect(mintFromPublicFaucet(BASE, ACCOUNT, undefined, 0)).rejects.toThrow(
        'Public faucet mint failed (502): Bad Gateway'
      );

      expect(asked(urls, '/get_tokens')).toEqual(['100000000', '10000000', '10000000']);
    });

    it('keeps one 429 budget across the ask at the cap', async () => {
      const limited = () => reply(429, 'Account is rate limited for 59 more seconds.');
      serve([
        reply(200, TESTNET_METADATA),
        challenge('aa'),
        limited(),
        challenge('bb'),
        limited(),
        reply(400, overCap(100_000_000n, 10_000_000n)),
        challenge('cc'),
        limited(),
        challenge('dd'),
        limited()
      ]);
      const waits: number[] = [];

      await expect(
        mintFromPublicFaucet(BASE, ACCOUNT, undefined, 0, async ms => {
          waits.push(ms);
        })
      ).rejects.toThrow('Public faucet mint failed (429): Account is rate limited for 59 more seconds.');

      expect(waits).toEqual([60_000, 60_000, 60_000]);
    });
  });

```

Mutation notes (each against the Step 3 code):
- **Largest amount:** read `base_amount` in `advertisedGrantAmount` again, and the `/pow` amounts read `["100000000"]`.
- **Malformed base:** the same change rejects with the `base_amount` message.
- **Testnet:** drop the cap branch in `mintFromPublicFaucet`, and the call rejects with the `/pow` 400.
- **Devnet:** type the over-cap refusal only for the `/pow` label, and the call rejects with `Public faucet mint failed (400)`.
- **At most twice:** drop `mayAskAtCap = false`, and a third `/pow` finds the queue empty, so the rejection names `unexpected request`.
- **`it.each`:**
  - drop `error.cap > 0n`, and the zero case asks at 0;
  - write `error.cap <= resolvedAmount`, and the equal case asks twice;
  - drop `error.cap < resolvedAmount`, and the equal and above cases ask twice.
- **Caller's amount:** start `mayAskAtCap` at `true`, and a second `/pow` goes out.
- **5xx attempts:** reset `serverFailures` in the cap branch, and a fourth attempt finds the queue empty; count the ask as a 5xx attempt instead, and only two `/get_tokens` go out.
- **429 budget:** reset `rateLimitedMs` in the cap branch, or ask at the cap by calling `mintFromPublicFaucet` again, and a fourth wait goes out before the queue runs dry. The recursive call also fails the 5xx test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest playwright/e2e/helpers/public-faucet.test.ts --maxWorkers=2`

Expected: FAIL, `Tests: 7 failed, 40 passed, 47 total`:
- "asks for the largest token amount the faucet offers": the array diff shows `- "10000000"` / `+ "100000000"`;
- "asks for an offered token amount when base_amount is malformed": `PublicFaucetError: Public faucet grant failed: Error: Faucet metadata base_amount must be a positive safe integer`;
- the testnet case: `Received promise rejected instead of resolved`, with `Public faucet PoW request failed (400): requested amount 100000000 exceeds the maximum claimable amount of 10000000`;
- the devnet case: the same, with `Public faucet mint failed (400): requested amount 100000000 exceeds the maximum claimable amount of 10000000`;
- "asks at most twice": the `toMatchObject` diff receives the first refusal, `requested amount 100000000 exceeds the maximum claimable amount of 10000000`;
- the 5xx and 429 cases: `Received message: "Public faucet PoW request failed (400): requested amount 100000000 exceeds the maximum claimable amount of 10000000"`.

The five "asks only once when" cases and "asks only once for an amount the caller chose" pass before the change: they pin the boundary. The 34 tests the file holds after Task 6 pass.

- [ ] **Step 3: Write the implementation**

In `playwright/e2e/helpers/public-faucet.ts`, make eight replacements.

The end of the header comment (`:21-23`). The header's "mirrored" paragraph stays as it is.

Before:
```ts
 */

import type { Page } from '@playwright/test';
```
After:
```ts
 * What to ask for is not mirrored: the amount and the cap a refusal names are read by
 * `faucet-protocol.ts`, which imports nothing, so the helper asks for what the wallet does.
 */

import type { Page } from '@playwright/test';
```

The src import (`:29`).

Before:
```ts
import type { SerializedInputNoteDetail } from '../../../src/lib/shared/types';
```
After:
```ts
import { faucetCapFromRefusal, faucetGrantAmount } from '../../../src/lib/miden-chain/faucet-protocol';
import type { SerializedInputNoteDetail } from '../../../src/lib/shared/types';
```

`failedResponse` (`:161-170`), with the new class above it. The 429 branch is unchanged.

Before:
```ts
async function failedResponse(label: string, response: Response): Promise<Error> {
  // The status decides whether a retry can help; a body that fails or stalls only loses the explanation.
  const message = `${label} (${response.status}): ${await response.text().catch(() => '')}`;
  if (response.status === 429) {
    // "Account is rate limited for 25 more seconds." A second over, so the retry lands after it.
    const seconds = message.match(/(\d+)\s+more\s+seconds?/i)?.[1];
    return new FaucetRateLimitedError(message, seconds ? (Number(seconds) + 1) * 1000 : RATE_LIMIT_FALLBACK_MS);
  }
  return response.status >= 500 ? new FaucetServerError(message) : new Error(message);
}
```
After:
```ts
/** The faucet refused an amount over its cap before minting anything, and named the cap in base units. */
class FaucetAmountOverCapError extends Error {
  constructor(
    message: string,
    readonly cap: bigint
  ) {
    super(message);
  }
}

async function failedResponse(label: string, response: Response): Promise<Error> {
  // The status decides whether a retry can help; a body that fails or stalls only loses the explanation.
  const detail = await response.text().catch(() => '');
  const message = `${label} (${response.status}): ${detail}`;
  if (response.status === 429) {
    // "Account is rate limited for 25 more seconds." A second over, so the retry lands after it.
    const seconds = message.match(/(\d+)\s+more\s+seconds?/i)?.[1];
    return new FaucetRateLimitedError(message, seconds ? (Number(seconds) + 1) * 1000 : RATE_LIMIT_FALLBACK_MS);
  }
  const cap = response.status === 400 ? faucetCapFromRefusal(detail) : null;
  if (cap !== null) return new FaucetAmountOverCapError(message, cap);
  return response.status >= 500 ? new FaucetServerError(message) : new Error(message);
}
```

`advertisedGrantAmount` (`:207-212`). `faucetGrantAmount` throws the same `Faucet metadata base_amount must be a positive safe integer` the helper threw, so the malformed-metadata tests keep their message.

Before:
```ts
    const metadata: unknown = await response.json();
    const baseAmount = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'base_amount') : undefined;
    if (typeof baseAmount !== 'number' || !Number.isSafeInteger(baseAmount) || baseAmount <= 0) {
      throw new Error('Faucet metadata base_amount must be a positive safe integer');
    }
    return BigInt(baseAmount);
```
After:
```ts
    const metadata: unknown = await response.json();
    return faucetGrantAmount(metadata);
```

The `mintFromPublicFaucet` docblock, first at `:218`.

Before:
```ts
 * When omitted, resolves the faucet's advertised base grant once and retains it across retries.
```
After:
```ts
 * When omitted, asks for what the wallet's Fund button asks for (`faucetGrantAmount`), resolved
 * once and retained across retries.
```

Then at `:225-226`.

Before:
```ts
 * `RATE_LIMIT_BUDGET_MS`, and does not count against the 5xx attempts. Any other 4xx answers this
 * request and fails at once. Every rejection is a `PublicFaucetError`.
```
After:
```ts
 * `RATE_LIMIT_BUDGET_MS`, and does not count against the 5xx attempts. A 400 naming a cap below an
 * amount the helper chose is asked once more at that cap, as the wallet does; it was refused before
 * anything was minted, so the ask spends neither the 5xx attempts nor the 429 budget. Any other 4xx
 * answers this request and fails at once. Every rejection is a `PublicFaucetError`.
```

The loop (`:237-248`), in two replacements.

Before:
```ts
  let rateLimitedMs = 0;
  for (;;) {
```
After:
```ts
  let rateLimitedMs = 0;
  let mayAskAtCap = amount === undefined;
  for (;;) {
```

Before:
```ts
        await sleep(error.retryAfterMs);
        continue;
      }
      if (!(error instanceof FaucetServerError) || ++serverFailures >= GRANT_ATTEMPTS) {
```
After:
```ts
        await sleep(error.retryAfterMs);
        continue;
      }
      if (
        mayAskAtCap &&
        error instanceof FaucetAmountOverCapError &&
        resolvedAmount !== undefined &&
        error.cap > 0n &&
        error.cap < resolvedAmount
      ) {
        mayAskAtCap = false;
        resolvedAmount = error.cap;
        continue;
      }
      if (!(error instanceof FaucetServerError) || ++serverFailures >= GRANT_ATTEMPTS) {
```

The ask at the cap is a `continue` in the same loop, so `serverFailures` and `rateLimitedMs` carry over untouched. A second call to `mintFromPublicFaucet` would start both at 0. `resolvedAmount !== undefined` is there for the type only: an over-cap refusal comes from `requestGrant`, after the amount is set. A 400 with a cap is no longer a plain `Error`, but it still reaches `publicFaucetFailure` with its `Public faucet` message when it is not retried, so it stays a `PublicFaucetError`.

In `scripts/e2e-real.mjs`, replace `:521`. The probe reads `/get_metadata` only to show the faucet is up, and `base_amount` is no longer the amount anyone asks for. This is a one-line text change with no test of its own: `scripts/e2e-real.test.ts` runs the preflight against `e2e-real.fetch-stub.mjs` but asserts on requests and other lines, never on this one.

Before:
```js
    return record(true, 'Miden faucet API', `node ${body.version}, grants ${body.base_amount} base units`);
```
After:
```js
    return record(true, 'Miden faucet API', `node ${body.version}, base_amount ${body.base_amount}`);
```

- [ ] **Step 4: Run the tests to verify they pass, then lint**

Run: `cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && { find playwright/e2e/helpers -maxdepth 1 -name '*.test.ts'; printf '%s\n' scripts/e2e-real.test.ts; } | xargs yarn jest --maxWorkers=2 && npx prettier --write playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-faucet.test.ts && npx eslint --max-warnings 0 playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-faucet.test.ts && npx prettier --check scripts/e2e-real.mjs && yarn lint:e2e`

Expected:
- every helper suite passes, `public-faucet.test.ts` with 47 tests;
- `scripts/e2e-real.test.ts` passes;
- no eslint output, and prettier reports `All matched files use Prettier code style!` for `scripts/e2e-real.mjs`;
- `lint:e2e` reports no new violations.

ESLint is not run on `scripts/e2e-real.mjs`: it already carries an `import/order` warning at `:23`, which `--max-warnings 0` fails on. The D1 comment band for `public-faucet.ts` (18-23%) holds; a scratch copy of the file after Tasks 6 and 7 measures 20% (76/370).

- [ ] **Step 5: Commit**

```bash
cd ~/miden/wt-fund-faucet && git add playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-faucet.test.ts scripts/e2e-real.mjs && git commit -m "test(e2e): public faucet helper asks for the offered amount and retries at the cap"
```

---

## Delivery

- [ ] **D1: Local gates**

**Changed suites, every test file in their directories, the one test outside them that loads the touched modules, and the source-scanning guards.** `ActivityPendingHistory.test.tsx` loads the real `wallet-prompts`, and so `faucet-api`. `scripts` is in the list for Task 7's change to `scripts/e2e-real.mjs`. Use `find` and `xargs`, not unquoted variables or globs: zsh keeps a variable as one argument and aborts a whole command on a failed glob.

```bash
cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && { for d in src/lib src/lib/miden-chain src/lib/i18n src/app/templates playwright/e2e/helpers scripts; do find "$d" -maxdepth 1 \( -name '*.test.ts' -o -name '*.test.tsx' \); done; printf '%s\n' src/app/templates/history/ActivityPendingHistory.test.tsx; /usr/bin/grep -rl -e 'readdirSync' -e 'readFileSync(file' src --include='*.test.ts' --include='*.test.tsx'; } | sort -u | xargs yarn jest --maxWorkers=2
```
Expected: everything passes except the 13 `locale-bundle-parity.test.ts` cases listed in Task 5 Step 4. CI's `translations` job commits the other locales, and the `unit` job (`needs: translations`) runs on that commit. Never hand-edit another locale to clear them.

**Lint and format of the branch's changed source and test files**, including the i18n config on `src`. Locale JSON is excluded; see Global Constraints.
```bash
cd ~/miden/wt-fund-faucet && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx' | xargs npx eslint --max-warnings 0 && git diff --name-only origin/main...HEAD -- '*.ts' '*.tsx' | xargs npx prettier --check && git diff --name-only origin/main...HEAD -- 'src/*.ts' 'src/*.tsx' | xargs npx eslint --no-eslintrc --config .eslintrc.i18n.json --max-warnings 0 && yarn lint:e2e
```
Expected: no eslint output, and `All matched files use Prettier code style!`.

**Comment density** (the awk recipe; lines starting `//`, `/*` or `*`):
```bash
cd ~/miden/wt-fund-faucet && for f in src/lib/miden-chain/faucet-protocol.ts src/lib/miden-chain/faucet-api.ts src/app/templates/HomePrompts.tsx playwright/e2e/helpers/public-faucet.ts; do awk 'BEGIN{c=0;t=0} /^[[:space:]]*(\/\/|\/\*|\*|#!)/{c++} {t++} END{printf "%s %d%% (%d/%d)\n",FILENAME,100*c/t,c,t}' "$f"; done
```
Expected bands:
- `faucet-protocol.ts`: 17-33%;
- `faucet-api.ts`: 15-22%;
- `HomePrompts.tsx`: 21-25%;
- `public-faucet.ts`: 18-23%.

Above a band, delete narration first, never a "why" or a trap.

**Dash check, with a positive control first:**
```bash
cd ~/miden/wt-fund-faucet && printf '+a \342\200\224 b\n+a \342\200\223 b\n' | LC_ALL=C /usr/bin/grep -cE $'^\\+.*(\xe2\x80\x94|\xe2\x80\x93)'
```
Expected: `2`. If it prints `0`, the pattern is broken: stop and fix the command before trusting the next one.

```bash
cd ~/miden/wt-fund-faucet && git diff origin/main...HEAD | LC_ALL=C /usr/bin/grep -nE $'^\\+.*(\xe2\x80\x94|\xe2\x80\x93)'; echo "added-lines exit=$?"; git log --format=%B origin/main..HEAD | LC_ALL=C /usr/bin/grep -nE $'(\xe2\x80\x94|\xe2\x80\x93)'; echo "messages exit=$?"
```
Expected: no matching lines, then `added-lines exit=1` and `messages exit=1`.

**Type-level leftovers.** `yarn ts` runs in CI. Before pushing, confirm the `txId` removal left no typed straggler. `public-faucet.test.ts` is not scanned: its `tx_id` replies are deliberate.
```bash
cd ~/miden/wt-fund-faucet && git grep -n -e is_private_note -e tx_id -e txId -- src/lib/miden-chain/faucet-api.ts playwright/e2e/helpers/public-faucet.ts; git grep -n "txId: '0xtx'" -- src/lib/wallet-prompts.test.ts src/lib/miden-chain/faucet-api.test.ts; git grep -n "txId:" -- playwright/e2e/helpers/miden-cli-fee.test.ts; echo "scan done"
```
Expected: only `scan done`.

- [ ] **D2: CHANGELOG entry**

This step runs before the review so the panel reads the entry too. `scripts/check-changelog.sh` requires an entry for this PR, because it carries no "no changelog" label. Confirm the target heading:
```bash
cd ~/miden/wt-fund-faucet && git fetch --tags origin && git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 && grep -n '^## ' CHANGELOG.md | head -n 2
```
Expected: `v1.17.1`, and the first heading `## 1.17.2 (TBD)` (unreleased, the highest). If either differs, stop and ask.

In `CHANGELOG.md`, under `## 1.17.2 (TBD)` -> `### Fixes`, insert as the first bullet. That is directly before the line starting `- [FIX][ci] A wallet PR's linked Guardian PR provides`:
```markdown
- [FIX][all] Fund your wallet asks the faucet for the largest amount it offers and, when the faucet names a lower cap, asks once more for exactly that instead of failing; a rate limit or a refused amount reads in plain words on the card (with the wait, when the faucet gives one).
```
```bash
cd ~/miden/wt-fund-faucet && git add CHANGELOG.md && git commit -m "docs(changelog): note the Fund your wallet cap retry and plain-language refusals"
```
Re-run the dash check above. It covers the entry.

- [ ] **D3: Review loop**

Run `/review-council:rev` on the branch against `origin/main`, as the full loop: panel, triage, fixes, verification panel. Repeat rounds until they stop producing material findings.
- Each fix round commits on its own, as the loop does.
- Do not squash, amend or merge main during the loop.
- After each committed fix round, re-run the D1 gates for the files it touched.

- [ ] **D4: Push**

```bash
cd ~/miden/wt-fund-faucet && git push -u origin wiktor/fund-faucet-cap
```

- [ ] **D5: Open the PR**

Write the body with a quoted heredoc, so backticks survive. Run the dash check on it, then open the PR.

```bash
cd ~/miden/wt-fund-faucet && BODY=$(mktemp) && cat > "$BODY" <<'EOF'
Fund your wallet now asks the faucet for an amount within its cap and retries once at a lower cap the faucet names, and says a rate limit or a cap refusal in plain words.

- Asks for `max(token_amounts) * 10^decimals`, else `base_amount`; a 400 naming a lower cap is asked once more at that cap, from a fresh challenge.
- On the Home card a 429 reads "Try again in N seconds" and an over-cap 400 "The faucet can't send funds right now"; every other failure keeps the faucet's own text (#425).
- Stops sending `is_private_note` and reading `tx_id`, both removed in faucet 0.17.0, in the wallet and the E2E faucet helper.
- The E2E faucet helper asks for the same amount through the same reader and retries at the cap the same way, so the real-network suites that fund themselves keep working when the cap drops.

<details><summary>Why, and what changed underneath</summary>

- The operator cap moved 100 -> 10 -> 0.01 -> 1 -> 100 USDCx in three days. `base_amount` is the proof-of-work pivot (`complexity = amount / base_amount + 1`), not the cap, so asking for it fails outright whenever the cap drops below it. `token_amounts` is checked against the cap at faucet startup.
- Testnet (0.17.1) refuses an over-cap amount at `/pow`, before any proof of work. Devnet (0.17.0) refuses it only at `/get_tokens`, after the marker is flagged submitted; the refusal reports that nothing is minting, and the retry re-flags the marker under the same pre-send check.
- A second refusal, over the cap or rate-limited, stands: there is never a third request.
- `faucetFetch` retrying a 429 when `Retry-After` is readable (extension only) can replay an expired challenge; that raw text stays out of scope here.
- Labelling grants from the faucet's funding account as Faucet Requests in Activity is a separate PR.
- Other locales arrive from the translations job.

</details>

**Reviewers:** the single cap retry in `mintFromMidenFaucet` and its devnet path through the funding marker (`wallet-prompts.test.ts`, "lets a request refused over the cap go out again at the cap") are the part worth your time.
EOF
printf '+a \342\200\224 b\n' | LC_ALL=C /usr/bin/grep -cE $'^\\+.*(\xe2\x80\x94|\xe2\x80\x93)'; LC_ALL=C /usr/bin/grep -nE $'(\xe2\x80\x94|\xe2\x80\x93)' "$BODY"; echo "body exit=$?"; gh pr create --repo 0xMiden/wallet --base main --head wiktor/fund-faucet-cap --title "Fund your wallet fails when the faucet cap drops below its base amount" --body-file "$BODY"
```
Expected: the control prints `1`; the body check prints no line and `body exit=1`; `gh` prints the PR URL. The body names no tool, agent or review process.

- [ ] **D6: CI, checked by head SHA**

```bash
cd ~/miden/wt-fund-faucet && SHA=$(git rev-parse HEAD) && gh run list --repo 0xMiden/wallet --branch wiktor/fund-faucet-cap --limit 50 --json databaseId,headSha,name,status,conclusion --jq ".[] | select(.headSha==\"$SHA\") | [.databaseId, .name, .status, .conclusion] | @tsv"
```
1. **Translations commit.** The `translations` job pushes `chore: update translation files`. When it lands, run `git fetch origin && git merge --ff-only origin/wiktor/fund-faucet-cap`, then re-run the command above for the new head SHA. The `unit` job on that SHA must be green, including `locale-bundle-parity` and `yarn ts`.
2. **Failures.** Report each failure as soon as it appears. Check that workflow's history on main before blaming this branch. Set `WORKFLOW` to the failing run's workflow file name, for example `pr.yml`:
   ```bash
   WORKFLOW=pr.yml && gh api "repos/0xMiden/wallet/actions/workflows/$WORKFLOW/runs?branch=main&per_page=20" --jq '.workflow_runs[] | "\(.created_at[:10]) | \(.conclusion) | \(.head_sha[:8])"'
   ```
3. **Live testnet run: ask the user first, do not dispatch by default.** `gh workflow run e2e-blockchain.yml --ref wiktor/fund-faucet-cap -f network=testnet` starts every testnet job, not one:

   | Job | Runner | Limit on dispatch |
   |---|---|---|
   | `chrome-testnet` | warp 8x | 90 min |
   | `chrome-guardian-testnet` | warp 8x | 120 min |
   | `mobile-testnet` | macos-26-xlarge (iOS) | 215 min |
   | `mobile-guardian-testnet` | macos-26-xlarge (iOS) | 215 min |

   Plus the three gate jobs. Only `chrome-guardian-testnet`'s "Verify fresh Guardian onboarding and public funding (testnet)" step taps the real Fund button. The same step runs on the push to main after merge.

   Recommended: skip the dispatch and watch that post-merge step. Dispatch only if the user approves the cost.
