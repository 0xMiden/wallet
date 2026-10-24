<!-- Tasks: 20 (Tasks 1-18 of the 32-task PR 1 plan 2026-10-10-usdcx-live-e2e-pr1.md, numbers unchanged, then Tasks 33-34 for spec 10(g)). PR 1a of 2: product fixes. -->

# USDCx Fixes (PR 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the USDCx defects on main that a live round trip depends on: an attestation is trusted only when it matches what the wallet signed, every consume landing path adopts its delivered deposit, an unknown-outcome burn awaits the node's verdict, a stale `ready` deposit times out while a late mint still lands it, the fee labels name the fee asset, the arrival estimate follows the source chain, a stranded executor leg stays executable, Sepolia becomes an executor bridge-in source, the burn's destination balance snapshot read retries, and a USDCx burn shows Circle's payout fee, must exceed it, and confirms against the amount minus it.

**Architecture:** 20 TDD tasks: 18 committed as spec section 14's PR 1 commits 1-8 (Tasks 7, 8, 9, 12, 13, 14, 15, 16, 17 and 18 each make one; the earlier tasks of a commit end at their green run), then Tasks 33 and 34 (spec 10(g)), one commit each. Everything changes `src/` (plus `.prettierignore`, `public/_locales/en`, `CLAUDE.md` (Task 33), and `playwright/e2e/ios/helpers/xreserve-fork.ts`, which Task 16 keeps loading), each fix with failing-first jest tests that run the real attestation decoder, Dexie store, phase writers and matchers. Nothing here depends on the live E2E harness or the `yarn e2e:real` suites; those are PR 1b (`2026-10-11-usdcx-live-e2e-harness.md`, stacked on this PR). No live run happens in PR 1a.

**Tech Stack:** TypeScript (no `any`, no `as` in src), React 18, Zustand, Dexie with fake-indexeddb under Jest 30 (swc, jsdom by default), viem (ABI decoding of Circle's DepositIntent), `@miden-sdk/miden-sdk` 0.17.3, Node 22.

**Spec:** docs/superpowers/specs/2026-10-09-usdcx-live-e2e-design.md section 10 (product fixes, 10(g) for Tasks 33-34) and section 14 PR 1 (commits 1-8)

Reading this plan:
- Tasks are numbered 1-18 and keep the numbers they have in the 32-task PR 1 plan, because later tasks cite earlier ones by number; Tasks 33 and 34 (spec 10(g), added 2026-10-11) continue after that plan's 32 and run after Task 18; each heading ends with its partition key, and a reference such as "Task 7 (p1-reconciler-match)" points at it. "Appendix A" (end of file) is the cross-task interface contract, kept whole; the tasks cite it as "contract N.M" or "interfaces section N", and its sections 3-7 describe PR 1b.
- Edits are exact text replacements anchored on quoted current text, applied top to bottom. A `path:N-M` cite inside a task names the file as it stands at the start of that task; a cite marked origin/main, @main or "on main" names origin/main 6856c9f6a, identical to the drafting base 791adbd3f for every file this PR touches except `CHANGELOG.md` (#1402 added one line at :15, so #1401's line is now :17). When a line number and the quoted text disagree, the text wins.
- A fenced block whose last line is empty ends in a newline; the empty line is not an extra blank line in the file.

## Global Constraints

- Base: branch `wiktor/usdcx-fixes` in `/Users/celrisen/miden/wt-usdcx-e2e`, origin/main 6856c9f6a (it holds #1100 cfb228a48, #1401 6fdc2c127, #1400 791adbd3f and #1402) with the four spec commits on top (Setup, before Task 1).
- Toolchain: `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`; jest runs as `yarn jest <paths> --maxWorkers=2`; node_modules must hold `@miden-sdk/miden-sdk` 0.17.3 (package.json:161).
- Commits: one per spec commit, the single-line message of spec 14 step 2 verbatim (Tasks 33 and 34, spec 10(g), use the messages in their Step 6), no trailers of any kind, `git add` by explicit path, never `git add -A`, never amend.
- No em dash (U+2014) or en dash (U+2013) anywhere: code, comments, copy, test titles, commit messages, PR text.
- Comments match each file's density and say why, never what.
- English copy only in `public/_locales/en/en.json` and `public/_locales/en/messages.json` (placeholders `$name$`); never run prettier on `public/_locales`; CI's DeepL pass translates the rest, so `locale-bundle-parity.test.ts` fails 26 cases after commit 5 and 27 after commit 6 until it does (Tasks 33 and 34 add keys but no new case).
- CHANGELOG: new lines under `## 1.17.2 (TBD)` (latest tag v1.17.1); #1100's line (:7) edited per 10(d); #1401's line unchanged (Q1). The fix lines are written in Delivery, not in a task.
- Decisions: executor mismatch writes nothing and warns once per row (Q10); executor stall window `USDCX_EXECUTE_STALL_SEC` 1800 (Q11); arrival `~1 min` from Arc Testnet, `~20 min` from every other source (Q12); Sepolia is an executor source except in E2E builds with `MIDEN_E2E_TEST=true` and `MIDEN_E2E_USDCX_CHAIN=sepolia` (Q13); the burn snapshot read tries 3 times, 1 s then 2 s apart, inside its 15 s budget (Q14); a late mint adopts a `ready` row that timed out, ranked after every live row (Q9); Ethereum stays a burn destination, the expected payout is exactly the amount minus the destination's fee allowance, a burn must exceed that allowance, and Route and Review show the fee and the least payout (Q15).
- Review is a standard review only, no review-council (D12).
- The worktree may host another session's build or spike: never run `yarn install`, a build, an E2E run or `git checkout` while one is running there.

## Review Focus

The four input classes or failure modes in the product fixes most likely to slip past the drafted tests. Each has a pinning test in its owning task, mutation-checked on the final tree.

1. **An executor deposit whose saved Arc execute mined, but whose deposit Circle attests to something else** (Task 15, p1-executor-stall). The drafted exemption from the 7-day failure covered every executor row holding a message, including one with a saved hash: the receipt reads `success`, so the stall branch never reopens it; the attestation mismatch only warns (Q10), so it never fails. The row stayed `delivering`, and was polled every 8 s, forever. The exemption now needs an unexecuted message, and a row with a saved hash counts its week from `cctp.executeSavedAt`. Pinned by `times out an executor row a week after its execute hash was saved` and `keeps an old executor deposit whose execute hash was saved this week` (bridge-receive.test.ts).
2. **A claimed note with no readable amount or fungible asset, landed without a transaction result** (Task 11, p1-adopter). The drafted adopter dropped such a note before the intent registry pass, which pairs by note id alone, so an Epoch or Smart Withdraw delivery queued with amount `''` lost its tag on all five result-less landing paths, and the result path stopped offering asset-less notes to the registry that main offered. `AdoptableNote.amount` is now optional; only the sender-and-amount pairing skips such a note. Pinned by `lands a registry delivery whose note carried no amount` and `reads the per-note facts a consume kept, a note with no amount included` (bridge-in.adopt.test.ts), and `offers a note with no fungible asset to the registry pass alone` (complete.bridge-in.test.ts).
3. **A persisted signed recipient that is not hex** (Task 7, p1-reconciler-match). A corrupt or hand-edited `usdcxRemoteRecipient` must fall back to the recipient the row's account derives, never be sent to the matcher as is (which would fail a genuine deposit as attested to "a different Miden account"). Pinned by `derives the recipient when the one the row persisted is not hex` (bridge-receive.test.ts).
4. **The captured attestation reformatted by a formatter** (Task 3, p1-intent-decoder). `yarn format` is `prettier --write src` and would rewrite the compact capture, so "verbatim" would silently stop being true while every parse-based test still passed. `.prettierignore` now lists the file, and the bytes are pinned by `stays byte for byte the body Circle served for 0x370bf19a` (attestation.test.ts).

## Task Index

Execution order. Commits are made by the task named in the Spec commit column.

| Task | Key | Title | Spec commit |
|---|---|---|---|
| 1 | `p1-recipient-field` | Persist the signed USDCx recipient on bridged-receive rows | 1, deferred to Task 7 |
| 2 | `p1-deposit-target` | Derive the xReserve recipient and expected token from wallet ids | 1, deferred to Task 7 |
| 3 | `p1-intent-decoder` | Decode Circle's xReserve DepositIntent | 1, deferred to Task 7 |
| 4 | `p1-attestation-matcher` | Match an attestation against what the wallet signed | 1, deferred to Task 7 |
| 5 | `p2-recipient-writers` | Deposit writers persist the signed recipient (spec commit 1, deferred) | 1, deferred to Task 7 |
| 6 | `p2-screen-recipient` | Deposit screen derives the recipient through usdcxRemoteRecipientFor (spec commit 1, deferred) | 1, deferred to Task 7 |
| 7 | `p1-reconciler-match` | Match Circle's attestation in both reconcilers | 1, made here |
| 8 | `p1-ready-timeout-late-mint` | Time out stale ready deposits and let a late mint still land them | 2, made here |
| 9 | `p1-burn-verdict` | Let an unknown-outcome burn await the node's verdict | 3, made here |
| 10 | `p1-consumed-notes` | Keep each claimed note's facts on a consume row | 4, deferred to Task 12 |
| 11 | `p1-adopter` | One shared adopter for bridge deliveries | 4, deferred to Task 12 |
| 12 | `p1-landing-paths` | Adopt on every result-less consume landing path | 4, made here |
| 13 | `p2-fee-labels` | Name the fee asset in USDCx fee labels (spec commit 5) | 5, made here |
| 14 | `p2-arrival` | Show each USDCx deposit source's own arrival time (spec commit 6) | 6, made here |
| 15 | `p1-executor-stall` | Keep a stranded executor leg executable | 7a, made here |
| 16 | `p2-sepolia-executor` | Make Sepolia an executor bridge-in source (spec commit 7b) | 7b, made here |
| 17 | `p2-snapshot-retry` | Retry the destination balance snapshot before a burn (spec commit 7c) | 7c, made here |
| 18 | `p2-testids-hooks` | Burn notice test id and test-hook source chain and row fields (spec commit 8) | 8, made here |
| 33 | `p2-payout-floor` | Expect a payout of the amount minus the fee, and refuse a burn the fee takes whole (spec 10(g)) | 10(g), made here |
| 34 | `p2-payout-display` | Show Circle's fee and the least payout on the USDCx route and review (spec 10(g)) | 10(g), made here |

## Setup (once, before Task 1)

Run only when no other session is using this worktree: another session's build or spike may be running there.

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
git status --short                          # must print nothing tracked
git fetch origin
git branch --show-current              # wiktor/usdcx-fixes
git log --oneline origin/main..HEAD         # exactly the four spec commits, oldest last
yarn install --frozen-lockfile
grep '"version"' node_modules/@miden-sdk/miden-sdk/package.json
```

Expected: clean tree on `wiktor/usdcx-fixes`, four spec commits on origin/main 6856c9f6a, and the SDK version `"version": "0.17.3",`. This plan file stays untracked unless the controller commits it.

---

### Task 1: Persist the signed USDCx recipient on bridged-receive rows (p1-recipient-field)

Spec 10(a) writers: the reconciler needs what the deposit signed, so the row gains `usdcxRemoteRecipient` and the phase writer accepts it. p2's `runUsdcxDeposit`/`runUsdcxExecutorDeposit` pass it in their first `updatePhase` (p2-recipient-writers).

Edits: apply each task's edits top to bottom, as exact text replacements (the Edit tool); every quoted current text is unique in its file at that point, and replaying them in order was checked to reproduce the verified file byte for byte. The pinning tests and fixes the assembler added to Tasks 3, 4, 7, 8, 11 and 15 were replayed on the final p1 tree the same way: every changed suite green, prettier, eslint and `tsc` clean on the touched files, and every new mutation note observed. `path:N-M` is the file as it stands at the start of the task (after the earlier p1 tasks, none of which another partition touches). Line numbers in Files and Interfaces lines are origin/main's (791adbd3f, identical to cfb228a48 for every p1 file). Every listed red and green result was reproduced by replaying these exact edits in order on a copy of `src/` at cfb228a48 with this worktree's node_modules.

**Files:**
- Modify: `src/lib/miden/db/types.ts` (IBridgedReceiveExtraInputs, :165-187)
- Modify: `src/lib/miden/transaction/complete.ts` (`updateBridgedReceivePhase` extra Pick, :1556-1561)
- Test: `src/lib/miden/transaction/bridged-receive-phase.test.ts`

**Interfaces:**
- Consumes: `updateBridgedReceivePhase` (complete.ts:1553), `BridgedReceiveTransaction` (types.ts:1459), `Repo.transactions` (lib/miden/repo).
- Produces:
  - `IBridgedReceiveExtraInputs.usdcxRemoteRecipient?: string` (0x + 64 lowercase hex, the signed xReserve `remoteRecipient`).
  - `updateBridgedReceivePhase(id: string, phase: IBridgedReceivePhase, extra?: Partial<Pick<IBridgedReceiveExtraInputs, 'evmTxHash' | 'intentNonce' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'cctp' | 'error' | 'usdcxRemoteRecipient'>>, received?: { amount: bigint; faucetId: string; transactionId?: string }, options?: { onlyIfNoExecuteHash?: boolean }): Promise<void>` (only the Pick widens).

- [ ] **Step 1: Record the type-check baseline**

This task's red signal is a type error (Step 3), so first confirm that the three files it touches type-check cleanly today:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'bridged-receive-phase.test.ts\|db/types.ts\|transaction/complete.ts'
```

Expected: `0` (the whole-project check takes about 30 s). A non-zero count means this tree does not type-check here, for example a node_modules out of step with the 0.17.3 pin: run `yarn install --frozen-lockfile` and repeat, so that the TS2353 of Step 3 is this task's own.

- [ ] **Step 2: Write the failing test**

`src/lib/miden/transaction/bridged-receive-phase.test.ts:62-67`, current text (unique in the file):

```ts
    await updateBridgedReceivePhase(id, 'submitting', { evmTxHash: '0xhash' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'submitting', evmTxHash: '0xhash' });
  });
});

```

becomes:

```ts
    await updateBridgedReceivePhase(id, 'submitting', { evmTxHash: '0xhash' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'submitting', evmTxHash: '0xhash' });
  });

  // The reconciler matches Circle's attestation to the recipient the deposit signed, written at its first phase write.
  it('keeps the signed USDCx recipient through every later phase write', async () => {
    const recipient = `0x${'0'.repeat(32)}8da911727d5b53916f2c221c00c09100`;
    const id = await seed('submitting');

    await updateBridgedReceivePhase(id, 'submitting', { usdcxRemoteRecipient: recipient });
    await updateBridgedReceivePhase(id, 'delivering', { evmTxHash: '0xhash' });
    await updateBridgedReceivePhase(id, 'ready');

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({
      phase: 'ready',
      evmTxHash: '0xhash',
      usdcxRemoteRecipient: recipient
    });
  });
});

```

Mutation note: drop `| 'usdcxRemoteRecipient'` from the Pick in complete.ts (Step 4) and `npx tsc --noEmit -p tsconfig.json` reports TS2353 on this test's first write; jest alone stays green because the writer spreads `extra` (complete.ts:1590).

- [ ] **Step 3: Run it and watch it fail**

The writer already spreads any `extra` key, so the red signal is the type check, not jest (swc does not type-check):

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep 'bridged-receive-phase.test.ts'
```

Expected: one line, `src/lib/miden/transaction/bridged-receive-phase.test.ts(72,57): error TS2353: Object literal may only specify known properties, and 'usdcxRemoteRecipient' does not exist in type 'Partial<Pick<IBridgedReceiveExtraInputs, "error" | "evmTxHash" | "intentNonce" | "outputAmount" | "outputSymbol" | "midenNoteId" | "cctp">>'.`. The jest run of the file passes (Test Suites: 1 passed, 1 total / Tests:       14 passed, 14 total).

- [ ] **Step 4: Implement**

`src/lib/miden/db/types.ts:184-189`, current text (unique in the file):

```ts
  /** usdcx: the CCTP leg of an executor-route deposit; absent on a direct xReserve deposit. */
  cctp?: IUsdcxCctpLeg;
  error?: string;
}

/** Audit metadata for a Guardian operator switch. `previousGuardianEndpoint`
```

becomes:

```ts
  /** usdcx: the CCTP leg of an executor-route deposit; absent on a direct xReserve deposit. */
  cctp?: IUsdcxCctpLeg;
  error?: string;
  /**
   * usdcx: the xReserve `remoteRecipient` bytes32 the wallet signed (0x + 64 lowercase hex), written at the deposit's
   * first phase write. Absent on rows written before this field and on E2E hook rows.
   */
  usdcxRemoteRecipient?: string;
}

/** Audit metadata for a Guardian operator switch. `previousGuardianEndpoint`
```

`src/lib/miden/transaction/complete.ts:1556-1562`, current text (unique in the file):

```ts
  extra?: Partial<
    Pick<
      IBridgedReceiveExtraInputs,
      'evmTxHash' | 'intentNonce' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'cctp' | 'error'
    >
  >,
  received?: { amount: bigint; faucetId: string; transactionId?: string },
```

becomes:

```ts
  extra?: Partial<
    Pick<
      IBridgedReceiveExtraInputs,
      | 'evmTxHash'
      | 'intentNonce'
      | 'midenNoteId'
      | 'outputAmount'
      | 'outputSymbol'
      | 'cctp'
      | 'error'
      | 'usdcxRemoteRecipient'
    >
  >,
  received?: { amount: bigint; faucetId: string; transactionId?: string },
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction/bridged-receive-phase.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 1 passed, 1 total / Tests:       14 passed, 14 total. Then:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'bridged-receive-phase.test.ts\|db/types.ts\|transaction/complete.ts'
```

Expected: `0`.

- [ ] **Step 6: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts && npx eslint --max-warnings 0 src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts
```

Expected: no output from eslint (exit 0).

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: exactly `control hit`, no `DASH:` line.

- [ ] **Step 7: Commit**

Commit deferred to Task 7 (p1-reconciler-match), which makes spec commit 1.

---

### Task 2: Derive the xReserve recipient and expected token from wallet ids (p1-deposit-target)

Spec 10(a): one helper turns any form the wallet holds an account in (bech32, hex, composite `<bech32>_<suffix>`) into the bytes32 xReserve names, for the recipient and for the native faucet (the remote token). It imports the SDK through `accountRefToSdk`, so the Node harness never imports it.

**Files:**
- Create: `src/lib/usdcx/deposit-target.ts`
- Test: `src/lib/usdcx/deposit-target.test.ts`

**Interfaces:**
- Consumes: `accountRefToSdk(accountRef: string): AccountId` (src/lib/miden/sdk/helpers.ts:106; strips a composite suffix at :107), `midenAccountHexToXReserveRecipient(hexId: string): Hex` (src/lib/usdcx/recipient.ts:19).
- Produces:
  - `usdcxRemoteRecipientFor(accountRef: string): Hex`
  - `usdcxExpectedRemoteTokenFor(faucetRef: string): Hex`

jest maps the SDK to `__mocks__/wasmMock.js`, whose `AccountId` has no `fromHex` and whose `Address.fromBech32` returns an id with no `toString`, so the test supplies both through `jest.mock('@miden-sdk/miden-sdk/lazy', ...)` and runs the real `accountRefToSdk`. The ids are the account and faucet Circle named in the captured 0x370bf19a attestation.

- [ ] **Step 1: Write the failing test**

Create `src/lib/usdcx/deposit-target.test.ts` with exactly this content:

```ts
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from './deposit-target';

// The account and the USDCx faucet Circle named in the captured 0x370bf19a attestation (attestation.vectors.json).
const ACCOUNT_HEX = '0x8da911727d5b53916f2c221c00c091';
const FAUCET_HEX = '0x4cbdcaffe75f0a317482224dae6436';
const ACCOUNT_BECH32 = 'mtst1accountaddress0000000000000';
const FAUCET_BECH32 = 'mtst1faucetaddress00000000000000';

// The SDK parse as the wallet sees it: every form of one account resolves to the same id, and a bech32 address parses
// only without its composite suffix.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) },
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1accountaddress0000000000000: '0x8da911727d5b53916f2c221c00c091',
        mtst1faucetaddress00000000000000: '0x4cbdcaffe75f0a317482224dae6436'
      };
      const hex = known[address];
      if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
      return { accountId: () => ({ toString: () => hex }) };
    }
  }
}));

const ACCOUNT_RECIPIENT = '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100';
const FAUCET_TOKEN = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';

describe('usdcxRemoteRecipientFor', () => {
  it.each([
    ['a bare bech32 address', ACCOUNT_BECH32],
    ['a composite wallet id', `${ACCOUNT_BECH32}_qruqqypuyph`],
    ['a hex account id', ACCOUNT_HEX],
    ['an upper-case hex account id', `0x${ACCOUNT_HEX.slice(2).toUpperCase()}`]
  ])('encodes %s as the bytes32 Circle attested', (_label, ref) => {
    expect(usdcxRemoteRecipientFor(ref)).toBe(ACCOUNT_RECIPIENT);
  });

  it('throws for a reference that is no account', () => {
    expect(() => usdcxRemoteRecipientFor('not-an-account')).toThrow('invalid bech32 address');
  });
});

describe('usdcxExpectedRemoteTokenFor', () => {
  it.each([
    ['its bech32 address', FAUCET_BECH32],
    ['its composite id', `${FAUCET_BECH32}_qruqqypuyph`],
    ['its hex id', FAUCET_HEX]
  ])('encodes the native faucet by %s as the remote token Circle names', (_label, ref) => {
    expect(usdcxExpectedRemoteTokenFor(ref)).toBe(FAUCET_TOKEN);
  });
});
```

Mutation notes:
- `usdcxRemoteRecipientFor` returning `midenAccountHexToXReserveRecipient(accountRef)` (no SDK parse) fails the bech32 and composite cases with `Invalid Miden account id` and the no-account case on its message.
- `usdcxExpectedRemoteTokenFor` returning `midenAccountHexToXReserveRecipient(faucetRef)` fails its bech32 and composite cases.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/deposit-target.test.ts --maxWorkers=2
```

Expected: FAIL, `Cannot find module './deposit-target' from 'src/lib/usdcx/deposit-target.test.ts'` (Test Suites: 1 failed, 1 total / Tests:       0 total).

- [ ] **Step 3: Implement**

Create `src/lib/usdcx/deposit-target.ts` with exactly this content:

```ts
import type { Hex } from 'viem';

import { accountRefToSdk } from 'lib/miden/sdk/helpers';

import { midenAccountHexToXReserveRecipient } from './recipient';

/**
 * The xReserve `remoteRecipient` of a Miden account, from any form the wallet holds it in: bech32, hex, or the
 * composite `<bech32>_<suffix>` wallet id. Throws for a reference that is no account id.
 */
export function usdcxRemoteRecipientFor(accountRef: string): Hex {
  return midenAccountHexToXReserveRecipient(accountRefToSdk(accountRef).toString());
}

/**
 * The remote token the wallet expects xReserve to name for a deposit to Miden: the native (USDCx) faucet id in the
 * same bytes32 encoding. Not a signed value: Circle reads it from xReserve's registry.
 */
export function usdcxExpectedRemoteTokenFor(faucetRef: string): Hex {
  return midenAccountHexToXReserveRecipient(accountRefToSdk(faucetRef).toString());
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/deposit-target.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 1 passed, 1 total / Tests:       8 passed, 8 total.

- [ ] **Step 5: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/usdcx/deposit-target.ts src/lib/usdcx/deposit-target.test.ts && npx eslint --max-warnings 0 src/lib/usdcx/deposit-target.ts src/lib/usdcx/deposit-target.test.ts
```

Expected: exit 0, no eslint output.

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && { cat src/lib/usdcx/deposit-target.ts src/lib/usdcx/deposit-target.test.ts; } | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: exactly `control hit`.

- [ ] **Step 6: Commit**

Commit deferred to Task 7 (p1-reconciler-match), which makes spec commit 1.

---

### Task 3: Decode Circle's xReserve DepositIntent (p1-intent-decoder)

Spec 10(a): `decodeXReserveDepositIntent(payload)` reads the 240 + hookLength byte DepositIntent Circle signs, and is undefined unless magic `0x5a2e0acd`, version 1 and the exact length hold. The captured 0x370bf19a response is committed verbatim as test vectors (public chain data only; p3's `arc-usdcx.test.ts` imports it read-only). `attestation.ts` keeps importing only `viem` and `./constant`, so the Node harness can still import it, and keeps `isUsdcxDepositAttested` until the reconciler task.

**Files:**
- Create: `src/lib/usdcx/attestation.vectors.json`
- Modify: `.prettierignore` (one line: `yarn format` is `prettier --write src` and would rewrite the capture)
- Modify: `src/lib/usdcx/attestation.ts`
- Test: `src/lib/usdcx/attestation.test.ts`

**Interfaces:**
- Consumes: `XReserveAttestation` (attestation.ts:10-19), viem `hexToBigInt`, `hexToNumber`, `isHex`.
- Produces:
  - `XRESERVE_DEPOSIT_INTENT_MAGIC: Hex` (`'0x5a2e0acd'`), `XRESERVE_DEPOSIT_INTENT_VERSION = 1`
  - `interface XReserveDepositIntent { version: number; amount: bigint; remoteDomain: number; remoteToken: Hex; remoteRecipient: Hex; localToken: Hex; localDepositor: Hex; maxFee: bigint; nonce: Hex; hookData: Hex }` (hex lower case; `hookData` is `0x` for hook length 0; `nonce` is the bytes32 at offset 204)
  - `decodeXReserveDepositIntent(payload: Hex): XReserveDepositIntent | undefined`
  - `src/lib/usdcx/attestation.vectors.json`: the body of `GET https://xreserve-api-testnet.circle.com/v1/attestations?txHash=0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d`, byte for byte, plus one trailing newline.
  - `.prettierignore` gains `src/lib/usdcx/attestation.vectors.json`.

- [ ] **Step 1: Write the captured vectors as test data**

Write the file with a quoted heredoc so nothing in it is interpreted, and never run prettier on it (it must stay verbatim):

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && cat > src/lib/usdcx/attestation.vectors.json <<'JSON'
{"attestations":[{"remoteDomain":10007,"payload":"0x5a2e0acd00000001000000000000000000000000000000000000000000000000000000007735940000002717000000000000000000000000000000004cbdcaffe75f0a317482224dae643600000000000000000000000000000000008da911727d5b53916f2c221c00c091000000000000000000000000003600000000000000000000000000000000000000000000000000000000000000e88f781e6cc8b7496f259200b57e22cb9457ff990000000000000000000000000000000000000000000000000000000000000000335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a4100000000","messageHash":"0x308c84382bbc0567e1731826da390ec7c7e39f19664f7810d097c4dba8bde2d3","attestation":"0x3a12511754c4f9e96494912c990bdbfb87b4336ea5c636c3510c7259cc7127bd255f4688dbbf04e132714a520a29f42868cc99702bc44133f551acab14d1caab1c"}]}
JSON
shasum -a 256 src/lib/usdcx/attestation.vectors.json
```
Expected: `7be79c54f853248d2ebf8c1f5a9a65be1701b68b97c99545fe2df43d72843e0f  src/lib/usdcx/attestation.vectors.json` (the body without its trailing newline hashes to `861957824979517382aeec035ada889a07c662eb9cb8620cb66f3bb52af7b5a5`). If the hash differs, write the file from Circle instead (read-only request) and check again: `curl -sS 'https://xreserve-api-testnet.circle.com/v1/attestations?txHash=0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d' -o src/lib/usdcx/attestation.vectors.json && printf '\n' >> src/lib/usdcx/attestation.vectors.json && shasum -a 256 src/lib/usdcx/attestation.vectors.json`.

Then keep every formatter off it:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'src/lib/usdcx/attestation.vectors.json\n' >> .prettierignore && npx prettier --file-info src/lib/usdcx/attestation.vectors.json
```

Expected: `{ "ignored": true, "inferredParser": null }` (`.prettierignore` ends in a newline on origin/main, so the line lands on its own).

- [ ] **Step 2: Write the failing test**

`src/lib/usdcx/attestation.test.ts:1-9`, current text (unique in the file):

```ts
import {
  fetchXReserveAttestations,
  findAttestationForDomain,
  isUsdcxDepositAttested,
  XReserveAttestation
} from './attestation';
import { USDCX_REMOTE_DOMAIN, XRESERVE_ATTESTATION_API_TESTNET } from './constant';

const fetchMock = jest.fn();
```

becomes:

```ts
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Hex, isHex } from 'viem';

import {
  decodeXReserveDepositIntent,
  fetchXReserveAttestations,
  findAttestationForDomain,
  isUsdcxDepositAttested,
  XReserveAttestation
} from './attestation';
import vectors from './attestation.vectors.json';
import { USDCX_REMOTE_DOMAIN, XRESERVE_ATTESTATION_API_TESTNET } from './constant';

const fetchMock = jest.fn();
```

`src/lib/usdcx/attestation.test.ts:149-152`, current text (unique in the file):

```ts
    expect(findAttestationForDomain(list, 10005)).toBeUndefined();
  });
});

```

becomes:

```ts
    expect(findAttestationForDomain(list, 10005)).toBeUndefined();
  });
});

function hexOf(value: string | undefined): Hex {
  if (value === undefined || !isHex(value)) throw new Error(`not hex: ${value}`);
  return value;
}

// Circle's answer for deposit 0x370bf19a (attestation.vectors.json): 2000 USDC from Arc Testnet to Miden account
// 0x8da911727d5b53916f2c221c00c091, minted as the USDCx faucet 0x4cbdcaffe75f0a317482224dae6436.
const CAPTURED_PAYLOAD = hexOf(vectors.attestations[0]?.payload);
const ACCOUNT_RECIPIENT: Hex = '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100';
const USDCX_TOKEN: Hex = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';

/** `payload` with the bytes at `offset` replaced by `hex` (no 0x prefix), so one field changes at a time. */
const withBytes = (offset: number, hex: string, payload: Hex = CAPTURED_PAYLOAD): Hex =>
  `0x${payload.slice(2, 2 + offset * 2)}${hex}${payload.slice(2 + offset * 2 + hex.length)}`;

describe('decodeXReserveDepositIntent', () => {
  it('reads every field of the captured deposit', () => {
    expect(decodeXReserveDepositIntent(CAPTURED_PAYLOAD)).toEqual({
      version: 1,
      amount: 2_000_000_000n,
      remoteDomain: 10007,
      remoteToken: USDCX_TOKEN,
      remoteRecipient: ACCOUNT_RECIPIENT,
      localToken: '0x0000000000000000000000003600000000000000000000000000000000000000',
      localDepositor: '0x000000000000000000000000e88f781e6cc8b7496f259200b57e22cb9457ff99',
      maxFee: 0n,
      nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
      hookData: '0x'
    });
  });

  it('reads the hook data its length names, in lower case', () => {
    const hooked = withBytes(236, '00000002', `${CAPTURED_PAYLOAD}ABCD`);

    expect(decodeXReserveDepositIntent(hooked)?.hookData).toBe('0xabcd');
  });

  it.each<[string, Hex]>([
    ['another magic', withBytes(0, '5a2e0acc')],
    ['version 2', withBytes(4, '00000002')],
    ['one byte too many', `${CAPTURED_PAYLOAD}00`],
    ['one byte too few', hexOf(CAPTURED_PAYLOAD.slice(0, -2))],
    ['a hook length the payload does not carry', withBytes(236, '00000001')],
    ['a header cut short', hexOf(CAPTURED_PAYLOAD.slice(0, 2 + 236 * 2))],
    ['half a byte', `${CAPTURED_PAYLOAD}0`]
  ])('reads nothing from a payload with %s', (_label, payload) => {
    expect(decodeXReserveDepositIntent(payload)).toBeUndefined();
  });
});

// The capture is Circle's answer byte for byte: no formatter may touch it (.prettierignore lists it).
describe('attestation.vectors.json', () => {
  it('stays byte for byte the body Circle served for 0x370bf19a', () => {
    const file = readFileSync(join(__dirname, 'attestation.vectors.json'));
    expect(createHash('sha256').update(file).digest('hex')).toBe(
      '7be79c54f853248d2ebf8c1f5a9a65be1701b68b97c99545fe2df43d72843e0f'
    );
  });
});

```

Mutation notes:
- Deleting the `body.length !== (DEPOSIT_INTENT_HEADER_BYTES + hookLength) * 2` check returns an intent for 'one byte too many', 'one byte too few' and 'a hook length the payload does not carry'.
- Deleting the version check fails 'version 2'; dropping `.toLowerCase()` on the body fails 'reads the hook data its length names, in lower case' (`0xABCD`).
- Changing one byte of `attestation.vectors.json`, or formatting it with `npx prettier --write --ignore-path /dev/null src/lib/usdcx/attestation.vectors.json`, fails 'stays byte for byte the body Circle served for 0x370bf19a' (a pinning test: it passes from Step 1 on).

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/attestation.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 1 failed, 1 total / Tests:       9 failed, 21 passed, 30 total (the vectors pin already passes: Step 1 wrote the file), every failure `TypeError: (0 , _attestation.decodeXReserveDepositIntent) is not a function`:
  - `decodeXReserveDepositIntent › reads every field of the captured deposit`
  - `decodeXReserveDepositIntent › reads nothing from a payload with a header cut short`
  - `decodeXReserveDepositIntent › reads nothing from a payload with a hook length the payload does not carry`
  - `decodeXReserveDepositIntent › reads nothing from a payload with another magic`
  - `decodeXReserveDepositIntent › reads nothing from a payload with half a byte`
  - `decodeXReserveDepositIntent › reads nothing from a payload with one byte too few`
  - `decodeXReserveDepositIntent › reads nothing from a payload with one byte too many`
  - `decodeXReserveDepositIntent › reads nothing from a payload with version 2`
  - `decodeXReserveDepositIntent › reads the hook data its length names, in lower case`

- [ ] **Step 4: Implement**

`src/lib/usdcx/attestation.ts:1-4`, current text (unique in the file):

```ts
import { Hash, Hex, isHash, isHex } from 'viem';

import { USDCX_REMOTE_DOMAIN, XRESERVE_ATTESTATION_API_TESTNET } from './constant';

```

becomes:

```ts
import { Hash, Hex, hexToBigInt, hexToNumber, isHash, isHex } from 'viem';

import { USDCX_REMOTE_DOMAIN, XRESERVE_ATTESTATION_API_TESTNET } from './constant';

```

`src/lib/usdcx/attestation.ts:90-95`, current text (unique in the file):

```ts
  return findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN) !== undefined;
}

/** The attestation for one remote domain, if Circle signed it. */
export function findAttestationForDomain(
  attestations: XReserveAttestation[],
```

becomes:

```ts
  return findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN) !== undefined;
}

/** First 4 bytes of a Circle xReserve DepositIntent payload. */
export const XRESERVE_DEPOSIT_INTENT_MAGIC: Hex = '0x5a2e0acd';
export const XRESERVE_DEPOSIT_INTENT_VERSION = 1;
const DEPOSIT_INTENT_HEADER_BYTES = 240;

/**
 * Circle's xReserve DepositIntent, the message its attestation signs. Byte layout, checked on the captured
 * 0x370bf19a payload (240 bytes, no hook): magic@0[4] version@4[4] amount@8[32] remoteDomain@40[4]
 * remoteToken@44[32] remoteRecipient@76[32] localToken@108[32] localDepositor@140[32] maxFee@172[32] nonce@204[32]
 * hookLength@236[4] hookData@240[hookLength]. Hex fields are lower case.
 */
export interface XReserveDepositIntent {
  version: number;
  amount: bigint;
  remoteDomain: number;
  remoteToken: Hex;
  remoteRecipient: Hex;
  localToken: Hex;
  localDepositor: Hex;
  maxFee: bigint;
  nonce: Hex;
  /** `0x` when the hook length is 0. */
  hookData: Hex;
}

/** The deposit a payload describes, or `undefined` unless its magic, version 1 and length (240 + hook length) hold. */
export function decodeXReserveDepositIntent(payload: Hex): XReserveDepositIntent | undefined {
  if (!isHex(payload) || payload.length % 2 !== 0) return undefined;
  const body = payload.slice(2).toLowerCase();
  const bytes = (offset: number, length: number): Hex => `0x${body.slice(offset * 2, (offset + length) * 2)}`;
  if (body.length < DEPOSIT_INTENT_HEADER_BYTES * 2) return undefined;
  if (bytes(0, 4) !== XRESERVE_DEPOSIT_INTENT_MAGIC) return undefined;
  const version = hexToNumber(bytes(4, 4));
  if (version !== XRESERVE_DEPOSIT_INTENT_VERSION) return undefined;
  const hookLength = hexToNumber(bytes(236, 4));
  if (body.length !== (DEPOSIT_INTENT_HEADER_BYTES + hookLength) * 2) return undefined;
  return {
    version,
    amount: hexToBigInt(bytes(8, 32)),
    remoteDomain: hexToNumber(bytes(40, 4)),
    remoteToken: bytes(44, 32),
    remoteRecipient: bytes(76, 32),
    localToken: bytes(108, 32),
    localDepositor: bytes(140, 32),
    maxFee: hexToBigInt(bytes(172, 32)),
    nonce: bytes(204, 32),
    hookData: bytes(DEPOSIT_INTENT_HEADER_BYTES, hookLength)
  };
}

/** The attestation for one remote domain, if Circle signed it. */
export function findAttestationForDomain(
  attestations: XReserveAttestation[],
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/attestation.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 1 passed, 1 total / Tests:       30 passed, 30 total.

- [ ] **Step 6: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts && npx eslint --max-warnings 0 src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts
```

Expected: exit 0. Do not pass `attestation.vectors.json` to prettier.

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- .prettierignore src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: exactly `control hit`.

- [ ] **Step 7: Commit**

Commit deferred to Task 7 (p1-reconciler-match), which makes spec commit 1.

---

### Task 4: Match an attestation against what the wallet signed (p1-attestation-matcher)

Spec 10(a) and D7: `matchUsdcxDepositAttestation(list, expected)` compares Circle's DepositIntent for the Miden domain with the row's expectation, hex case-insensitively, in the order remoteDomain, remoteToken, recipient, amount; across entries attested > unreadable > mismatch > pending. maxFee, hookData and localDepositor are not compared. The two older deposits the spec names, 0x908904ec and 0xb4dce6ec (Circle's answers read 2026-10-10), name the previous USDCx faucet `0x179f749ee2329e317d96fe3ed5aaf9` and recipients no Miden id encodes to; the test applies their token, recipient and amount fields to the captured payload. `isUsdcxDepositAttested` stays until the next task.

**Files:**
- Modify: `src/lib/usdcx/attestation.ts`
- Test: `src/lib/usdcx/attestation.test.ts`

**Interfaces:**
- Consumes: `decodeXReserveDepositIntent` (Task 3, p1-intent-decoder), `USDCX_REMOTE_DOMAIN` (src/lib/usdcx/constant.ts:329).
- Produces:
  - `interface UsdcxDepositExpectation { remoteRecipient: Hex; remoteToken: Hex; amount: bigint; remoteDomain?: number }` (domain defaults to `USDCX_REMOTE_DOMAIN`)
  - `type UsdcxAttestationMismatchField = 'remoteDomain' | 'remoteToken' | 'recipient' | 'amount'`
  - `type UsdcxAttestationMatch = { kind: 'attested'; attestation: XReserveAttestation; intent: XReserveDepositIntent } | { kind: 'mismatch'; field: UsdcxAttestationMismatchField } | { kind: 'unreadable' } | { kind: 'pending' }`
  - `matchUsdcxDepositAttestation(list: readonly XReserveAttestation[], expected: UsdcxDepositExpectation): UsdcxAttestationMatch`

- [ ] **Step 1: Write the failing test**

`src/lib/usdcx/attestation.test.ts:8-13`, current text (unique in the file):

```ts
  fetchXReserveAttestations,
  findAttestationForDomain,
  isUsdcxDepositAttested,
  XReserveAttestation
} from './attestation';
import vectors from './attestation.vectors.json';
```

becomes:

```ts
  fetchXReserveAttestations,
  findAttestationForDomain,
  isUsdcxDepositAttested,
  matchUsdcxDepositAttestation,
  UsdcxDepositExpectation,
  XReserveAttestation
} from './attestation';
import vectors from './attestation.vectors.json';
```

`src/lib/usdcx/attestation.test.ts:206-209`, current text (unique in the file):

```ts
    expect(decodeXReserveDepositIntent(payload)).toBeUndefined();
  });
});

```

becomes:

```ts
    expect(decodeXReserveDepositIntent(payload)).toBeUndefined();
  });
});

// Two older deposits Circle attested (0x908904ec and 0xb4dce6ec, read 2026-10-10) name the previous USDCx faucet
// 0x179f749ee2329e317d96fe3ed5aaf9 and a recipient no Miden account id encodes to: an id missing its trailing zero
// byte, and a suffix whose low byte is not zero. Each payload here carries their token, recipient and amount.
const OLD_TOKEN: Hex = '0x00000000000000000000000000000000179f749ee2329e317d96fe3ed5aaf900';
const oldDeposit = (recipient: string, amount: string): Hex =>
  withBytes(8, amount.padStart(64, '0'), withBytes(44, OLD_TOKEN.slice(2), withBytes(76, recipient)));
const PAYLOAD_908904EC = oldDeposit('00000000000000000000000000000000009f2331d6b181dd5170cd318bdcd601', 'f4240');
const PAYLOAD_B4DCE6EC = oldDeposit('0000000000000000000000000000000088363e3c54d0c6d10031a96e54ceed80', '3b9aca00');

const attestationOf = (payload: Hex, remoteDomain = USDCX_REMOTE_DOMAIN): XReserveAttestation => ({
  payload,
  messageHash: `0x${'1'.repeat(64)}`,
  attestation: '0xabcd',
  remoteDomain
});
const CAPTURED = attestationOf(CAPTURED_PAYLOAD);
const expected = (overrides: Partial<UsdcxDepositExpectation> = {}): UsdcxDepositExpectation => ({
  remoteRecipient: ACCOUNT_RECIPIENT,
  remoteToken: USDCX_TOKEN,
  amount: 2_000_000_000n,
  ...overrides
});

describe('matchUsdcxDepositAttestation', () => {
  it('attests a deposit whose amount, recipient, token and domain all match, comparing hex in any case', () => {
    const upper: Hex = `0x${ACCOUNT_RECIPIENT.slice(2).toUpperCase()}`;

    expect(matchUsdcxDepositAttestation([CAPTURED], expected({ remoteRecipient: upper }))).toEqual({
      kind: 'attested',
      attestation: CAPTURED,
      intent: decodeXReserveDepositIntent(CAPTURED_PAYLOAD)
    });
  });

  it('waits while Circle has attested nothing', () => {
    expect(matchUsdcxDepositAttestation([], expected())).toEqual({ kind: 'pending' });
  });

  it.each<[string, XReserveAttestation[], UsdcxDepositExpectation, string]>([
    ['an attestation for Canton (10001) only', [attestationOf(CAPTURED_PAYLOAD, 10001)], expected(), 'remoteDomain'],
    [
      'a payload naming another domain than its entry',
      [attestationOf(withBytes(40, '00002711'))],
      expected(),
      'remoteDomain'
    ],
    ['another token', [CAPTURED], expected({ remoteToken: OLD_TOKEN }), 'remoteToken'],
    ['another Miden account', [CAPTURED], expected({ remoteRecipient: USDCX_TOKEN }), 'recipient'],
    ['another amount', [CAPTURED], expected({ amount: 1_999_999_999n }), 'amount'],
    ['the previous USDCx faucet', [attestationOf(PAYLOAD_908904EC)], expected({ amount: 1_000_000n }), 'remoteToken'],
    [
      'a recipient missing its trailing zero byte (0x908904ec)',
      [attestationOf(PAYLOAD_908904EC)],
      expected({
        remoteToken: OLD_TOKEN,
        remoteRecipient: '0x000000000000000000000000000000009f2331d6b181dd5170cd318bdcd60100',
        amount: 1_000_000n
      }),
      'recipient'
    ],
    [
      'a recipient whose suffix ends in a non-zero byte (0xb4dce6ec)',
      [attestationOf(PAYLOAD_B4DCE6EC)],
      expected({
        remoteToken: OLD_TOKEN,
        remoteRecipient: '0x0000000000000000000000000000000088363e3c54d0c6d10031a96e54ceed00',
        amount: 1_000_000_000n
      }),
      'recipient'
    ],
    [
      'a payload that differs in domain and recipient',
      [attestationOf(withBytes(40, '00002711'))],
      expected({ remoteRecipient: USDCX_TOKEN }),
      'remoteDomain'
    ],
    [
      'a deposit that differs in token and recipient',
      [CAPTURED],
      expected({ remoteToken: OLD_TOKEN, remoteRecipient: USDCX_TOKEN }),
      'remoteToken'
    ],
    [
      'a recipient mismatch beside an entry for another domain',
      [attestationOf(CAPTURED_PAYLOAD, 10001), CAPTURED],
      expected({ remoteRecipient: USDCX_TOKEN }),
      'recipient'
    ]
  ])('names the first field that differs for %s', (_label, list, expectation, field) => {
    expect(matchUsdcxDepositAttestation(list, expectation)).toEqual({ kind: 'mismatch', field });
  });

  it.each<[string, Hex]>([
    ['another magic', withBytes(0, '5a2e0acc')],
    ['version 2', withBytes(4, '00000002')],
    ['one byte too many', `${CAPTURED_PAYLOAD}00`],
    ['one byte too few', hexOf(CAPTURED_PAYLOAD.slice(0, -2))]
  ])('cannot read an entry for Miden with %s', (_label, payload) => {
    expect(matchUsdcxDepositAttestation([attestationOf(payload)], expected())).toEqual({ kind: 'unreadable' });
  });

  it('attests a matching entry beside a mismatching one, in either order', () => {
    const other = attestationOf(withBytes(76, ACCOUNT_RECIPIENT.slice(2).replace('8da9', '8da8')));

    expect(matchUsdcxDepositAttestation([other, CAPTURED], expected()).kind).toBe('attested');
    expect(matchUsdcxDepositAttestation([CAPTURED, other], expected()).kind).toBe('attested');
  });

  it('reports an unreadable entry over a mismatching one', () => {
    const unreadable = attestationOf(withBytes(0, '5a2e0acc'));

    expect(matchUsdcxDepositAttestation([CAPTURED, unreadable], expected({ amount: 1n }))).toEqual({
      kind: 'unreadable'
    });
  });

  it('compares neither the fee, the hook data nor the depositor', () => {
    const fee = withBytes(172, `${'0'.repeat(56)}000f4240`);
    const depositor = withBytes(140, `${'0'.repeat(24)}${'1'.repeat(40)}`, fee);
    const hooked = withBytes(236, '00000002', `${depositor}abcd`);

    expect(matchUsdcxDepositAttestation([attestationOf(hooked)], expected()).kind).toBe('attested');
  });

  it("matches the domain the caller names, the payload's as well as the entry's", () => {
    const canton = attestationOf(withBytes(40, '00002711'), 10001);

    expect(matchUsdcxDepositAttestation([canton], expected({ remoteDomain: 10001 })).kind).toBe('attested');
    expect(matchUsdcxDepositAttestation([canton], expected())).toEqual({ kind: 'mismatch', field: 'remoteDomain' });
  });
});

```

Mutation notes:
- Removing `if (attestation.remoteDomain !== remoteDomain) continue;` fails 'an attestation for Canton (10001) only' (it reads attested).
- Swapping the token and recipient checks in `firstDifference` fails 'a deposit that differs in token and recipient'; checking the mismatch before `unreadable` fails 'reports an unreadable entry over a mismatching one'.
- Comparing `intent.maxFee` or `intent.localDepositor` fails 'compares neither the fee, the hook data nor the depositor'.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/attestation.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 1 failed, 1 total / Tests:       21 failed, 30 passed, 51 total, each failure `TypeError: (0 , _attestation.matchUsdcxDepositAttestation) is not a function`.

- [ ] **Step 3: Implement**

`src/lib/usdcx/attestation.ts:140-145`, current text (unique in the file):

```ts
  };
}

/** The attestation for one remote domain, if Circle signed it. */
export function findAttestationForDomain(
  attestations: XReserveAttestation[],
```

becomes:

```ts
  };
}

/** What the wallet expects Circle to attest for one of its deposits to Miden. */
export interface UsdcxDepositExpectation {
  /** The `remoteRecipient` bytes32 the deposit signed. */
  remoteRecipient: Hex;
  /** The native faucet's bytes32: xReserve's registry, not the deposit, names it, so it is checked here. */
  remoteToken: Hex;
  /** The row's amount, in USDC base units: an executor deposit pays its fee on top, so both routes match it. */
  amount: bigint;
  /** Defaults to USDCX_REMOTE_DOMAIN. */
  remoteDomain?: number;
}

export type UsdcxAttestationMismatchField = 'remoteDomain' | 'remoteToken' | 'recipient' | 'amount';

export type UsdcxAttestationMatch =
  | { kind: 'attested'; attestation: XReserveAttestation; intent: XReserveDepositIntent }
  | { kind: 'mismatch'; field: UsdcxAttestationMismatchField }
  | { kind: 'unreadable' }
  | { kind: 'pending' };

const sameHex = (left: Hex, right: Hex): boolean => left.toLowerCase() === right.toLowerCase();

function firstDifference(
  intent: XReserveDepositIntent,
  expected: UsdcxDepositExpectation,
  remoteDomain: number
): UsdcxAttestationMismatchField | undefined {
  if (intent.remoteDomain !== remoteDomain) return 'remoteDomain';
  if (!sameHex(intent.remoteToken, expected.remoteToken)) return 'remoteToken';
  if (!sameHex(intent.remoteRecipient, expected.remoteRecipient)) return 'recipient';
  if (intent.amount !== expected.amount) return 'amount';
  return undefined;
}

/**
 * Whether Circle attested what the wallet signed: the entry for the Miden domain must decode, and its domain, token,
 * recipient and amount must equal the expectation, compared in that order. The fee, the hook data and the depositor
 * are not compared: Circle mints a deposit's whole amount whatever fee it allowed, and an executor deposit's depositor
 * is Circle's handler. Across entries an attested one wins, then an unreadable one, then a mismatch.
 */
export function matchUsdcxDepositAttestation(
  list: readonly XReserveAttestation[],
  expected: UsdcxDepositExpectation
): UsdcxAttestationMatch {
  if (list.length === 0) return { kind: 'pending' };
  const remoteDomain = expected.remoteDomain ?? USDCX_REMOTE_DOMAIN;
  let unreadable = false;
  let mismatch: UsdcxAttestationMismatchField | undefined;
  for (const attestation of list) {
    if (attestation.remoteDomain !== remoteDomain) continue;
    const intent = decodeXReserveDepositIntent(attestation.payload);
    if (intent === undefined) {
      unreadable = true;
      continue;
    }
    const field = firstDifference(intent, expected, remoteDomain);
    if (field === undefined) return { kind: 'attested', attestation, intent };
    mismatch ??= field;
  }
  if (unreadable) return { kind: 'unreadable' };
  return { kind: 'mismatch', field: mismatch ?? 'remoteDomain' };
}

/** The attestation for one remote domain, if Circle signed it. */
export function findAttestationForDomain(
  attestations: XReserveAttestation[],
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/attestation.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 1 passed, 1 total / Tests:       51 passed, 51 total.

- [ ] **Step 5: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts && npx eslint --max-warnings 0 src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 6: Commit**

Commit deferred to Task 7 (p1-reconciler-match), which makes spec commit 1.

---

### Task 5: Deposit writers persist the signed recipient (spec commit 1, deferred) (p2-recipient-writers)

**Key:** `p2-recipient-writers`. Runs after Task 4 (`p1-attestation-matcher`); its files are committed by Task 7 (`p1-reconciler-match`).

**Files:** (line numbers are origin/main's, read with `git show origin/main:<path>`; match on the quoted text)
- Modify: `src/lib/usdcx/deposit.ts` (:77 docblock, :107)
- Modify: `src/lib/usdcx/executor.ts` (:262 docblock, :324-329)
- Test: `src/lib/usdcx/deposit.test.ts` (:14, :99, after :101, :177)
- Test: `src/lib/usdcx/executor.test.ts` (:34, :243-247, after :248, :277-280)

**Interfaces:**
- Consumes: `updateBridgedReceivePhase(id: string, phase: IBridgedReceivePhase, extra?: Partial<Pick<IBridgedReceiveExtraInputs, 'evmTxHash' | 'intentNonce' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'cctp' | 'error' | 'usdcxRemoteRecipient'>>, received?: { amount: bigint; faucetId: string; transactionId?: string }, options?: { onlyIfNoExecuteHash?: boolean }): Promise<void>` (complete.ts:1553-1566, Pick widened by Task 1 (`p1-recipient-field`)) and `IBridgedReceiveExtraInputs.usdcxRemoteRecipient?: string` (types.ts:165-187, added by Task 1 (`p1-recipient-field`)). Both arrive only through `UsdcxDepositDeps.updatePhase: typeof updateBridgedReceivePhase` (deposit.ts:37) and `UsdcxExecutorDepositDeps.updatePhase` (executor.ts:249).
- Produces: unchanged signatures `runUsdcxDeposit(trackingTxId: string, amount: string, remoteRecipient: Hex, deps: UsdcxDepositDeps): Promise<Hash>` (deposit.ts:85-90) and `runUsdcxExecutorDeposit(trackingTxId: string, amount: string, remoteRecipient: Hex, deps: UsdcxExecutorDepositDeps): Promise<Hash>` (executor.ts:266-280). Their FIRST `updatePhase(trackingTxId, 'submitting', extra)` now carries `usdcxRemoteRecipient: remoteRecipient.toLowerCase()`; the `delivering` write is unchanged (contract section 2.1).

- [ ] **Step 1: Write the failing tests**

In `src/lib/usdcx/deposit.test.ts`, after `:14` (`const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;`) add:

```ts
const MIXED_CASE_RECIPIENT = '0x00000000000000000000000000000000B64E1827414584510723CAD8E145A400' as const;
```

Replace `:99-101`:

```ts
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', { evmTxHash: DEPOSIT_HASH });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: DEPOSIT_HASH });
  });
```

with:

```ts
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: DEPOSIT_HASH,
      usdcxRemoteRecipient: RECIPIENT
    });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: DEPOSIT_HASH });
  });

  // The reconciler trusts Circle's attestation only when it names this recipient, so it lands with the hash, before
  // a receipt wait can strand the row.
  it('persists the recipient it signed, lowercased, with the first phase write only', async () => {
    const { deps } = makeDeps();

    await runUsdcxDeposit('row-1', '1', MIXED_CASE_RECIPIENT, deps);

    expect(jest.mocked(deps.updatePhase).mock.calls).toEqual([
      ['row-1', 'submitting', { evmTxHash: DEPOSIT_HASH, usdcxRemoteRecipient: RECIPIENT }],
      ['row-1', 'delivering', { evmTxHash: DEPOSIT_HASH }]
    ]);
  });
```

Replace `:176-177` (inside `propagates a reverted deposit and leaves the row in submitting`):

```ts
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', { evmTxHash: DEPOSIT_HASH });
```

with:

```ts
    expect(deps.updatePhase).toHaveBeenCalledTimes(1);
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: DEPOSIT_HASH,
      usdcxRemoteRecipient: RECIPIENT
    });
```

In `src/lib/usdcx/executor.test.ts`, after `:34` (`const RECIPIENT = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400' as const;`) add the same `MIXED_CASE_RECIPIENT` line. Replace `:243-248`:

```ts
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: BURN_HASH,
      cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' }
    });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: BURN_HASH });
  });
```

with:

```ts
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: BURN_HASH,
      usdcxRemoteRecipient: RECIPIENT,
      cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' }
    });
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'delivering', { evmTxHash: BURN_HASH });
  });

  // The executor's deposit names the same recipient, so the reconciler can match Circle's attestation of it.
  it('persists the recipient it signed, lowercased, with the first phase write only', async () => {
    const { deps } = makeDeps();

    await runUsdcxExecutorDeposit('row-1', '1.5', MIXED_CASE_RECIPIENT, deps);

    expect(jest.mocked(deps.updatePhase).mock.calls).toEqual([
      [
        'row-1',
        'submitting',
        {
          evmTxHash: BURN_HASH,
          usdcxRemoteRecipient: RECIPIENT,
          cctp: { sourceDomain: 6, forwarded: true, forwardFee: '31908' }
        }
      ],
      ['row-1', 'delivering', { evmTxHash: BURN_HASH }]
    ]);
  });
```

Replace `:277-280` (manual-burn test):

```ts
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: BURN_HASH,
      cctp: { sourceDomain: 6, forwarded: false }
    });
```

with:

```ts
    expect(deps.updatePhase).toHaveBeenCalledWith('row-1', 'submitting', {
      evmTxHash: BURN_HASH,
      usdcxRemoteRecipient: RECIPIENT,
      cctp: { sourceDomain: 6, forwarded: false }
    });
```

Mutation notes: reverting deposit.ts:107 to `{ evmTxHash: depositHash }` fails `persists the recipient it signed...` (deposit) on the `- "usdcxRemoteRecipient"` diff line; dropping `.toLowerCase()` there fails the same test with the upper-case bytes; the same two mutations at executor.ts:324-329 fail the executor test of the same name (both verified on a scratch copy of origin/main).

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx/deposit.test.ts src/lib/usdcx/executor.test.ts --maxWorkers=2
```

Expected: `Tests: 6 failed, 33 passed, 39 total`. The failures are `runUsdcxDeposit > runs approve, deposit and the phase writes in order`, `> persists the recipient it signed, lowercased, with the first phase write only`, `> propagates a reverted deposit and leaves the row in submitting`, and in `runUsdcxExecutorDeposit` the first test, the new test and `falls back to a manual burn...`. The new deposit test prints `expect(received).toEqual(expected)` with the line `-       "usdcxRemoteRecipient": "0x00000000000000000000000000000000b64e1827414584510723cad8e145a400",` on the Expected side only.

- [ ] **Step 3: Implement**

`src/lib/usdcx/deposit.ts:77`, before:

```ts
 * the amount, call `depositToRemote`, record the hash on the row, wait for the
```

after:

```ts
 * the amount, call `depositToRemote`, record the hash and the signed recipient on the row, wait for the
```

`src/lib/usdcx/deposit.ts:107`, before:

```ts
  await updatePhase(trackingTxId, 'submitting', { evmTxHash: depositHash });
```

after:

```ts
  await updatePhase(trackingTxId, 'submitting', {
    evmTxHash: depositHash,
    usdcxRemoteRecipient: remoteRecipient.toLowerCase()
  });
```

`src/lib/usdcx/executor.ts:262`, before:

```ts
 * short, the hash is recorded on the row before the receipt is awaited, and the row then moves to `delivering`.
```

after:

```ts
 * short, the hash and the signed recipient are recorded on the row before the receipt is awaited, and the row then
 * moves to `delivering`.
```

`src/lib/usdcx/executor.ts:324-326`, before:

```ts
  await updatePhase(trackingTxId, 'submitting', {
    evmTxHash: burnHash,
    cctp: quote
```

after:

```ts
  await updatePhase(trackingTxId, 'submitting', {
    evmTxHash: burnHash,
    usdcxRemoteRecipient: remoteRecipient.toLowerCase(),
    cctp: quote
```

- [ ] **Step 4: Run the tests and the whole directory**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx --maxWorkers=2
```

Expected: every suite in `src/lib/usdcx` passes, 0 failed.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/lib/usdcx/deposit.ts src/lib/usdcx/deposit.test.ts src/lib/usdcx/executor.ts src/lib/usdcx/executor.test.ts && npx eslint --max-warnings 0 src/lib/usdcx/deposit.ts src/lib/usdcx/deposit.test.ts src/lib/usdcx/executor.ts src/lib/usdcx/executor.test.ts
```

Expected: prettier changes nothing, eslint exits 0.

- [ ] **Step 6: Commit deferred to Task 7 (p1-reconciler-match)**

Do not stage. Leave `src/lib/usdcx/deposit.ts`, `src/lib/usdcx/deposit.test.ts`, `src/lib/usdcx/executor.ts`, `src/lib/usdcx/executor.test.ts` modified; `p1-reconciler-match` adds them by explicit path to `fix(usdcx): mark a deposit ready only when Circle's attestation matches what the wallet signed`.

---

### Task 6: Deposit screen derives the recipient through usdcxRemoteRecipientFor (spec commit 1, deferred) (p2-screen-recipient)

**Key:** `p2-screen-recipient`. Runs after Task 5 (`p2-recipient-writers`); its files are committed by Task 7 (`p1-reconciler-match`).

**Files:** (origin/main lines)
- Modify: `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx` (:31, :56, :63, :598, :832)
- Test: `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx` (:7, after :102, :315, before the final `});` at :625)

**Interfaces:**
- Consumes: `usdcxRemoteRecipientFor(accountRef: string): Hex` from `src/lib/usdcx/deposit-target.ts` (Task 2 (`p1-deposit-target`); it calls `accountRefToSdk` from `lib/miden/sdk/helpers`, sdk/helpers.ts:106, which this test file already mocks at :88-90).
- Produces: the quote derivation (:598) and the deposit derivation (:832) both read `usdcxRemoteRecipientFor(midenAccount.publicKey)`; `accountRefToSdk` and `midenAccountHexToXReserveRecipient` are no longer imported by the screen.

- [ ] **Step 1: Write the failing tests**

In `EvmBridgeDepositScreen.usdcx.test.tsx`, after `:7` (`import { runUsdcxDeposit } from 'lib/usdcx/deposit';`) add:

```ts
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
```

After the `jest.mock('lib/usdcx/deposit', ...)` block (:99-102) add:

```ts
// The real derivation, spied on: a test can hand the screen a recipient no other path would produce.
jest.mock('lib/usdcx/deposit-target', () => {
  const actual = jest.requireActual<typeof import('lib/usdcx/deposit-target')>('lib/usdcx/deposit-target');
  return { ...actual, usdcxRemoteRecipientFor: jest.fn(actual.usdcxRemoteRecipientFor) };
});
const { usdcxRemoteRecipientFor: actualUsdcxRemoteRecipientFor } =
  jest.requireActual<typeof import('lib/usdcx/deposit-target')>('lib/usdcx/deposit-target');
/** A recipient only `usdcxRemoteRecipientFor` returns, never the bytes the account id encodes to. */
const SIGNED_RECIPIENT = `0x${'ab'.repeat(32)}` as const;
```

In the describe's `beforeEach` (:313-321), after `mockUseDebounce.mockImplementation((value: unknown) => [value]);` add:

```ts
    jest.mocked(usdcxRemoteRecipientFor).mockImplementation(actualUsdcxRemoteRecipientFor);
```

Before the describe's closing `});` (:625, right after the test `asks Circle for the debounced amount and shows no fee for an amount it was not quoted for`) add:

```ts
  // The reconciler re-derives the recipient with the same helper, so the bytes a deposit signs are the bytes Circle's
  // attestation is matched against.
  it('signs an xReserve deposit for the recipient usdcxRemoteRecipientFor derives from the account', async () => {
    jest.mocked(usdcxRemoteRecipientFor).mockReturnValue(SIGNED_RECIPIENT);
    renderScreen();
    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(usdcxRemoteRecipientFor).toHaveBeenCalledWith(midenAccount.publicKey);
    expect(runUsdcxDeposit).toHaveBeenCalledWith('bridge-tx', '1.5', SIGNED_RECIPIENT, expect.anything());
  });

  it('quotes and burns an executor deposit for the recipient usdcxRemoteRecipientFor derives', async () => {
    jest.mocked(usdcxRemoteRecipientFor).mockReturnValue(SIGNED_RECIPIENT);
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(buildExecutorBurnIntent).toHaveBeenCalledWith(
      '1.5',
      expect.objectContaining({ route: 'cctp-executor' }),
      SIGNED_RECIPIENT,
      '0x1111111111111111111111111111111111111111'
    );
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(usdcxRemoteRecipientFor).toHaveBeenCalledWith(midenAccount.publicKey);
    expect(runUsdcxExecutorDeposit).toHaveBeenCalledWith(
      expect.any(String),
      '1.5',
      SIGNED_RECIPIENT,
      expect.anything()
    );
  });
```

Mutation notes: restoring :832 to `midenAccountHexToXReserveRecipient(accountRefToSdk(midenAccount.publicKey).toString())` fails `signs an xReserve deposit...` (`runUsdcxDeposit` receives `0x...b64e...a400`, not `SIGNED_RECIPIENT`); restoring :598 fails `quotes and burns an executor deposit...` on the `buildExecutorBurnIntent` assertion.

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx --maxWorkers=2
```

Expected: `Tests: 2 failed, 17 passed, 19 total`; `signs an xReserve deposit...` fails with `expect(jest.fn()).toHaveBeenCalledWith(...expected)`, `Expected: "mtst1azmyuxp8g9zcg5g8y09d3c295s3n6fl4"`, `Number of calls: 0`.

- [ ] **Step 3: Implement**

`EvmBridgeDepositScreen.tsx:31`, delete:

```ts
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
```

After `:56` (`import { isUsdcxDomainNotRegisteredError, runUsdcxDeposit, UsdcxSigner } from 'lib/usdcx/deposit';`) add:

```ts
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
```

`:63`, delete:

```ts
import { midenAccountHexToXReserveRecipient } from 'lib/usdcx/recipient';
```

`:598` and `:832` (the same line, twice), before:

```ts
        const recipient = midenAccountHexToXReserveRecipient(accountRefToSdk(midenAccount.publicKey).toString());
```

after (both sites):

```ts
        const recipient = usdcxRemoteRecipientFor(midenAccount.publicKey);
```

`grep -n "accountRefToSdk\|midenAccountHexToXReserveRecipient" src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx` must print nothing.

- [ ] **Step 4: Run the tests and the whole directory**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/app/templates/EvmConnectModal --maxWorkers=2
```

Expected: 12 suites pass, 0 failed.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx && npx eslint --max-warnings 0 src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx
```

Expected: eslint exits 0 (no unused import left behind).

- [ ] **Step 6: Commit deferred to Task 7 (p1-reconciler-match)**

Do not stage. Leave `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx` and `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx` modified for `p1-reconciler-match` (contract section 7, commit 1).

---

### Task 7: Match Circle's attestation in both reconcilers (p1-reconciler-match)

Spec 10(a), D7, Q10. A direct xReserve row becomes `ready` only when the attestation of its deposit hash matches what it signed, and a mismatch fails it naming what differs; an executor row reads the attestation of its Arc execute hash, becomes `ready` on a match and only warns (once per row) on a mismatch, since that hash can be a forward Iris reported. `pending` and `unreadable` write nothing on both routes (`unreadable` warns once). The expectation is the persisted `usdcxRemoteRecipient` when it is hex, else the one `row.accountId` derives (so rows from before the field settle), the token from `row.faucetId`, and `row.amount`; a row with no faucet, no amount or an unreadable account asks Circle nothing and warns once. `isUsdcxDepositAttested` is removed. This task makes spec commit 1, which also carries p2's six commit-1 files (section 7).

**Files:**
- Create: `src/lib/miden/activity/bridge-receive.usdcx.test.ts`
- Modify: `src/lib/miden/activity/bridge-receive.ts`
- Modify: `src/lib/usdcx/attestation.ts` (remove `isUsdcxDepositAttested`, :80-91 on main)
- Test: `src/lib/miden/activity/bridge-receive.test.ts`, `src/lib/usdcx/attestation.test.ts`

**Interfaces:**
- Consumes: `fetchXReserveAttestations(txHash: Hash, options?: { baseUrl?: string; timeoutMs?: number }): Promise<XReserveAttestation[]>` (attestation.ts:55-78), `matchUsdcxDepositAttestation`, `UsdcxDepositExpectation`, `UsdcxAttestationMatch`, `UsdcxAttestationMismatchField` (Task 4, p1-attestation-matcher), `usdcxRemoteRecipientFor`, `usdcxExpectedRemoteTokenFor` (Task 2, p1-deposit-target), `IBridgedReceiveExtraInputs.usdcxRemoteRecipient` (Task 1, p1-recipient-field), `updateBridgedReceivePhase` (complete.ts), `USDCX_SOURCE_CHAINS` (constant.ts:249), `readEvmReceiptOutcome` (lib/walletconnect/receipt.ts:37).
- Produces (row errors p5 asserts, written with phase `failed` through `updateBridgedReceivePhase`):
  - `Circle attested this deposit to a different network.` (remoteDomain)
  - `Circle attested this deposit to a different token.` (remoteToken)
  - `Circle attested this deposit to a different Miden account.` (recipient)
  - `Circle attested this deposit to a different amount.` (amount)
- Removes: `isUsdcxDepositAttested` (no other caller on origin/main; `fetchXReserveAttestations` and `findAttestationForDomain` stay for `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts:4` until PR 2).

The new suite runs the real decode, matcher, deposit-target helper, writer and store against `attestation.vectors.json`; only the SDK id parse, `fetch` and the Arc receipt read are stood in for. Executor rows use Base Sepolia (84532), never Sepolia, which p2's commit 7b moves.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/miden/activity/bridge-receive.usdcx.test.ts` with exactly this content:

```ts
import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import vectors from 'lib/usdcx/attestation.vectors.json';

import { reconcileBridgedReceives } from './bridge-receive';

// Circle attested deposit 0x370bf19a (attestation.vectors.json) to Miden account 0x8da911727d5b53916f2c221c00c091,
// 2000 USDC as the USDCx faucet 0x4cbdcaffe75f0a317482224dae6436. Real attestation decode and match, real writer and
// store; only the SDK's id parse, Circle's API and the Arc receipt read are stood in for.
const DEPOSIT_HASH = '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d';
const ATTESTED_ACCOUNT = 'mtst1attestedaccount00000000000';
const OTHER_ACCOUNT = 'mtst1otheraccount00000000000000';
const USDCX_FAUCET = 'mtst1usdcxfaucet000000000000000';
const ATTESTED_RECIPIENT = '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1attestedaccount00000000000: '0x8da911727d5b53916f2c221c00c091',
        mtst1otheraccount00000000000000: '0x0123456789abcdef0123456789ab00',
        mtst1usdcxfaucet000000000000000: '0x4cbdcaffe75f0a317482224dae6436'
      };
      const hex = known[address];
      if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
      return { accountId: () => ({ toString: () => hex }) };
    }
  }
}));
const mockReadOutcome = jest.fn();
jest.mock('lib/walletconnect/receipt', () => ({
  waitForSepoliaReceipt: jest.fn(),
  readEvmReceiptOutcome: (...args: unknown[]) => mockReadOutcome(...args)
}));

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

const addDeposit = async (
  accountId: string,
  extra: Partial<IBridgedReceiveExtraInputs> & { sourceChainId: number }
): Promise<string> => {
  const row = new BridgedReceiveTransaction(
    accountId,
    2_000_000_000n,
    USDCX_FAUCET,
    'usdcx',
    '0xe88f781e6cc8b7496f259200b57e22cb9457ff99',
    '2000',
    'USDC'
  );
  row.extraInputs = { ...row.extraInputs, phase: 'delivering', evmTxHash: DEPOSIT_HASH, ...extra };
  await Repo.transactions.add(row);
  return row.id;
};
const phaseOf = async (id: string) => (await Repo.transactions.get(id))?.extraInputs;

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => vectors });
  mockReadOutcome.mockResolvedValue('pending');
});

describe('a direct USDCx deposit', () => {
  it('becomes ready when Circle attested it to the account the row belongs to', async () => {
    const id = await addDeposit(ATTESTED_ACCOUNT, { sourceChainId: 5042002 });

    await reconcileBridgedReceives();

    expect(fetchMock).toHaveBeenCalledWith(
      `https://xreserve-api-testnet.circle.com/v1/attestations?txHash=${DEPOSIT_HASH}`,
      expect.anything()
    );
    expect(await phaseOf(id)).toMatchObject({ phase: 'ready' });
  });

  it('fails, and never reads ready, when Circle attested it to another Miden account', async () => {
    const id = await addDeposit(OTHER_ACCOUNT, { sourceChainId: 5042002 });

    await reconcileBridgedReceives();

    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs).toMatchObject({ phase: 'failed' });
    expect(row?.error).toBe('Circle attested this deposit to a different Miden account.');
  });

  it('compares the recipient the deposit signed before the one its account derives', async () => {
    const id = await addDeposit(OTHER_ACCOUNT, { sourceChainId: 5042002, usdcxRemoteRecipient: ATTESTED_RECIPIENT });

    await reconcileBridgedReceives();

    expect(await phaseOf(id)).toMatchObject({ phase: 'ready' });
  });
});

describe('an executor-route USDCx deposit', () => {
  // The row's Arc execute hash is the xReserve deposit Circle attests; here it is the captured deposit, attested to
  // another account than the row's.
  const executorDeposit = (accountId: string) =>
    addDeposit(accountId, { sourceChainId: 84532, cctp: { sourceDomain: 6, executeTxHash: DEPOSIT_HASH } });

  it('never becomes ready on an execute Circle attested to another recipient, and warns once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await executorDeposit(OTHER_ACCOUNT);

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(await phaseOf(id)).toMatchObject({ phase: 'delivering' });
    expect(warn.mock.calls.filter(([message]) => String(message).includes('USDCx execute attestation'))).toHaveLength(
      1
    );
    expect(mockReadOutcome).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('becomes ready on an execute Circle attested to the row', async () => {
    const id = await executorDeposit(ATTESTED_ACCOUNT);

    await reconcileBridgedReceives();

    expect(await phaseOf(id)).toMatchObject({ phase: 'ready' });
  });
});
```

`src/lib/miden/activity/bridge-receive.test.ts:11-17`, current text (unique in the file):

```ts
const fetchDeposits = jest.fn();
const resolveNoteId = jest.fn();
const getIntentStatus = jest.fn();
const isAttested = jest.fn();

// Only the type index is read: a pass that falls back to walking the table has no `filter` to call here.
jest.mock('lib/miden/repo', () => ({
```

becomes:

```ts
const fetchDeposits = jest.fn();
const resolveNoteId = jest.fn();
const getIntentStatus = jest.fn();
const fetchAttestations = jest.fn();
const matchAttestation = jest.fn();

// Only the type index is read: a pass that falls back to walking the table has no `filter` to call here.
jest.mock('lib/miden/repo', () => ({
```

`src/lib/miden/activity/bridge-receive.test.ts:26-32`, current text (unique in the file):

```ts
  }
}));
jest.mock('lib/usdcx/attestation', () => ({
  isUsdcxDepositAttested: (...args: unknown[]) => isAttested(...args)
}));
const fetchAttestedMessage = jest.fn();
jest.mock('lib/usdcx/cctp', () => ({
```

becomes:

```ts
  }
}));
jest.mock('lib/usdcx/attestation', () => ({
  fetchXReserveAttestations: (...args: unknown[]) => fetchAttestations(...args),
  matchUsdcxDepositAttestation: (...args: unknown[]) => matchAttestation(...args)
}));
// The SDK's id parse stands in as a tag of the ref it was given; bridge-receive.usdcx.test.ts runs the real one.
jest.mock('lib/usdcx/deposit-target', () => ({
  usdcxRemoteRecipientFor: (ref: string) => {
    if (ref === 'no-account') throw new Error('not an account id');
    return `recipient-of:${ref}`;
  },
  usdcxExpectedRemoteTokenFor: (ref: string) => `token-of:${ref}`
}));
const fetchAttestedMessage = jest.fn();
jest.mock('lib/usdcx/cctp', () => ({
```

`src/lib/miden/activity/bridge-receive.test.ts:69-75`, current text (unique in the file):

```ts
  jest.clearAllMocks();
  waitForReceipt.mockResolvedValue(undefined);
  updatePhase.mockResolvedValue(undefined);
  isAttested.mockResolvedValue(false);
  readOutcome.mockResolvedValue('pending');
  registerBridgeIn.mockResolvedValue(undefined);
  fetchDeposits.mockResolvedValue([]);
```

becomes:

```ts
  jest.clearAllMocks();
  waitForReceipt.mockResolvedValue(undefined);
  updatePhase.mockResolvedValue(undefined);
  fetchAttestations.mockResolvedValue([]);
  matchAttestation.mockReturnValue({ kind: 'pending' });
  readOutcome.mockResolvedValue('pending');
  registerBridgeIn.mockResolvedValue(undefined);
  fetchDeposits.mockResolvedValue([]);
```

`src/lib/miden/activity/bridge-receive.test.ts:246-252`, current text (unique in the file):

```ts
    expect(updatePhase).toHaveBeenCalledWith('usdcx-interrupted', 'failed', {
      error: 'Bridge submission was interrupted before a transaction hash was recorded.'
    });
    expect(isAttested).not.toHaveBeenCalled();
    expect(fetchAttestedMessage).not.toHaveBeenCalled();
  });

```

becomes:

```ts
    expect(updatePhase).toHaveBeenCalledWith('usdcx-interrupted', 'failed', {
      error: 'Bridge submission was interrupted before a transaction hash was recorded.'
    });
    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(fetchAttestedMessage).not.toHaveBeenCalled();
  });

```

`src/lib/miden/activity/bridge-receive.test.ts:766-823`, current text (unique in the file):

```ts
// SDK with no intent nonce on every tick.
describe('reconcileBridgedReceives with a USDCx row', () => {
  const DEPOSIT_HASH = `0x${'5'.repeat(64)}`;
  const usdcxRow = (extraInputs: Record<string, unknown> = {}) => ({
    id: 'usdcx-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider: 'usdcx', phase: 'delivering', evmTxHash: DEPOSIT_HASH, ...extraInputs }
  });

  it('leaves a delivering USDCx row untouched while Circle has not attested it', async () => {
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    // A legacy row names no source chain, so the attestation module's testnet default applies.
    expect(isAttested).toHaveBeenCalledWith(DEPOSIT_HASH, undefined);
    expect(getIntentStatus).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
    expect(waitForReceipt).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('moves an attested USDCx row to ready', async () => {
    isAttested.mockResolvedValue(true);
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-row', 'ready');
  });

  it('leaves the row for the next pass when the attestation request fails', async () => {
    isAttested.mockRejectedValue(new Error('HTTP 503'));
    rows.push(usdcxRow());

    await expect(reconcileBridgedReceives()).resolves.toBeUndefined();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it("asks the attestation service of the direct row's own source chain", async () => {
    rows.push({
      id: 'usdcx-arc',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'usdcx', phase: 'delivering', sourceChainId: 5042002, evmTxHash: `0x${'4'.repeat(64)}` }
    });

    await reconcileBridgedReceives();

    expect(isAttested).toHaveBeenCalledWith(`0x${'4'.repeat(64)}`, 'https://xreserve-api-testnet.circle.com');
  });

  it('still times out a stale USDCx row', async () => {
```

becomes:

```ts
// SDK with no intent nonce on every tick.
describe('reconcileBridgedReceives with a USDCx row', () => {
  const DEPOSIT_HASH = `0x${'5'.repeat(64)}`;
  const usdcxRow = (extraInputs: Record<string, unknown> = {}, row: Record<string, unknown> = {}) => ({
    id: 'usdcx-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    faucetId: 'usdcx-faucet',
    amount: 5_000_000n,
    initiatedAt: Math.floor(Date.now() / 1000),
    ...row,
    extraInputs: { provider: 'usdcx', phase: 'delivering', evmTxHash: DEPOSIT_HASH, ...extraInputs }
  });
  const derived = {
    remoteRecipient: 'recipient-of:miden-account',
    remoteToken: 'token-of:usdcx-faucet',
    amount: 5_000_000n
  };

  it('leaves a delivering USDCx row untouched while Circle has not attested it', async () => {
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    // A legacy row names no source chain, so the attestation module's testnet default applies.
    expect(fetchAttestations).toHaveBeenCalledWith(DEPOSIT_HASH, { baseUrl: undefined });
    expect(getIntentStatus).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
    expect(waitForReceipt).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('moves a USDCx row to ready once Circle attested what it signed', async () => {
    const list = [{ remoteDomain: 10007 }];
    fetchAttestations.mockResolvedValue(list);
    matchAttestation.mockReturnValue({ kind: 'attested' });
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    // A row written before the signed recipient was kept derives it from its own account.
    expect(matchAttestation).toHaveBeenCalledWith(list, derived);
    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-row', 'ready');
  });

  it('compares the recipient the deposit persisted rather than the one its account derives', async () => {
    const signed = `0x${'0'.repeat(32)}${'ab'.repeat(15)}00`;
    rows.push(usdcxRow({ usdcxRemoteRecipient: signed }));

    await reconcileBridgedReceives();

    expect(matchAttestation).toHaveBeenCalledWith([], { ...derived, remoteRecipient: signed });
  });

  it('derives the recipient when the one the row persisted is not hex', async () => {
    rows.push(usdcxRow({ usdcxRemoteRecipient: 'not-hex' }));

    await reconcileBridgedReceives();

    expect(matchAttestation).toHaveBeenCalledWith([], derived);
  });

  it.each([
    ['remoteDomain', 'Circle attested this deposit to a different network.'],
    ['remoteToken', 'Circle attested this deposit to a different token.'],
    ['recipient', 'Circle attested this deposit to a different Miden account.'],
    ['amount', 'Circle attested this deposit to a different amount.']
  ])('fails a USDCx row whose attestation differs in %s, saying so', async (field, error) => {
    matchAttestation.mockReturnValue({ kind: 'mismatch', field });
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-row', 'failed', { error });
  });

  it('writes nothing for an attestation it cannot read, and warns once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    matchAttestation.mockReturnValue({ kind: 'unreadable' });
    rows.push(usdcxRow({}, { id: 'usdcx-unreadable' }));

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([message]) => String(message).includes('attestation unreadable'))).toHaveLength(1);
    warn.mockRestore();
  });

  it.each([
    ['names no faucet', { faucetId: undefined }],
    ['has no amount', { amount: undefined }],
    ['belongs to no account id', { accountId: 'no-account' }]
  ])('asks Circle nothing for a row that %s', async (_label, row) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(usdcxRow({}, row));

    await reconcileBridgedReceives();

    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('makes no request for a hash that is not a transaction hash', async () => {
    rows.push(usdcxRow({ evmTxHash: 'not-a-hash' }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('leaves the row for the next pass when the attestation request fails', async () => {
    fetchAttestations.mockRejectedValue(new Error('HTTP 503'));
    rows.push(usdcxRow());

    await expect(reconcileBridgedReceives()).resolves.toBeUndefined();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it("asks the attestation service of the direct row's own source chain", async () => {
    rows.push(usdcxRow({ sourceChainId: 5042002, evmTxHash: `0x${'4'.repeat(64)}` }, { id: 'usdcx-arc' }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).toHaveBeenCalledWith(`0x${'4'.repeat(64)}`, {
      baseUrl: 'https://xreserve-api-testnet.circle.com'
    });
  });

  it('still times out a stale USDCx row', async () => {
```

`src/lib/miden/activity/bridge-receive.test.ts:847-864`, current text (unique in the file):

```ts
    id: 'usdcx-executor-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider: 'usdcx', phase: 'delivering', sourceChainId: 84532, evmTxHash: BURN_HASH, cctp }
  });

  it('asks Iris for the burn and keeps the attested message on the row', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd' });
    rows.push(executorRow({ sourceDomain: 6 }));

    await reconcileBridgedReceives();

    expect(fetchAttestedMessage).toHaveBeenCalledWith(6, BURN_HASH, { baseUrl: IRIS });
    expect(isAttested).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }
```

becomes:

```ts
    id: 'usdcx-executor-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    faucetId: 'usdcx-faucet',
    amount: 5_000_000n,
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider: 'usdcx', phase: 'delivering', sourceChainId: 84532, evmTxHash: BURN_HASH, cctp }
  });

  it('asks Iris for the burn and keeps the attested message on the row', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd' });
    rows.push(executorRow({ sourceDomain: 6 }));

    await reconcileBridgedReceives();

    expect(fetchAttestedMessage).toHaveBeenCalledWith(6, BURN_HASH, { baseUrl: IRIS });
    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }
```

`src/lib/miden/activity/bridge-receive.test.ts:880-899`, current text (unique in the file):

```ts
    await reconcileBridgedReceives();

    expect(fetchAttestedMessage).not.toHaveBeenCalled();
    expect(isAttested).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('asks xReserve for the execute transaction and moves the row to ready once attested', async () => {
    isAttested.mockResolvedValue(true);
    rows.push(executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH }));

    await reconcileBridgedReceives();

    expect(isAttested).toHaveBeenCalledWith(EXECUTE_HASH, ATTESTATIONS);
    expect(fetchAttestedMessage).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'ready');
  });

  // The foreground hook sees a revert only while its screen is open: the reconciler reads the saved hash's Arc
```

becomes:

```ts
    await reconcileBridgedReceives();

    expect(fetchAttestedMessage).not.toHaveBeenCalled();
    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('asks xReserve for the execute transaction and moves the row to ready once attested', async () => {
    matchAttestation.mockReturnValue({ kind: 'attested' });
    rows.push(executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).toHaveBeenCalledWith(EXECUTE_HASH, { baseUrl: ATTESTATIONS });
    expect(matchAttestation).toHaveBeenCalledWith([], {
      remoteRecipient: 'recipient-of:miden-account',
      remoteToken: 'token-of:usdcx-faucet',
      amount: 5_000_000n
    });
    expect(fetchAttestedMessage).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'ready');
  });

  // The execute hash can be a forward Iris reported, so an attestation of something else fails nothing.
  it.each([
    ['attested to something else', { kind: 'mismatch', field: 'recipient' }],
    ['unreadable', { kind: 'unreadable' }]
  ])('writes nothing and warns once on an execute %s', async (_label, verdict) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    matchAttestation.mockReturnValue(verdict);
    rows.push({
      ...executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH }),
      id: `usdcx-executor-${verdict.kind}`
    });

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([message]) => String(message).includes('execute attestation'))).toHaveLength(1);
    warn.mockRestore();
  });

  // The foreground hook sees a revert only while its screen is open: the reconciler reads the saved hash's Arc
```

Mutation notes:
- bridge-receive.usdcx.test.ts: mapping `mismatch` to `ready` in `reconcileUsdcxRow` fails 'fails, and never reads ready, when Circle attested it to another Miden account'; treating an executor `mismatch` as attested fails 'never becomes ready on an execute Circle attested to another recipient'; dropping the persisted-recipient preference in `usdcxExpectationOf` fails 'compares the recipient the deposit signed before the one its account derives'.
- bridge-receive.test.ts: removing `warnedUsdcxRows.add(key)` fails both warn-once cases (two warnings); removing the `row.faucetId === undefined || row.amount === undefined` guard fails 'asks Circle nothing for a row that names no faucet' and '... has no amount'; dropping `isHash` in `matchUsdcxDeposit` fails 'makes no request for a hash that is not a transaction hash'.
- bridge-receive.test.ts: comparing a persisted recipient whatever its form (`signed ?? usdcxRemoteRecipientFor(row.accountId)`) fails 'derives the recipient when the one the row persisted is not hex'.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/miden/activity/bridge-receive.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 2 failed, 2 total / Tests:       17 failed, 45 passed, 62 total. bridge-receive.usdcx.test.ts fails exactly the two cases the spec names (today a row for another account, and an executor row attested to another recipient, both read `"phase": "ready"`); bridge-receive.test.ts fails every case that now expects `fetchXReserveAttestations` and the matcher (the old reconciler calls `isUsdcxDepositAttested`, which the new mock no longer provides). Failing:
  - `a direct USDCx deposit › fails, and never reads ready, when Circle attested it to another Miden account`
  - `an executor-route USDCx deposit › never becomes ready on an execute Circle attested to another recipient, and warns once`
  - `reconcileBridgedReceives with a USDCx executor row › asks xReserve for the execute transaction and moves the row to ready once attested`
  - `reconcileBridgedReceives with a USDCx executor row › keeps a saved execute hash whose receipt has not arrived`
  - `reconcileBridgedReceives with a USDCx executor row › reopens the execute when the saved execute hash reverted on Arc`
  - `reconcileBridgedReceives with a USDCx executor row › writes nothing and warns once on an execute attested to something else`
  - `reconcileBridgedReceives with a USDCx executor row › writes nothing and warns once on an execute unreadable`
  - `reconcileBridgedReceives with a USDCx row › asks the attestation service of the direct row's own source chain`
  - `reconcileBridgedReceives with a USDCx row › compares the recipient the deposit persisted rather than the one its account derives`
  - `reconcileBridgedReceives with a USDCx row › derives the recipient when the one the row persisted is not hex`
  - `reconcileBridgedReceives with a USDCx row › fails a USDCx row whose attestation differs in amount, saying so`
  - `reconcileBridgedReceives with a USDCx row › fails a USDCx row whose attestation differs in recipient, saying so`
  - `reconcileBridgedReceives with a USDCx row › fails a USDCx row whose attestation differs in remoteDomain, saying so`
  - `reconcileBridgedReceives with a USDCx row › fails a USDCx row whose attestation differs in remoteToken, saying so`
  - `reconcileBridgedReceives with a USDCx row › leaves a delivering USDCx row untouched while Circle has not attested it`
  - `reconcileBridgedReceives with a USDCx row › moves a USDCx row to ready once Circle attested what it signed`
  - `reconcileBridgedReceives with a USDCx row › writes nothing for an attestation it cannot read, and warns once`

- [ ] **Step 3: Implement the reconcilers**

`src/lib/miden/activity/bridge-receive.ts:1-13`, current text (unique in the file):

```ts
import { isHash } from 'viem';

import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { fetchDeposits, isAgglayerDepositReady } from 'lib/agglayer/status';
import { MIDEN_DESTINATION_CHAIN_ID } from 'lib/epoch/config';
import { readEpochIntentStatus } from 'lib/epoch/intent-status';
import * as Repo from 'lib/miden/repo';
import { isUsdcxDepositAttested } from 'lib/usdcx/attestation';
import { fetchAttestedCctpMessage, isCctpForwardFailed, revertedExecuteLeg } from 'lib/usdcx/cctp';
import { USDCX_SOURCE_CHAINS, UsdcxExecutorSource } from 'lib/usdcx/constant';
import { readEvmReceiptOutcome, waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import { BRIDGE_RECEIVE_MAX_AGE_MS, registerPendingBridgeIn, resolveBridgeInNoteId } from './bridge-in';
```

becomes:

```ts
import { isHash, isHex } from 'viem';

import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { fetchDeposits, isAgglayerDepositReady } from 'lib/agglayer/status';
import { MIDEN_DESTINATION_CHAIN_ID } from 'lib/epoch/config';
import { readEpochIntentStatus } from 'lib/epoch/intent-status';
import * as Repo from 'lib/miden/repo';
import {
  fetchXReserveAttestations,
  matchUsdcxDepositAttestation,
  UsdcxAttestationMatch,
  UsdcxAttestationMismatchField,
  UsdcxDepositExpectation
} from 'lib/usdcx/attestation';
import { fetchAttestedCctpMessage, isCctpForwardFailed, revertedExecuteLeg } from 'lib/usdcx/cctp';
import { USDCX_SOURCE_CHAINS, UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { readEvmReceiptOutcome, waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import { BRIDGE_RECEIVE_MAX_AGE_MS, registerPendingBridgeIn, resolveBridgeInNoteId } from './bridge-in';
```

`src/lib/miden/activity/bridge-receive.ts:113-123`, current text (unique in the file):

```ts
  }
}

/**
 * Circle's attestation proves the deposit, so the row becomes `ready`: Activity shows it as
 * Confirmed and the timeout no longer fails it. A row that has its hash but lost its screen
 * before the source-chain receipt settles the same way. The consume of the minted note then
 * moves the row to `received` (`takeUsdcxBridgeInInfo`).
 */
async function reconcileUsdcxRow(row: ITransaction, inputs: IBridgedReceiveExtraInputs): Promise<void> {
  // Reached only once no flow holds the submission: with no hash, nothing can ever move the row on.
```

becomes:

```ts
  }
}

const USDCX_MISMATCH_ERRORS: Record<UsdcxAttestationMismatchField, string> = {
  remoteDomain: 'Circle attested this deposit to a different network.',
  remoteToken: 'Circle attested this deposit to a different token.',
  recipient: 'Circle attested this deposit to a different Miden account.',
  amount: 'Circle attested this deposit to a different amount.'
};

const warnedUsdcxRows = new Set<string>();

// Once per row and reason: the watcher polls every 8 s and the verdict it reports does not change.
function warnUsdcxRowOnce(rowId: string, reason: string, detail?: unknown): void {
  const key = `${rowId}:${reason}`;
  if (warnedUsdcxRows.has(key)) return;
  warnedUsdcxRows.add(key);
  console.warn(`[bridge-receive] USDCx ${reason}`, rowId, detail);
}

/**
 * What the deposit signed: the recipient its writer persisted, else the one its account derives, as the deposit screen
 * derived it, so a row written before the recipient was kept still settles. Undefined when the row names no faucet or
 * amount, or its account is no account id.
 */
function usdcxExpectationOf(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs
): UsdcxDepositExpectation | undefined {
  if (row.faucetId === undefined || row.amount === undefined) return undefined;
  try {
    const signed = inputs.usdcxRemoteRecipient;
    return {
      remoteRecipient: signed !== undefined && isHex(signed) ? signed : usdcxRemoteRecipientFor(row.accountId),
      remoteToken: usdcxExpectedRemoteTokenFor(row.faucetId),
      amount: row.amount
    };
  } catch (error) {
    warnUsdcxRowOnce(row.id, 'deposit has no readable recipient or token', error);
    return undefined;
  }
}

/** Circle's verdict on the xReserve deposit `txHash` against what the row signed; undefined with nothing to ask. */
async function matchUsdcxDeposit(
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  txHash: string | undefined,
  attestationApi: string | undefined
): Promise<UsdcxAttestationMatch | undefined> {
  if (txHash === undefined || !isHash(txHash)) return undefined;
  const expected = usdcxExpectationOf(row, inputs);
  if (expected === undefined) return undefined;
  return matchUsdcxDepositAttestation(await fetchXReserveAttestations(txHash, { baseUrl: attestationApi }), expected);
}

/**
 * Circle's attestation of what the wallet signed proves the deposit, so the row becomes `ready`: Activity shows it as
 * Confirmed. An attestation of anything else fails the row, naming what differs. A row that has its hash but lost its
 * screen before the source-chain receipt settles the same way. The consume of the minted note then moves the row to
 * `received` (`takeUsdcxBridgeInInfo`).
 */
async function reconcileUsdcxRow(row: ITransaction, inputs: IBridgedReceiveExtraInputs): Promise<void> {
  // Reached only once no flow holds the submission: with no hash, nothing can ever move the row on.
```

`src/lib/miden/activity/bridge-receive.ts:132-139`, current text (unique in the file):

```ts
      return;
    }
    // A legacy Sepolia row has no source chain and reads the testnet service, the attestation default.
    if (await isUsdcxDepositAttested(inputs.evmTxHash, source?.attestationApi)) {
      await updateBridgedReceivePhase(row.id, 'ready');
    }
  } catch (error) {
    console.warn('[bridge-receive] USDCx attestation poll failed', row.id, error);
```

becomes:

```ts
      return;
    }
    // A legacy Sepolia row has no source chain and reads the testnet service, the attestation default.
    const verdict = await matchUsdcxDeposit(row, inputs, inputs.evmTxHash, source?.attestationApi);
    switch (verdict?.kind) {
      case 'attested':
        await updateBridgedReceivePhase(row.id, 'ready');
        return;
      case 'mismatch':
        await updateBridgedReceivePhase(row.id, 'failed', { error: USDCX_MISMATCH_ERRORS[verdict.field] });
        return;
      case 'unreadable':
        warnUsdcxRowOnce(row.id, 'attestation unreadable', inputs.evmTxHash);
        return;
      default:
        return;
    }
  } catch (error) {
    console.warn('[bridge-receive] USDCx attestation poll failed', row.id, error);
```

`src/lib/miden/activity/bridge-receive.ts:158-165`, current text (unique in the file):

```ts
  if (!leg) return;
  const { target } = source;
  if (leg.executeTxHash) {
    if (await isUsdcxDepositAttested(leg.executeTxHash, target.attestationApi)) {
      await updateBridgedReceivePhase(row.id, 'ready');
      return;
    }
    // The foreground hook sees a revert only while its screen is open.
```

becomes:

```ts
  if (!leg) return;
  const { target } = source;
  if (leg.executeTxHash) {
    const verdict = await matchUsdcxDeposit(row, inputs, leg.executeTxHash, target.attestationApi);
    if (verdict?.kind === 'attested') {
      await updateBridgedReceivePhase(row.id, 'ready');
      return;
    }
    // The hash can be a forward Iris reported rather than a transaction this wallet signed: a mismatch only warns.
    if (verdict?.kind === 'mismatch' || verdict?.kind === 'unreadable') {
      warnUsdcxRowOnce(row.id, `execute attestation ${verdict.kind}`, leg.executeTxHash);
      return;
    }
    // The foreground hook sees a revert only while its screen is open.
```

- [ ] **Step 4: Remove `isUsdcxDepositAttested` and its tests**

`src/lib/usdcx/attestation.ts:1-4`, current text (unique in the file):

```ts
import { Hash, Hex, hexToBigInt, hexToNumber, isHash, isHex } from 'viem';

import { USDCX_REMOTE_DOMAIN, XRESERVE_ATTESTATION_API_TESTNET } from './constant';

```

becomes:

```ts
import { Hash, Hex, hexToBigInt, hexToNumber, isHex } from 'viem';

import { USDCX_REMOTE_DOMAIN, XRESERVE_ATTESTATION_API_TESTNET } from './constant';

```

`src/lib/usdcx/attestation.ts:75-93`, current text (unique in the file):

```ts
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether Circle attested the deposit `txHash` for Miden. A value that is not a
 * transaction hash is never attested, and no request is made for it.
 */
export async function isUsdcxDepositAttested(
  txHash: string | undefined,
  baseUrl: string = XRESERVE_ATTESTATION_API_TESTNET
): Promise<boolean> {
  if (txHash === undefined || !isHash(txHash)) return false;
  const attestations = await fetchXReserveAttestations(txHash, { baseUrl });
  return findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN) !== undefined;
}

/** First 4 bytes of a Circle xReserve DepositIntent payload. */
```

becomes:

```ts
  } finally {
    clearTimeout(timer);
  }
}

/** First 4 bytes of a Circle xReserve DepositIntent payload. */
```

`src/lib/usdcx/attestation.test.ts:7-13`, current text (unique in the file):

```ts
  decodeXReserveDepositIntent,
  fetchXReserveAttestations,
  findAttestationForDomain,
  isUsdcxDepositAttested,
  matchUsdcxDepositAttestation,
  UsdcxDepositExpectation,
  XReserveAttestation
```

becomes:

```ts
  decodeXReserveDepositIntent,
  fetchXReserveAttestations,
  findAttestationForDomain,
  matchUsdcxDepositAttestation,
  UsdcxDepositExpectation,
  XReserveAttestation
```

`src/lib/usdcx/attestation.test.ts:86-105`, current text (unique in the file):

```ts
    fetchMock.mockResolvedValue(okResponse({ attestations: [malformed, entry()] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([entry()]);
  });

  it('reports a deposit attested only once Circle signed it for the Miden domain', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [entry({ remoteDomain: 10001 })] }));
    await expect(isUsdcxDepositAttested(TX_HASH)).resolves.toBe(false);

    fetchMock.mockResolvedValue(okResponse({ attestations: [entry({ remoteDomain: USDCX_REMOTE_DOMAIN })] }));
    await expect(isUsdcxDepositAttested(TX_HASH)).resolves.toBe(true);
  });

  it.each([undefined, 'not-a-hash'])('makes no request for %s, which is not a transaction hash', async txHash => {
    await expect(isUsdcxDepositAttested(txHash)).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty list when the body has no attestations array', async () => {
```

becomes:

```ts
    fetchMock.mockResolvedValue(okResponse({ attestations: [malformed, entry()] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([entry()]);
  });

  it('returns an empty list when the body has no attestations array', async () => {
```

- [ ] **Step 5: Run them and watch them pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/usdcx/attestation.test.ts src/lib/usdcx/deposit-target.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 5 passed, 5 total / Tests:       132 passed, 132 total.

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && git grep -n 'isUsdcxDepositAttested' -- src playwright
```

Expected: no output.

- [ ] **Step 6: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts && npx eslint --max-warnings 0 src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && { git diff -U0 -- src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts | grep '^+'; cat src/lib/usdcx/deposit-target.ts src/lib/usdcx/deposit-target.test.ts src/lib/miden/activity/bridge-receive.usdcx.test.ts; } | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 7: Commit (spec commit 1)**

p2-recipient-writers and p2-screen-recipient must have left their six files green first (run their suites: `yarn jest src/lib/usdcx/deposit.test.ts src/lib/usdcx/executor.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx --maxWorkers=2`). Then:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && git add .prettierignore src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/usdcx/deposit-target.ts src/lib/usdcx/deposit-target.test.ts src/lib/usdcx/attestation.ts src/lib/usdcx/attestation.test.ts src/lib/usdcx/attestation.vectors.json src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/usdcx/deposit.ts src/lib/usdcx/deposit.test.ts src/lib/usdcx/executor.ts src/lib/usdcx/executor.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx && git commit -m "fix(usdcx): mark a deposit ready only when Circle's attestation matches what the wallet signed"
git show --stat HEAD
```

Expected: 18 files in the commit, the message exactly as above with no trailer.

---

### Task 8: Time out stale ready deposits and let a late mint still land them (p1-ready-timeout-late-mint)

Spec 10(a2), D7, Q9. A `ready` row is never polled again, and `readUnsettledRows` dropped it, so the 7-day cutoff never failed a USDCx deposit whose mint never came and it read Confirmed forever. Now:
- `readUnsettledRows` keeps a `ready` USDCx row that is not `restoredFromBackup` (a restored one would be failed on read), for the cutoff alone; it is never asked about again.
- A ready row's week runs from `readyAt` (else `initiatedAt`), so a deposit attested late in its week, such as an executor leg executed on day 6, gets its own week.
- `updateBridgedReceivePhase` stamps `readyAt` (Unix seconds, like `initiatedAt`) once: when a row first reaches `ready`, or when a ready row from before the stamp moves on. It is never cleared and survives `failed`.
- `takeUsdcxBridgeInInfo` also takes a `failed` USDCx row that has `readyAt` and error `Bridge delivery timed out.`, at any age, ranked after every live row. A row that timed out from `delivering` (no `readyAt`) or failed for another reason is not taken. `failed -> received` is already allowed (complete.ts:1548).

**Files:**
- Modify: `src/lib/miden/db/types.ts`, `src/lib/miden/transaction/complete.ts`, `src/lib/miden/activity/bridge-in.ts`, `src/lib/miden/activity/bridge-receive.ts`
- Test: `src/lib/miden/activity/bridge-receive.test.ts`, `src/lib/miden/transaction/bridged-receive-phase.test.ts`, `src/lib/miden/activity/bridge-in.test.ts`

**Interfaces:**
- Consumes: `BRIDGE_RECEIVE_MAX_AGE_MS` (bridge-in.ts:178), `takeUsdcxBridgeInInfo` (bridge-in.ts:277-323), `updateBridgedReceivePhase`.
- Produces:
  - `IBridgedReceiveExtraInputs.readyAt?: number` (Unix seconds)
  - `export const BRIDGE_DELIVERY_TIMED_OUT = 'Bridge delivery timed out.'` (bridge-in.ts; the reconciler's timeout error, text unchanged)
  - `takeUsdcxBridgeInInfo(args: { accountId: string; senderAccountId: string; faucetId: string; amount: bigint }): Promise<IBridgeInInfo | undefined>` (signature unchanged; ranking ready 0, delivering/submitting 1, timed-out ready 2)

bridge-receive.test.ts mocks `./bridge-in` key by key, so its mock gains `BRIDGE_DELIVERY_TIMED_OUT` through `jest.requireActual` (otherwise every timeout would write `error: undefined`).

- [ ] **Step 1: Write the failing tests**

`src/lib/miden/activity/bridge-receive.test.ts:70-75`, current text (unique in the file):

```ts
}));
jest.mock('./bridge-in', () => ({
  BRIDGE_RECEIVE_MAX_AGE_MS: jest.requireActual('./bridge-in').BRIDGE_RECEIVE_MAX_AGE_MS,
  registerPendingBridgeIn: (...args: unknown[]) => registerBridgeIn(...args),
  resolveBridgeInNoteId: (...args: unknown[]) => resolveNoteId(...args)
}));
```

becomes:

```ts
}));
jest.mock('./bridge-in', () => ({
  BRIDGE_RECEIVE_MAX_AGE_MS: jest.requireActual('./bridge-in').BRIDGE_RECEIVE_MAX_AGE_MS,
  BRIDGE_DELIVERY_TIMED_OUT: jest.requireActual('./bridge-in').BRIDGE_DELIVERY_TIMED_OUT,
  registerPendingBridgeIn: (...args: unknown[]) => registerBridgeIn(...args),
  resolveBridgeInNoteId: (...args: unknown[]) => resolveNoteId(...args)
}));
```

`src/lib/miden/activity/bridge-receive.test.ts:908-913`, current text (unique in the file):

```ts
    });
  });

  it('still times out a stale USDCx row', async () => {
    rows.push({
      id: 'usdcx-old',
```

becomes:

```ts
    });
  });

  // A `ready` row is never polled again, so only the cutoff can end one whose mint never came.
  it('times out a USDCx row that has been ready for longer than the tracking age', async () => {
    rows.push(
      usdcxRow({ phase: 'ready', readyAt: WEEK_AGO_SEC }, { id: 'usdcx-stale-ready', initiatedAt: WEEK_AGO_SEC })
    );

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-stale-ready', 'failed', { error: 'Bridge delivery timed out.' });
  });

  it('times out a ready USDCx row from before readyAt by its age', async () => {
    rows.push(usdcxRow({ phase: 'ready' }, { id: 'usdcx-legacy-ready', initiatedAt: WEEK_AGO_SEC }));

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-legacy-ready', 'failed', { error: 'Bridge delivery timed out.' });
  });

  it('never asks Circle again about a fresh ready USDCx row, nor writes it', async () => {
    rows.push(usdcxRow({ phase: 'ready', readyAt: Math.floor(Date.now() / 1000) }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  // The cutoff runs from when the row was attested: a deposit attested late in its week still gets its own week.
  it('keeps a USDCx row that became ready recently, however old its deposit', async () => {
    rows.push(usdcxRow({ phase: 'ready', readyAt: Math.floor(Date.now() / 1000) }, { initiatedAt: WEEK_AGO_SEC }));

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it.each([
    ['an AggLayer row', { provider: 'agglayer' }, {}],
    ['a USDCx row restored from a backup', {}, { restoredFromBackup: true }]
  ])('leaves %s that is ready alone', async (_label, extraInputs, row) => {
    rows.push(usdcxRow({ phase: 'ready', ...extraInputs }, { initiatedAt: WEEK_AGO_SEC, ...row }));

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
  });

  it('still times out a stale USDCx row', async () => {
    rows.push({
      id: 'usdcx-old',
```

`src/lib/miden/transaction/bridged-receive-phase.test.ts:81-86`, current text (unique in the file):

```ts
  });
});

// The executor route writes its CCTP leg a field at a time, and a reopen after a reverted Arc execute clears the
// hash it saw revert. Run against the real writer: every consumer suite mocks it.
describe('updateBridgedReceivePhase on a USDCx CCTP leg', () => {
```

becomes:

```ts
  });
});

// A row that times out keeps saying it was once attested, which is what lets a late mint still land it.
describe('updateBridgedReceivePhase readyAt', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
  });
  afterEach(() => nowSpy.mockRestore());

  it('stamps the first ready write in seconds and never moves it', async () => {
    const id = await seed('delivering');

    await updateBridgedReceivePhase(id, 'ready');
    nowSpy.mockReturnValue(2_000_000_000);
    await updateBridgedReceivePhase(id, 'ready');
    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'failed', readyAt: 1_000_000 });
  });

  it('stamps a ready row from before the stamp when it moves on', async () => {
    const id = await seed('ready');

    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });

    expect((await Repo.transactions.get(id))?.extraInputs).toMatchObject({ phase: 'failed', readyAt: 1_000_000 });
  });

  it('never stamps a row that was not ready', async () => {
    const id = await seed('delivering');

    await updateBridgedReceivePhase(id, 'failed', { error: 'Bridge delivery timed out.' });
    await updateBridgedReceivePhase(id, 'ready');

    expect((await Repo.transactions.get(id))?.extraInputs.readyAt).toBeUndefined();
  });
});

// The executor route writes its CCTP leg a field at a time, and a reopen after a reverted Arc execute clears the
// hash it saw revert. Run against the real writer: every consumer suite mocks it.
describe('updateBridgedReceivePhase on a USDCx CCTP leg', () => {
```

`src/lib/miden/activity/bridge-in.test.ts:633-638`, current text (unique in the file):

```ts
    await expect(takeUsdcxBridgeInInfo({ ...mint, ...overrides, amount: 5_000_000n })).resolves.toBeUndefined();
  });

  it.each([
    ['was never broadcast', tracker({}, { evmTxHash: undefined, phase: 'submitting' })],
    ['already received its note', tracker({}, { phase: 'received' })],
```

becomes:

```ts
    await expect(takeUsdcxBridgeInInfo({ ...mint, ...overrides, amount: 5_000_000n })).resolves.toBeUndefined();
  });

  // A mint that arrives after its ready row timed out still lands it, after any live deposit of the same amount.
  describe('a deposit that timed out after Circle attested it', () => {
    const timedOut = (overrides: Record<string, unknown> = {}, extraInputs: Record<string, unknown> = {}) =>
      tracker(
        { initiatedAt: -9 * 24 * 60 * 60, ...overrides },
        { phase: 'failed', readyAt: -8 * 24 * 60 * 60, error: 'Bridge delivery timed out.', ...extraInputs }
      );

    it('takes the late mint, past the delivery window', async () => {
      mockTransactions.push(timedOut({ id: 'timed-out' }));

      await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
        bridgeReceiveTxId: 'timed-out'
      });
    });

    it('yields to a live deposit of the same amount, even one still delivering', async () => {
      mockTransactions.push(
        timedOut({ id: 'timed-out' }),
        tracker({ id: 'live', initiatedAt: 5 }, { phase: 'delivering' })
      );

      await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
        bridgeReceiveTxId: 'live'
      });
    });

    it.each([
      ['timed out before Circle attested it', timedOut({}, { readyAt: undefined })],
      ['failed for another reason', timedOut({}, { error: 'Circle attested this deposit to a different amount.' })],
      ['was restored from a backup', timedOut({ restoredFromBackup: true })]
    ])('leaves a failed deposit that %s', async (_label, row) => {
      mockTransactions.push(row);

      await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toBeUndefined();
    });
  });

  it.each([
    ['was never broadcast', tracker({}, { evmTxHash: undefined, phase: 'submitting' })],
    ['already received its note', tracker({}, { phase: 'received' })],
```

Mutation notes:
- Returning `false` for every `ready` row in `readUnsettledRows` fails 'times out a USDCx row that has been ready for longer than the tracking age' and '... from before readyAt by its age'; measuring from `row.initiatedAt` alone fails 'keeps a USDCx row that became ready recently, however old its deposit'.
- Dropping `|| fromPhase === 'ready'` from the stamp fails 'stamps a ready row from before the stamp when it moves on'; dropping `inputs?.readyAt ??` fails 'stamps the first ready write in seconds and never moves it' (reads 2000000).
- Removing `isAttestedTimeout` from the filter fails 'takes the late mint, past the delivery window'; ranking a failed row 1 fails 'yields to a live deposit of the same amount' (the older timed-out row wins); dropping `inputs.readyAt !== undefined` fails 'leaves a failed deposit that timed out before Circle attested it'.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-in.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 3 failed, 3 total / Tests:       5 failed, 120 passed, 125 total:
  - `reconcileBridgedReceives with a USDCx row › times out a USDCx row that has been ready for longer than the tracking age`
  - `reconcileBridgedReceives with a USDCx row › times out a ready USDCx row from before readyAt by its age`
  - `takeUsdcxBridgeInInfo › a deposit that timed out after Circle attested it › takes the late mint, past the delivery window`
  - `updateBridgedReceivePhase readyAt › stamps a ready row from before the stamp when it moves on`
  - `updateBridgedReceivePhase readyAt › stamps the first ready write in seconds and never moves it`

- [ ] **Step 3: Implement**

`src/lib/miden/db/types.ts:189-194`, current text (unique in the file):

```ts
   * first phase write. Absent on rows written before this field and on E2E hook rows.
   */
  usdcxRemoteRecipient?: string;
}

/** Audit metadata for a Guardian operator switch. `previousGuardianEndpoint`
```

becomes:

```ts
   * first phase write. Absent on rows written before this field and on E2E hook rows.
   */
  usdcxRemoteRecipient?: string;
  /** Unix seconds at which the row first reached `ready`. Written once, never cleared, and kept through `failed`. */
  readyAt?: number;
}

/** Audit metadata for a Guardian operator switch. `previousGuardianEndpoint`
```

`src/lib/miden/transaction/complete.ts:1594-1600`, current text (unique in the file):

```ts
    ) {
      settled = tx;
    }
    tx.extraInputs = { ...inputs, phase, ...(extra ?? {}), ...(cctp ? { cctp } : {}) };
    if (received) {
      tx.amount = received.amount;
      tx.faucetId = received.faucetId;
```

becomes:

```ts
    ) {
      settled = tx;
    }
    // Once, so a row that later times out still says Circle attested it: only such a row takes a late mint. A row that
    // was ready before the stamp existed takes it as it moves on.
    const readyAt =
      inputs?.readyAt ?? (phase === 'ready' || fromPhase === 'ready' ? Math.floor(Date.now() / 1000) : undefined);
    tx.extraInputs = {
      ...inputs,
      phase,
      ...(extra ?? {}),
      ...(cctp ? { cctp } : {}),
      ...(readyAt === undefined ? {} : { readyAt })
    };
    if (received) {
      tx.amount = received.amount;
      tx.faucetId = received.faucetId;
```

`src/lib/miden/activity/bridge-in.ts:177-182`, current text (unique in the file):

```ts
 */
export const BRIDGE_RECEIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** What the bridge delivers for a deposit tracked in wei: floored at the native-ETH faucet's registry scale (#1326). */
export function agglayerDeliveredAmount(trackedWei: bigint, scale: number): bigint {
  return trackedWei / 10n ** BigInt(scale);
```

becomes:

```ts
 */
export const BRIDGE_RECEIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The error the reconciler fails a tracker with once it outlived `BRIDGE_RECEIVE_MAX_AGE_MS`. */
export const BRIDGE_DELIVERY_TIMED_OUT = 'Bridge delivery timed out.';

/** What the bridge delivers for a deposit tracked in wei: floored at the native-ETH faucet's registry scale (#1326). */
export function agglayerDeliveredAmount(trackedWei: bigint, scale: number): bigint {
  return trackedWei / 10n ** BigInt(scale);
```

`src/lib/miden/activity/bridge-in.ts:267-278`, current text (unique in the file):

```ts
  };
}

/**
 * Match a note the USDCx faucet minted to the oldest compatible xReserve tracking row.
 * The faucet is the chain's native asset and also sends ordinary faucet requests, so the
 * sender alone proves nothing. The row must be a broadcast deposit (it has its EVM hash)
 * of the same account and the same amount, which xReserve mints 1:1. The rows are read
 * first, so a consume with no open USDCx deposit never waits for the native asset id.
 */
export async function takeUsdcxBridgeInInfo(args: {
  accountId: string;
```

becomes:

```ts
  };
}

/** A tracker the reconciler timed out after Circle attested its deposit, so its mint can still come. */
function isAttestedTimeout(inputs: IBridgedReceiveExtraInputs): boolean {
  return inputs.phase === 'failed' && inputs.readyAt !== undefined && inputs.error === BRIDGE_DELIVERY_TIMED_OUT;
}

/**
 * Match a note the USDCx faucet minted to the oldest compatible xReserve tracking row.
 * The faucet is the chain's native asset and also sends ordinary faucet requests, so the
 * sender alone proves nothing. The row must be a broadcast deposit (it has its EVM hash)
 * of the same account and the same amount, which xReserve mints 1:1. The rows are read
 * first, so a consume with no open USDCx deposit never waits for the native asset id.
 * A row that timed out after Circle attested it still takes a late mint, at any age, but
 * only after every open row: its deposit was proven, so its mint can still come.
 */
export async function takeUsdcxBridgeInInfo(args: {
  accountId: string;
```

`src/lib/miden/activity/bridge-in.ts:289-309`, current text (unique in the file):

```ts
      // A restored tracker must not adopt a genuine incoming note, as for an AggLayer delivery.
      if (tx.restoredFromBackup) return false;
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      return (
        inputs?.provider === 'usdcx' &&
        inputs.evmTxHash !== undefined &&
        inputs.phase !== 'received' &&
        inputs.phase !== 'failed' &&
        tx.initiatedAt >= cutoffSec &&
        tx.amount === args.amount
      );
    })
    .toArray();
  // The mint follows Circle's attestation of the deposit, so a row whose deposit is attested (`ready`) is the
  // one this note belongs to; a row still `delivering` is a fallback for a mint the watcher has not caught up
  // with. Among equals the oldest wins. Age alone paired a note with an older deposit that was never executed
  // and left the attested one at "Pending".
  const rank = (tx: ITransaction): number => (tx.extraInputs?.phase === 'ready' ? 0 : 1);
  matches.sort((a, b) => rank(a) - rank(b) || a.initiatedAt - b.initiatedAt);
  const match = matches[0];
  if (!match) return undefined;
```

becomes:

```ts
      // A restored tracker must not adopt a genuine incoming note, as for an AggLayer delivery.
      if (tx.restoredFromBackup) return false;
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      if (inputs?.provider !== 'usdcx' || inputs.evmTxHash === undefined || tx.amount !== args.amount) return false;
      if (isAttestedTimeout(inputs)) return true;
      return inputs.phase !== 'received' && inputs.phase !== 'failed' && tx.initiatedAt >= cutoffSec;
    })
    .toArray();
  // The mint follows Circle's attestation of the deposit, so a row whose deposit is attested (`ready`) is the
  // one this note belongs to; a row still `delivering` is a fallback for a mint the watcher has not caught up
  // with. Among equals the oldest wins. Age alone paired a note with an older deposit that was never executed
  // and left the attested one at "Pending".
  const rank = (tx: ITransaction): number => {
    if (tx.extraInputs?.phase === 'ready') return 0;
    return tx.extraInputs?.phase === 'failed' ? 2 : 1;
  };
  matches.sort((a, b) => rank(a) - rank(b) || a.initiatedAt - b.initiatedAt);
  const match = matches[0];
  if (!match) return undefined;
```

`src/lib/miden/activity/bridge-receive.ts:17-23`, current text (unique in the file):

```ts
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { readEvmReceiptOutcome, waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import { BRIDGE_RECEIVE_MAX_AGE_MS, registerPendingBridgeIn, resolveBridgeInNoteId } from './bridge-in';
import { IBridgedReceiveExtraInputs, ITransaction } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

```

becomes:

```ts
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { readEvmReceiptOutcome, waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import {
  BRIDGE_DELIVERY_TIMED_OUT,
  BRIDGE_RECEIVE_MAX_AGE_MS,
  registerPendingBridgeIn,
  resolveBridgeInNoteId
} from './bridge-in';
import { IBridgedReceiveExtraInputs, ITransaction } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

```

`src/lib/miden/activity/bridge-receive.ts:303-312`, current text (unique in the file):

```ts
    await updateBridgedReceivePhase(row.id, 'failed', { error: RESTORED_BRIDGE_UNVERIFIABLE });
    return;
  }
  if (row.initiatedAt < cutoffSec) {
    await updateBridgedReceivePhase(row.id, 'failed', { error: 'Bridge delivery timed out.' });
    return;
  }
  if (inputs.phase === 'submitting' && !resumeOrphans) return;

  switch (inputs.provider) {
```

becomes:

```ts
    await updateBridgedReceivePhase(row.id, 'failed', { error: RESTORED_BRIDGE_UNVERIFIABLE });
    return;
  }
  // A ready row's week runs from its attestation, so a deposit attested late in its first week gets its own.
  const since = inputs.phase === 'ready' ? (inputs.readyAt ?? row.initiatedAt) : row.initiatedAt;
  if (since < cutoffSec) {
    await updateBridgedReceivePhase(row.id, 'failed', { error: BRIDGE_DELIVERY_TIMED_OUT });
    return;
  }
  // Circle already attested a ready row; only its mint's consume moves it on.
  if (inputs.phase === 'ready') return;
  if (inputs.phase === 'submitting' && !resumeOrphans) return;

  switch (inputs.provider) {
```

`src/lib/miden/activity/bridge-receive.ts:332-340`, current text (unique in the file):

```ts
      // written row without `extraInputs` would silently disable reconciliation
      // for every genuine row, on every tick.
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      return (
        inputs !== undefined && inputs.phase !== 'ready' && inputs.phase !== 'received' && inputs.phase !== 'failed'
      );
    })
    .toArray();
}
```

becomes:

```ts
      // written row without `extraInputs` would silently disable reconciliation
      // for every genuine row, on every tick.
      const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
      if (inputs === undefined || inputs.phase === 'received' || inputs.phase === 'failed') return false;
      // A ready USDCx row stays for the cutoff alone: no consume tagged it, so it could otherwise read Confirmed
      // forever. A restored one is left out, since reading it would fail it.
      if (inputs.phase === 'ready') return inputs.provider === 'usdcx' && tx.restoredFromBackup !== true;
      return true;
    })
    .toArray();
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-in.test.ts src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/miden/transaction/complete.bridge-in.test.ts --maxWorkers=2
```

Expected: PASS, every suite green (Test Suites: 3 passed, 3 total / Tests:       125 passed, 125 total for the three changed suites).

- [ ] **Step 5: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/activity/bridge-in.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-in.test.ts && npx eslint --max-warnings 0 src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/activity/bridge-in.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-in.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/activity/bridge-in.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-in.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 6: Commit (spec commit 2)**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && git add src/lib/miden/db/types.ts src/lib/miden/transaction/complete.ts src/lib/miden/activity/bridge-in.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-in.test.ts && git commit -m "fix(usdcx): time out stale ready deposits and let a late mint still land them"
```

---

### Task 9: Let an unknown-outcome burn await the node's verdict (p1-burn-verdict)

Spec 10(e) gap 1. `canAwaitVerdict` admitted a bridged-send only on the Agglayer route (verdict-rules.ts:40-48), so an unknown-outcome Guardian USDCx burn lost its candidate (transaction/index.ts:3873-3876) and was failed (cancel.ts:403-405), and the burn poll never promotes a Failed row (burn-status.ts:54-65). Admitting `provider === 'usdcx'` sends it down the verdict path: Unconfirmed (status 4) on an unknown outcome, its candidate kept, and a reconciler landing (`writeLanding`) completes it with `extraInputs.usdcxBurn` intact, `displayMessage` `Bridged to EVM` and no `feeAmount`, `resultBytes` or `resultReleasedAt`; the burn poll then advances it. Nothing awaits a USDCx burn's row (`isResultAwaitingRow` is Epoch-only, index.ts:294-298) and Retry already requeues it (retry.ts:82-85 refuses only Epoch).

Two existing suites outside this partition pin the old exclusion and flip with it; they are updated in Step 4 and staged in commit 3 (ratified at assembly: commit 3 is red without them):
- `src/lib/miden/transaction/transactions.guardian-offscreen.test.ts:2736-2746`: a killed USDCx burn now keeps its candidate like the Agglayer case (`abandons: []`, `KEPT_AT_7`). This is the spec's "keeps its candidate" check.
- `src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts:280-284`: a USDCx bridged-send now carries the stage stamp like the Agglayer one.

**Files:**
- Modify: `src/lib/miden/transaction/verdict-rules.ts`
- Test: `src/lib/miden/transaction/verdict-rules.test.ts`, `src/lib/miden/transaction/cancel.unconfirmed.test.ts`, `src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts`, `src/lib/usdcx/burn-status.test.ts`, `src/lib/miden/transaction/transactions.guardian-offscreen.test.ts`, `src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts`

**Interfaces:**
- Consumes: `cancelTransactionAfterPipelineStopped` (cancel.ts:400), `judgeAndWrite` (reconcile-unconfirmed.ts:189), `pollUsdcxBurn` (burn-status.ts:48).
- Produces: `canAwaitVerdict(tx: Pick<ITransaction, 'type' | 'extraInputs' | 'restoredFromBackup' | 'rotationFunding'>): boolean` now true for `{ type: 'bridged-send', extraInputs: { provider: 'usdcx' } }` (signature unchanged).

- [ ] **Step 1: Write the failing tests**

`src/lib/miden/transaction/verdict-rules.test.ts:67-72`, current text (unique in the file):

```ts
    ['swap', { type: 'swap' }, true],
    ['execute', { type: 'execute' }, true],
    ['Agglayer bridged-send', { type: 'bridged-send', extraInputs: { provider: 'agglayer' } }, true],
    ['Epoch bridged-send', { type: 'bridged-send', extraInputs: { provider: 'epoch' } }, false],
    ['bridged-send with no provider', { type: 'bridged-send' }, false],
    ['earn-deposit', { type: 'earn-deposit' }, false],
```

becomes:

```ts
    ['swap', { type: 'swap' }, true],
    ['execute', { type: 'execute' }, true],
    ['Agglayer bridged-send', { type: 'bridged-send', extraInputs: { provider: 'agglayer' } }, true],
    ['USDCx bridged-send', { type: 'bridged-send', extraInputs: { provider: 'usdcx' } }, true],
    ['Epoch bridged-send', { type: 'bridged-send', extraInputs: { provider: 'epoch' } }, false],
    ['bridged-send with no provider', { type: 'bridged-send' }, false],
    ['earn-deposit', { type: 'earn-deposit' }, false],
```

`src/lib/miden/transaction/cancel.unconfirmed.test.ts:61-66`, current text (unique in the file):

```ts
    expect(notices().notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
    expect(notices().notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
    expect(report()).toHaveBeenCalledWith(expect.objectContaining({ result: 'errored' }));
  });

  it('marks an execute row`s entry with its origin', async () => {
```

becomes:

```ts
    expect(notices().notifyBackgroundTransactionNotConfirmed).toHaveBeenCalledTimes(1);
    expect(notices().notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
    expect(report()).toHaveBeenCalledWith(expect.objectContaining({ result: 'errored' }));
  });

  // The burn note lands on its own once submitted, so failing the row would hide a burn the faucet still consumes.
  it('a USDCx burn waits for the verdict with its burn identity kept', async () => {
    const usdcxBurn = { noteId: 'burn-note', destinationDomain: 26, phase: 'pending' };
    const burn = generating({ type: 'bridged-send', extraInputs: { provider: 'usdcx', usdcxBurn } });
    await Repo.transactions.put(burn);
    await cancelTransactionAfterPipelineStopped(burn, indefinite());
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.extraInputs).toEqual({ provider: 'usdcx', usdcxBurn });
    expect(notices().notifyBackgroundTransactionFailed).not.toHaveBeenCalled();
  });

  it('marks an execute row`s entry with its origin', async () => {
```

`src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts:108-113`, current text (unique in the file):

```ts
    expect(row?.error).toBeUndefined();
    const { reportOperation } = jest.requireMock('lib/telemetry/report-operation');
    expect(reportOperation).toHaveBeenCalledWith({ operation: expect.any(String), result: 'completed' });
  });

  it.each<[ITransaction['type'], ITransaction['displayIcon']]>([
```

becomes:

```ts
    expect(row?.error).toBeUndefined();
    const { reportOperation } = jest.requireMock('lib/telemetry/report-operation');
    expect(reportOperation).toHaveBeenCalledWith({ operation: expect.any(String), result: 'completed' });
  });

  // The landed write has no result to read a fee or outputs from: the burn keeps the identity its poll reads, and
  // nothing else is invented for it.
  it('completes a USDCx burn that landed with its burn identity intact and no fee or outputs', async () => {
    const usdcxBurn = { noteId: NOTE, destinationDomain: 26, phase: 'pending' };
    const extraInputs = { provider: 'usdcx', destinationAddress: '0xkey', destinationNetwork: 5042002, usdcxBurn };
    await Repo.transactions.put(unconfirmed({ type: 'bridged-send', displayIcon: 'SEND', extraInputs }));

    const outcome = await judgeAndWrite(
      'tx-1',
      context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } }))
    );

    expect(outcome.kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      displayMessage: 'Bridged to EVM',
      transactionId: hex(2),
      extraInputs
    });
    expect(row?.feeAmount).toBeUndefined();
    expect(row?.resultBytes).toBeUndefined();
    expect(row?.resultReleasedAt).toBeUndefined();
  });

  it.each<[ITransaction['type'], ITransaction['displayIcon']]>([
```

`src/lib/usdcx/burn-status.test.ts:116-121`, current text (unique in the file):

```ts
  expect(stored.extraInputs.usdcxBurn.phase).toBe(terminal);
});

it('does not poll restored, unsubmitted, or terminal rows', async () => {
  const read = jest.fn(async () => ({ status: 'Pending', attemptCount: 0 }));
  await pollUsdcxBurn({ ...stored, restoredFromBackup: true }, read);
```

becomes:

```ts
  expect(stored.extraInputs.usdcxBurn.phase).toBe(terminal);
});

// The unconfirmed reconciler completes a burn with no result bytes or fee; its burn identity is all the poll reads.
it('advances a burn the unconfirmed reconciler landed', async () => {
  stored = {
    ...row(),
    displayMessage: 'Bridged to EVM',
    submitEvidence: [{ attemptId: 'a1', capturedAt: 1, source: 'stage' }]
  };
  await pollUsdcxBurn(stored, async () => ({ status: 'NullifierCommitted', attemptCount: 1 }));
  expect(stored.extraInputs.usdcxBurn.phase).toBe('confirmed');
});

it('does not poll restored, unsubmitted, or terminal rows', async () => {
  const read = jest.fn(async () => ({ status: 'Pending', attemptCount: 0 }));
  await pollUsdcxBurn({ ...stored, restoredFromBackup: true }, read);
```

Mutation notes:
- Reverting verdict-rules.ts to `return extra?.provider === 'agglayer';` fails the `USDCx bridged-send` row (false), 'a USDCx burn waits for the verdict with its burn identity kept' (status 3) and 'completes a USDCx burn that landed ...' (`skipped`).
- 'advances a burn the unconfirmed reconciler landed' is a pinning test, not failing-first: it passes before the fix and pins the landed shape: adding `|| tx.resultBytes === undefined` to the guard at burn-status.ts:54-63 fails it.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction/verdict-rules.test.ts src/lib/miden/transaction/cancel.unconfirmed.test.ts src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts src/lib/usdcx/burn-status.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 3 failed, 1 passed, 4 total / Tests:       3 failed, 91 passed, 94 total:
  - `canAwaitVerdict › USDCx bridged-send {"type":"bridged-send","extraInputs":{"provider":"usdcx"}} -> true`
  - `entering Unconfirmed (#1081) › a USDCx burn waits for the verdict with its burn identity kept`
  - `the landed write (#1081) › completes a USDCx burn that landed with its burn identity intact and no fee or outputs`
(`Expected: true / Received: false`, `Expected: 4 / Received: 3`, `Expected: "landed" / Received: "skipped"`.)

- [ ] **Step 3: Implement**

`src/lib/miden/transaction/verdict-rules.ts:11-17`, current text (unique in the file):

```ts
  SubmitEvidenceSource
} from '../db/types';

/** Retry's types (`REQUEUEABLE_TYPES` in retry.ts); a bridged-send only on the Agglayer route. */
const VERDICT_TYPES: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'send',
  'consume',
```

becomes:

```ts
  SubmitEvidenceSource
} from '../db/types';

/** Retry's types (`REQUEUEABLE_TYPES` in retry.ts); a bridged-send only on the Agglayer and USDCx routes. */
const VERDICT_TYPES: ReadonlySet<ITransactionType> = new Set<ITransactionType>([
  'send',
  'consume',
```

`src/lib/miden/transaction/verdict-rules.ts:44-50`, current text (unique in the file):

```ts
  if (tx.restoredFromBackup === true || tx.rotationFunding === true) return false;
  if (tx.type !== 'bridged-send') return true;
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  return extra?.provider === 'agglayer';
};

export type ProvableEvidence = ISubmitEvidence &
```

becomes:

```ts
  if (tx.restoredFromBackup === true || tx.rotationFunding === true) return false;
  if (tx.type !== 'bridged-send') return true;
  const extra: IBridgedSendExtraInputs | undefined = tx.extraInputs;
  // Nothing awaits an Agglayer or USDCx burn's row, and its note lands on its own once submitted.
  return extra?.provider === 'agglayer' || extra?.provider === 'usdcx';
};

export type ProvableEvidence = ISubmitEvidence &
```

Run the two suites that pin the old exclusion:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction/transactions.guardian-offscreen.test.ts src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts --maxWorkers=2
```

Expected: FAIL, exactly these two cases (named by their last title segment):
  - transactions.guardian-offscreen.test.ts: `bridged-send: an OperationAbortedError marks the row Failed, does NOT requeue, and dispatches exactly ONCE (no double-send)` (the usdcx row of `bridgeEarnKillCases`: `abandonCandidate` was not called and the evidence holds `candidateKept`)
  - transactions.bridged-earn-offscreen.test.ts: `usdcx pre-built bridged-send delegates the exact request bytes to the proxy` (the stamp is now a function)

- [ ] **Step 4: Update the two suites that pinned the exclusion**

`src/lib/miden/transaction/transactions.guardian-offscreen.test.ts:2733-2748`, current text (unique in the file):

```ts
  );
});

// An Agglayer bridged-send can await the node's verdict, so its killed attempt keeps the candidate (#1081); a USDCx
// burn and an earn deposit cannot, so they still abandon at once.
type KillCase = Case & { abandons: number[][]; evidence: unknown };
const bridgeEarnKillCases = (): KillCase[] => [
  { ...bridgeEarnCase('agglayer'), abandons: [], evidence: KEPT_AT_7 },
  {
    ...bridgeEarnCase('usdcx'),
    abandons: [[7]],
    evidence: expect.not.arrayContaining([expect.objectContaining({ candidateKept: true })])
  },
  {
    ...bridgeEarnCase('earn-deposit'),
    abandons: [[7]],
```

becomes:

```ts
  );
});

// An Agglayer bridged-send and a USDCx burn can await the node's verdict, so a killed attempt keeps the candidate
// (#1081); an earn deposit cannot, so it still abandons at once.
type KillCase = Case & { abandons: number[][]; evidence: unknown };
const bridgeEarnKillCases = (): KillCase[] => [
  { ...bridgeEarnCase('agglayer'), abandons: [], evidence: KEPT_AT_7 },
  { ...bridgeEarnCase('usdcx'), abandons: [], evidence: KEPT_AT_7 },
  {
    ...bridgeEarnCase('earn-deposit'),
    abandons: [[7]],
```

`src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts:277-287`, current text (unique in the file):

```ts
      });

      expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
      // Only an Agglayer bridge awaits the node's verdict, so only it carries a stage stamp (#1081).
      const stampType = provider === 'agglayer' ? 'function' : 'undefined';
      const [account, bytes, delegate, callback, stamp] = mockProxyNewTransaction.mock.calls[0] ?? [];
      expect([account, bytes, delegate, callback]).toEqual(['acc-1', requestBytes, true, signCallback]);
      expect(typeof stamp).toBe(stampType);
      expect(mockProxySendTransaction).not.toHaveBeenCalled();
      expect(mockGetMidenClient).not.toHaveBeenCalled();
      expect(mockInlineNewTransaction).not.toHaveBeenCalled();
```

becomes:

```ts
      });

      expect(mockProxyNewTransaction).toHaveBeenCalledTimes(1);
      // Both bridges await the node's verdict, so both carry a stage stamp (#1081).
      const [account, bytes, delegate, callback, stamp] = mockProxyNewTransaction.mock.calls[0] ?? [];
      expect([account, bytes, delegate, callback]).toEqual(['acc-1', requestBytes, true, signCallback]);
      expect(typeof stamp).toBe('function');
      expect(mockProxySendTransaction).not.toHaveBeenCalled();
      expect(mockGetMidenClient).not.toHaveBeenCalled();
      expect(mockInlineNewTransaction).not.toHaveBeenCalled();
```

- [ ] **Step 5: Run them and watch them pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction/verdict-rules.test.ts src/lib/miden/transaction/cancel.unconfirmed.test.ts src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts src/lib/usdcx/burn-status.test.ts src/lib/miden/transaction/transactions.guardian-offscreen.test.ts src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 6 passed, 6 total / Tests:       262 passed, 262 total. Then the whole transaction directory, since `canAwaitVerdict` gates stamps, candidates and labels across it:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction src/lib/usdcx --maxWorkers=2
```

Expected: PASS, no failed suite.

- [ ] **Step 6: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/transaction/verdict-rules.ts src/lib/miden/transaction/verdict-rules.test.ts src/lib/miden/transaction/cancel.unconfirmed.test.ts src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts src/lib/usdcx/burn-status.test.ts src/lib/miden/transaction/transactions.guardian-offscreen.test.ts src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts && npx eslint --max-warnings 0 src/lib/miden/transaction/verdict-rules.ts src/lib/miden/transaction/verdict-rules.test.ts src/lib/miden/transaction/cancel.unconfirmed.test.ts src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts src/lib/usdcx/burn-status.test.ts src/lib/miden/transaction/transactions.guardian-offscreen.test.ts src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- src/lib/miden/transaction/verdict-rules.ts src/lib/miden/transaction/verdict-rules.test.ts src/lib/miden/transaction/cancel.unconfirmed.test.ts src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts src/lib/usdcx/burn-status.test.ts src/lib/miden/transaction/transactions.guardian-offscreen.test.ts src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 7: Commit (spec commit 3)**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && git add src/lib/miden/transaction/verdict-rules.ts src/lib/miden/transaction/verdict-rules.test.ts src/lib/miden/transaction/cancel.unconfirmed.test.ts src/lib/miden/transaction/reconcile-unconfirmed.writes.test.ts src/lib/usdcx/burn-status.test.ts src/lib/miden/transaction/transactions.guardian-offscreen.test.ts src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts && git commit -m "fix(usdcx): let an unknown-outcome burn await the node's verdict"
```

---

### Task 10: Keep each claimed note's facts on a consume row (p1-consumed-notes)

Spec 10(e) gap 2 inputs. A consume row kept only its first note's sender and faucet and per-faucet totals (types.ts:1100-1124), so a consume completed without a `TransactionResult` had nothing to pair a batch's deliveries by. `ConsumeTransaction` now persists `consumedNotes`, one entry per queued `ConsumableNote` (miden/types.ts:27-50), as an optional unindexed field: no Dexie version bump, and the backup export already walks nested BigInts (repo.ts:311-321).

**Files:**
- Modify: `src/lib/miden/db/types.ts`
- Test: `src/lib/miden/db/types.test.ts`

**Interfaces:**
- Consumes: `ConsumableNote` (`id`, `faucetId`, `amount: string` with `''` for unknown, `senderAddress`; miden/types.ts:27-50).
- Produces:
  - `interface IConsumedNote { id: string; senderAddress: string; faucetId: string; amount?: bigint }` (`amount` absent when the claimable note carried `''`)
  - `ITransaction.consumedNotes?: IConsumedNote[]` and `ConsumeTransaction.consumedNotes?: IConsumedNote[]`, set by the constructor in batch order.

- [ ] **Step 1: Write the failing test**

`src/lib/miden/db/types.test.ts:101-106`, current text (unique in the file):

```ts

      expect(tx.assetTotals).toEqual([{ faucetId: 'faucet-a', amount: 12n }]);
      expect(tx.amount).toBe(12n);
    });

    it('omits assetTotals entirely when no note carries an identifiable asset', () => {
```

becomes:

```ts

      expect(tx.assetTotals).toEqual([{ faucetId: 'faucet-a', amount: 12n }]);
      expect(tx.amount).toBe(12n);
    });

    // A consume that lands without a transaction result adopts its bridge deliveries from these alone.
    it('keeps each note s sender, faucet and amount, in batch order', () => {
      const tx = new ConsumeTransaction('acc', [
        note({ id: 'n1', senderAddress: 'faucet-sender', faucetId: 'faucet-a', amount: '10' }),
        note({ id: 'n2', senderAddress: 'wallet-sender', faucetId: 'faucet-b', amount: '3' }),
        note({ id: 'n3', senderAddress: 'faucet-sender', faucetId: 'faucet-a', amount: '' })
      ]);

      expect(tx.consumedNotes).toEqual([
        { id: 'n1', senderAddress: 'faucet-sender', faucetId: 'faucet-a', amount: 10n },
        { id: 'n2', senderAddress: 'wallet-sender', faucetId: 'faucet-b', amount: 3n },
        { id: 'n3', senderAddress: 'faucet-sender', faucetId: 'faucet-a' }
      ]);
    });

    it('omits assetTotals entirely when no note carries an identifiable asset', () => {
```

Mutation notes: deleting the `this.consumedNotes = ...` assignment fails the test (`Received: undefined`); converting `''` with `BigInt(note.amount)` unconditionally fails it on `n3` (`amount: 0n`).

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/db/types.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 1 failed, 1 total / Tests:       1 failed, 24 passed, 25 total: `keeps each note s sender, faucet and amount, in batch order` with `Received: undefined`.

- [ ] **Step 3: Implement**

`src/lib/miden/db/types.ts:136-141`, current text (unique in the file):

```ts
export interface IConsumedAssetTotal {
  faucetId: string;
  amount: bigint;
}

/**
```

becomes:

```ts
export interface IConsumedAssetTotal {
  faucetId: string;
  amount: bigint;
}

/** One note a consume claimed, as it was queued. */
export interface IConsumedNote {
  id: string;
  senderAddress: string;
  faucetId: string;
  /** Base units of the note's first fungible asset; absent when the claimable note carried no amount. */
  amount?: bigint;
}

/**
```

`src/lib/miden/db/types.ts:641-646`, current text (unique in the file):

```ts
  noteType?: NoteType;
  /** Consume only: per-faucet totals of a batch claim (see `ConsumeTransaction`). */
  assetTotals?: IConsumedAssetTotal[];
  /**
   * Consume only: queued by the everyday-key rotation gate to fund the rotation's fee
   * (#805). Generation signs such a row with the recovery key after proving every note
```

becomes:

```ts
  noteType?: NoteType;
  /** Consume only: per-faucet totals of a batch claim (see `ConsumeTransaction`). */
  assetTotals?: IConsumedAssetTotal[];
  /** Consume only: each claimed note's facts, as queued (see `ConsumeTransaction`). Not indexed. */
  consumedNotes?: IConsumedNote[];
  /**
   * Consume only: queued by the everyday-key rotation gate to fund the rotation's fee
   * (#805). Generation signs such a row with the recovery key after proving every note
```

`src/lib/miden/db/types.ts:1077-1082`, current text (unique in the file):

```ts
   * to recompute from.
   */
  assetTotals?: IConsumedAssetTotal[];
  /** See `ITransaction.rotationFunding`. */
  rotationFunding?: true;
  transactionId?: string;
```

becomes:

```ts
   * to recompute from.
   */
  assetTotals?: IConsumedAssetTotal[];
  /**
   * Each claimed note's sender, faucet and amount, as queued. A consume that completes without a transaction result,
   * through a landing the node proved, has nothing else to adopt its bridge deliveries by. Absent on rows queued
   * before it.
   */
  consumedNotes?: IConsumedNote[];
  /** See `ITransaction.rotationFunding`. */
  rotationFunding?: true;
  transactionId?: string;
```

`src/lib/miden/db/types.ts:1129-1134`, current text (unique in the file):

```ts
      total => total.faucetId !== ''
    );
    this.assetTotals = identifiedTotals.length > 0 ? identifiedTotals : undefined;
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.queuedSeq = nextQueuedSeq();
```

becomes:

```ts
      total => total.faucetId !== ''
    );
    this.assetTotals = identifiedTotals.length > 0 ? identifiedTotals : undefined;
    this.consumedNotes = list.map(note => ({
      id: note.id,
      senderAddress: note.senderAddress,
      faucetId: note.faucetId,
      ...(note.amount === '' ? {} : { amount: BigInt(note.amount) })
    }));
    this.status = ITransactionStatus.Queued;
    this.initiatedAt = Math.floor(Date.now() / 1000); // seconds
    this.queuedSeq = nextQueuedSeq();
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/db/types.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 1 passed, 1 total / Tests:       25 passed, 25 total.

- [ ] **Step 5: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/db/types.ts src/lib/miden/db/types.test.ts && npx eslint --max-warnings 0 src/lib/miden/db/types.ts src/lib/miden/db/types.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- src/lib/miden/db/types.ts src/lib/miden/db/types.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 6: Commit**

Commit deferred to Task 12 (p1-landing-paths), which makes spec commit 4.

---

### Task 11: One shared adopter for bridge deliveries (p1-adopter)

Spec 10(e) gap 2, D7. complete.ts:319-371 moves into `adoptBridgeDeliveries(consumeId, notes)` in bridge-in.ts: the registry pass, then a single note by its own sender and amount (the consume becomes the deposit's receipt), then each note of a batch by its own sender, faucet and amount, one at a time so two same-amount mints take two rows (only the tracking rows move). It is idempotent per note: a note some bridged-receive row already names as `midenNoteId` is skipped, and a consume already tagged `bridgeIn` is left alone, so a second landing path calling it never takes another deposit of the same amount. It never throws. `completeConsumeTransaction` keeps handing it the executed notes (first fungible asset of each). The five result-less landing paths (next task) call `adoptLandedConsume`, which reads the row's `consumedNotes`, else a legacy single note's `noteId`/`secondaryAccountId`/`faucetId`/`amount`, and warns and adopts nothing for a legacy batch. A note missing its amount, faucet or sender (a claimable note queued with amount `''`, or an executed note with no fungible asset) still reaches the intent registry pass, which pairs by note id alone; only the sender-and-amount pairing skips it.

complete.bridge-in.test.ts mocked the take functions (complete.bridge-in.test.ts:16-22), so the real pairing was never run there; its pairing cases move to the new bridge-in.adopt.test.ts against the real `takeUsdcxBridgeInInfo`, real writer and store, and complete.bridge-in.test.ts now checks only the hand-over. bridge-in.ts is excluded from coverage (jest.config.ts:89); complete.ts is not.

**Files:**
- Create: `src/lib/miden/activity/bridge-in.adopt.test.ts`
- Modify: `src/lib/miden/activity/bridge-in.ts`, `src/lib/miden/transaction/complete.ts`
- Test: `src/lib/miden/transaction/complete.bridge-in.test.ts` (rewritten)

**Interfaces:**
- Consumes: `applyBridgeInInfoForNotes` (bridge-in.ts:360), `applyBridgeInToConsumeRow` (:108), `takeAgglayerBridgeInInfo` (:220), `takeUsdcxBridgeInInfo` (:277 + Task 8 (p1-ready-timeout-late-mint)), `noteIdKey` (:74), `updateBridgedReceivePhase` (dynamic import of `../transaction/complete`, as bridge-in.ts:120 does), `ITransaction.consumedNotes` (Task 10, p1-consumed-notes).
- Produces (bridge-in.ts):
  - `interface AdoptableNote { id: string; senderAddress: string; faucetId: string; amount?: bigint }` (`amount` absent for a note with no readable amount, which only the registry pass can match)
  - `adoptableNotesOf(tx: Pick<ITransaction, 'consumedNotes' | 'noteId' | 'noteIds' | 'secondaryAccountId' | 'faucetId' | 'amount'>): AdoptableNote[] | undefined` (undefined only for a legacy batch; a note missing a pairing fact is kept, for the registry pass alone)
  - `adoptBridgeDeliveries(consumeId: string, notes: readonly AdoptableNote[]): Promise<void>` (never throws)
  - `adoptLandedConsume(consumeId: string): Promise<void>` (never throws; adopts only for a Completed, non-restored consume)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/miden/activity/bridge-in.adopt.test.ts` with exactly this content:

```ts
import * as Repo from 'lib/miden/repo';

import { adoptableNotesOf, adoptBridgeDeliveries, adoptLandedConsume, AdoptableNote } from './bridge-in';
import { IBridgedReceiveExtraInputs, IBridgedReceivePhase, ITransaction, ITransactionStatus } from '../db/types';

// Real store, real matchers and real writers: only the SDK's id parse, the discovered native asset (USDCx, read in
// hex as the wallet discovers it), the bridge config and the intent registry are stood in for.
const USDCX_FAUCET = 'mtst1usdcxfaucet000000000000000';
const ACCOUNT = 'mtst1account000000000000000000_qruqqypuyph';
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) },
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1usdcxfaucet000000000000000: '0x4cbdcaffe75f0a317482224dae6436',
        mtst1account000000000000000000: '0x8da911727d5b53916f2c221c00c091'
      };
      const hex = known[address];
      if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
      return { accountId: () => ({ toString: () => hex }) };
    }
  }
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: async () => '0x4cbdcaffe75f0a317482224dae6436'
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({}),
  initBridgeConfig: async () => ({})
}));
// The intent registry is empty unless a test names one.
const mockFetchFromStorage = jest.fn();
jest.mock('../front/storage', () => ({
  inStorageTurn: jest.requireActual('../front/storage').inStorageTurn,
  fetchFromStorage: (key: string) => mockFetchFromStorage(key),
  putToStorage: async () => undefined
}));

const DEPOSIT = 1_000_000n;

const addDeposit = async (
  id: string,
  phase: IBridgedReceivePhase,
  initiatedAt = Math.floor(Date.now() / 1000),
  extra: Partial<IBridgedReceiveExtraInputs> = {}
) => {
  await Repo.transactions.add({
    id,
    type: 'bridged-receive',
    accountId: ACCOUNT,
    amount: DEPOSIT,
    faucetId: USDCX_FAUCET,
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    initiatedAt,
    extraInputs: {
      provider: 'usdcx',
      phase,
      sourceAddress: '0xsource',
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      evmTxHash: `0x${'5'.repeat(64)}`,
      ...extra
    }
  });
};

const mint = (id: string, amount = DEPOSIT): AdoptableNote => ({
  id,
  senderAddress: USDCX_FAUCET,
  faucetId: USDCX_FAUCET,
  amount
});

const addConsume = async (overrides: Partial<ITransaction> = {}) => {
  await Repo.transactions.add({
    id: 'consume',
    type: 'consume',
    accountId: ACCOUNT,
    status: ITransactionStatus.Completed,
    transactionId: 'chain-tx',
    secondaryAccountId: USDCX_FAUCET,
    faucetId: USDCX_FAUCET,
    amount: DEPOSIT,
    displayIcon: 'RECEIVE',
    displayMessage: 'Received',
    initiatedAt: Math.floor(Date.now() / 1000),
    ...overrides
  });
};

const phaseOf = async (id: string) => (await Repo.transactions.get(id))?.extraInputs;

beforeEach(async () => {
  mockFetchFromStorage.mockReset();
  await Repo.transactions.clear();
});

describe('adoptBridgeDeliveries', () => {
  // USDCx is the native asset and its mints are auto-claimed together: two same-amount mints in one consume must
  // land two deposits, one each.
  it('lands two same-amount mints of one batch in two deposits', async () => {
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addConsume({ noteIds: ['note-1', 'note-2'] });

    await adoptBridgeDeliveries('consume', [mint('note-1'), mint('note-2')]);

    expect(await phaseOf('deposit-a')).toMatchObject({ phase: 'received', midenNoteId: expect.any(String) });
    expect(await phaseOf('deposit-b')).toMatchObject({ phase: 'received', midenNoteId: expect.any(String) });
    const noteIds = [(await phaseOf('deposit-a'))?.midenNoteId, (await phaseOf('deposit-b'))?.midenNoteId];
    expect(noteIds.sort()).toEqual(['note-1', 'note-2']);
    expect((await Repo.transactions.get('deposit-b'))?.transactionId).toBe('chain-tx');
    // Only the deposits move: the batch keeps its own label.
    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Received');
    expect(consume?.extraInputs?.bridgeIn).toBeUndefined();
  });

  it('tags a single-mint consume as the receipt of its deposit', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1'] });

    await adoptBridgeDeliveries('consume', [mint('note-1')]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Bridged from EVM');
    expect(consume?.extraInputs?.bridgeIn).toMatchObject({ provider: 'usdcx', bridgeReceiveTxId: 'deposit' });
  });

  // Every landing path calls the adopter, so a second call for a note already landed must not take another deposit
  // of the same amount.
  it.each([
    ['a single-mint consume', ['note-1']],
    ['a batch', ['note-1', 'note-2']]
  ])('adopts each note once when called again for %s', async (_label, noteIds) => {
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addDeposit('deposit-c', 'delivering');
    await addConsume({ noteIds });
    const notes = noteIds.map(id => mint(id));

    await adoptBridgeDeliveries('consume', notes);
    await Repo.transactions.update('consume', { extraInputs: undefined });
    await adoptBridgeDeliveries('consume', notes);

    const phases = await Promise.all(['deposit-a', 'deposit-b', 'deposit-c'].map(phaseOf));
    expect(phases.filter(inputs => inputs?.phase === 'received')).toHaveLength(noteIds.length);
  });

  it('pairs a batch note by its own amount, never by the batch total', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1', 'note-2'] });

    await adoptBridgeDeliveries('consume', [mint('note-1', DEPOSIT / 2n), mint('note-2', DEPOSIT / 2n)]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'ready' });
  });

  it('lands a late mint in a deposit that timed out after Circle attested it', async () => {
    const now = Math.floor(Date.now() / 1000);
    await addDeposit('deposit', 'failed', now - 9 * 24 * 60 * 60, {
      readyAt: now - 8 * 24 * 60 * 60,
      error: 'Bridge delivery timed out.'
    });
    await addConsume({ noteIds: ['note-1'] });

    await adoptBridgeDeliveries('consume', [mint('note-1')]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  it('never throws, whatever the store does', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const where = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('store closed');
    });

    await expect(adoptBridgeDeliveries('consume', [mint('note-1')])).resolves.toBeUndefined();

    where.mockRestore();
    warn.mockRestore();
  });
});

describe('adoptableNotesOf', () => {
  it('reads the per-note facts a consume kept, a note with no amount included', () => {
    expect(
      adoptableNotesOf({
        consumedNotes: [
          { id: 'note-1', senderAddress: USDCX_FAUCET, faucetId: USDCX_FAUCET, amount: DEPOSIT },
          { id: 'note-2', senderAddress: USDCX_FAUCET, faucetId: USDCX_FAUCET }
        ]
      })
    ).toEqual([mint('note-1'), { id: 'note-2', senderAddress: USDCX_FAUCET, faucetId: USDCX_FAUCET }]);
  });

  it('falls back to the one note a legacy single-note consume names', () => {
    expect(
      adoptableNotesOf({
        noteId: 'note-1',
        noteIds: ['note-1'],
        secondaryAccountId: USDCX_FAUCET,
        faucetId: USDCX_FAUCET,
        amount: DEPOSIT
      })
    ).toEqual([mint('note-1')]);
  });

  it('has nothing for a legacy batch, which kept no per-note facts', () => {
    expect(adoptableNotesOf({ noteId: 'note-1', noteIds: ['note-1', 'note-2'], amount: DEPOSIT })).toBeUndefined();
  });
});

describe('adoptLandedConsume', () => {
  it('lands a deposit from the facts a consume kept when it completed with no transaction result', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1'], consumedNotes: [mint('note-1')] });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  it('lands a deposit for a consume queued before the per-note facts existed', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteId: 'note-1', noteIds: ['note-1'] });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  // The intent registry pairs by note id alone, so a claimed note with no readable amount still reaches it.
  it('lands a registry delivery whose note carried no amount', async () => {
    mockFetchFromStorage.mockResolvedValue([
      {
        userAddress: 'not-an-evm-address',
        intentNonce: '7',
        info: { provider: 'epoch', sourceSymbol: 'USDC' },
        midenNoteId: 'note-1',
        registeredAt: Date.now()
      }
    ]);
    await addConsume({
      noteIds: ['note-1'],
      consumedNotes: [{ id: 'note-1', senderAddress: 'epoch-solver', faucetId: USDCX_FAUCET }]
    });

    await adoptLandedConsume('consume');

    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Bridged from EVM');
    expect(consume?.extraInputs?.bridgeIn).toMatchObject({ provider: 'epoch', midenNoteId: 'note-1' });
  });

  it('warns and adopts nothing for a legacy batch', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await addDeposit('deposit', 'ready');
    await addConsume({ noteId: 'note-1', noteIds: ['note-1', 'note-2'] });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'ready' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept no per-note facts'), 'consume');
    warn.mockRestore();
  });

  it.each<[string, Partial<ITransaction>]>([
    ['still generating', { status: ITransactionStatus.GeneratingTransaction }],
    ['failed', { status: ITransactionStatus.Failed }],
    ['restored from a backup', { restoredFromBackup: true }]
  ])('adopts nothing for a consume %s', async (_label, overrides) => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1'], consumedNotes: [mint('note-1')], ...overrides });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'ready' });
  });
});
```

Replace the whole content of `src/lib/miden/transaction/complete.bridge-in.test.ts` with:

```ts
import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { completeConsumeTransaction } from './complete';
import { adoptBridgeDeliveries } from '../activity/bridge-in';

// The pairing itself runs against the real matchers in bridge-in.adopt.test.ts; here the consume only hands it over.
jest.mock('../activity/bridge-in', () => ({
  adoptBridgeDeliveries: jest.fn(async () => undefined)
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));

const executedNote = (id: string, sender: string, assets: Array<[string, bigint]>) => ({
  note: () => ({
    id: () => ({ toString: () => id }),
    metadata: () => ({ sender: () => sender, noteType: () => 0 }),
    assets: () => ({
      fungibleAssets: () => assets.map(([faucetId, amount]) => ({ faucetId: () => faucetId, amount: () => amount }))
    })
  })
});

function consumeOf(notes: readonly object[]): TransactionResult {
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'chain-tx' }),
      inputNotes: () => ({ notes: () => notes })
    }),
    serialize: () => new Uint8Array([1])
  });
  return result;
}

beforeEach(async () => {
  jest.mocked(adoptBridgeDeliveries).mockClear();
  await Repo.transactions.clear();
  await Repo.transactions.add({
    id: 'consume',
    type: 'consume',
    accountId: 'account',
    status: ITransactionStatus.GeneratingTransaction,
    displayIcon: 'RECEIVE',
    initiatedAt: 1
  });
});

// A batch's per-faucet total is no single delivery's amount: each note goes over by its own first asset.
it('hands the adopter each executed note by its own sender, faucet and amount, once the row is Completed', async () => {
  let statusAtAdoption: ITransactionStatus | undefined;
  jest.mocked(adoptBridgeDeliveries).mockImplementationOnce(async id => {
    statusAtAdoption = (await Repo.transactions.get(id))?.status;
  });

  await completeConsumeTransaction(
    'consume',
    consumeOf([
      executedNote('note-1', 'usdcx-faucet', [['usdcx-faucet', 1n]]),
      executedNote('note-2', 'wallet', [
        ['usdcx-faucet', 2n],
        ['other-faucet', 9n]
      ])
    ])
  );

  expect(adoptBridgeDeliveries).toHaveBeenCalledTimes(1);
  expect(adoptBridgeDeliveries).toHaveBeenCalledWith('consume', [
    { id: 'note-1', senderAddress: 'usdcx-faucet', faucetId: 'usdcx-faucet', amount: 1n },
    { id: 'note-2', senderAddress: 'wallet', faucetId: 'usdcx-faucet', amount: 2n }
  ]);
  expect(statusAtAdoption).toBe(ITransactionStatus.Completed);
});

it('offers a note with no fungible asset to the registry pass alone', async () => {
  await completeConsumeTransaction(
    'consume',
    consumeOf([executedNote('note-1', 'usdcx-faucet', [['usdcx-faucet', 1n]]), executedNote('note-2', 'wallet', [])])
  );

  expect(adoptBridgeDeliveries).toHaveBeenCalledWith('consume', [
    { id: 'note-1', senderAddress: 'usdcx-faucet', faucetId: 'usdcx-faucet', amount: 1n },
    { id: 'note-2', senderAddress: '', faucetId: '' }
  ]);
});

it('completes the consume even when a note cannot be read for adoption', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const withoutId = {
    metadata: () => ({ sender: () => 'usdcx-faucet', noteType: () => 0 }),
    assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'usdcx-faucet', amount: () => 1n }] })
  };

  await completeConsumeTransaction('consume', consumeOf([{ note: () => withoutId }]));

  expect((await Repo.transactions.get('consume'))?.status).toBe(ITransactionStatus.Completed);
  expect(adoptBridgeDeliveries).not.toHaveBeenCalled();
  warn.mockRestore();
});
```

Mutation notes:
- Replacing `notes.filter(note => !adopted.has(noteIdKey(note.id)))` with `notes` fails both 'adopts each note once when called again for ...' cases (a second deposit is received).
- A `break` after the first paired batch note fails 'lands two same-amount mints of one batch in two deposits'; pairing a batch by the summed amount fails 'pairs a batch note by its own amount, never by the batch total'.
- `adoptableNotesOf` returning `undefined` when `consumedNotes` is absent fails 'lands a deposit for a consume queued before the per-note facts existed'; returning `[]` for a legacy batch fails 'warns and adopts nothing for a legacy batch'.
- complete.ts passing the per-faucet total instead of each note's first asset fails 'hands the adopter each executed note ...'; removing the try/catch around the hand-over fails 'completes the consume even when a note cannot be read for adoption'.
- `adoptableNotesOf` filtering out a note with no amount fails 'lands a registry delivery whose note carried no amount' and 'reads the per-note facts a consume kept, a note with no amount included'; complete.ts handing over no entry for a note with no fungible asset fails 'offers a note with no fungible asset to the registry pass alone'.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/activity/bridge-in.adopt.test.ts src/lib/miden/transaction/complete.bridge-in.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 2 failed, 2 total / Tests:       19 failed, 1 passed, 20 total: bridge-in.adopt.test.ts with `TypeError: (0 , _bridgein.adoptBridgeDeliveries) is not a function` (and `adoptableNotesOf`, `adoptLandedConsume`), complete.bridge-in.test.ts because complete.ts still calls the take functions the new mock no longer provides.

- [ ] **Step 3: Implement the adopter**

`src/lib/miden/activity/bridge-in.ts:330-335`, current text (unique in the file):

```ts
  };
}

/** Persist each submitted owner/nonce once, before its delivery is known. */
export async function registerPendingBridgeIn(
  userAddress: string,
```

becomes:

```ts
  };
}

/** A claimed note's facts, as adoption pairs it with a tracking row. */
export interface AdoptableNote {
  id: string;
  senderAddress: string;
  faucetId: string;
  /** Absent for a note with no readable amount: the intent registry, which pairs by id alone, is its only match. */
  amount?: bigint;
}

/**
 * The notes a completed consume adopts by: the per-note facts it kept at queue time, else the one note a single-note
 * row from before them names. Undefined for an older batch, which kept nothing per note.
 */
export function adoptableNotesOf(
  tx: Pick<ITransaction, 'consumedNotes' | 'noteId' | 'noteIds' | 'secondaryAccountId' | 'faucetId' | 'amount'>
): AdoptableNote[] | undefined {
  if (tx.consumedNotes !== undefined) return [...tx.consumedNotes];
  if ((tx.noteIds?.length ?? 1) > 1) return undefined;
  const { noteId, secondaryAccountId, faucetId, amount } = tx;
  if (!noteId) return [];
  return [{ id: noteId, senderAddress: secondaryAccountId ?? '', faucetId: faucetId ?? '', amount }];
}

async function takeDeliveryInfo(accountId: string, note: AdoptableNote): Promise<IBridgeInInfo | undefined> {
  const { senderAddress, faucetId, amount } = note;
  // A note missing a pairing fact can only be a registry delivery, which the registry pass pairs by id.
  if (!senderAddress || !faucetId || amount === undefined) return undefined;
  return (
    (await takeAgglayerBridgeInInfo({ accountId, senderAccountId: senderAddress, amount })) ??
    (await takeUsdcxBridgeInInfo({ accountId, senderAccountId: senderAddress, faucetId, amount }))
  );
}

/** The notes some tracking row already names as its delivery. */
async function adoptedNoteKeys(notes: readonly AdoptableNote[]): Promise<Set<string>> {
  const keys = new Set(notes.map(note => noteIdKey(note.id)));
  const named = (tx: ITransaction): string | undefined => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    return inputs?.midenNoteId === undefined ? undefined : noteIdKey(inputs.midenNoteId);
  };
  const rows = await Repo.transactions
    .where('type')
    .equals('bridged-receive')
    .filter(tx => {
      const key = named(tx);
      return key !== undefined && keys.has(key);
    })
    .toArray();
  return new Set(rows.flatMap(tx => named(tx) ?? []));
}

/**
 * Settle the bridge deliveries a completed consume claimed: the intent registry first, then a single note by its own
 * sender and amount, which makes the consume the deposit's receipt, then each note of a batch by its own sender,
 * faucet and amount, one at a time so two same-amount mints take two rows (only the tracking rows move). Six landing
 * paths call this, so a note a tracking row already names is skipped: a second call must not take another deposit of
 * the same amount. Never throws: tagging must never fail the consume.
 */
export async function adoptBridgeDeliveries(consumeId: string, notes: readonly AdoptableNote[]): Promise<void> {
  try {
    const consume = await Repo.transactions.where({ id: consumeId }).first();
    if (!consume || consume.extraInputs?.bridgeIn) return;
    const adopted = await adoptedNoteKeys(notes);
    const open = notes.filter(note => !adopted.has(noteIdKey(note.id)));
    if (open.length === 0) return;
    // The registry takes at most one note; the batch below pairs every other one, by the registry's canonical id.
    let registryNoteKey: string | undefined;
    const applied = await applyBridgeInInfoForNotes(
      open.map(note => note.id),
      info => {
        if (info.midenNoteId) registryNoteKey = noteIdKey(info.midenNoteId);
        return applyBridgeInToConsumeRow(consumeId, info);
      }
    );
    const batch = notes.length > 1 || (consume.noteIds?.length ?? notes.length) > 1;
    const [single] = open;
    if (!batch) {
      if (applied || !single) return;
      // A note the USDCx faucet minted for an xReserve deposit is otherwise an ordinary faucet receive.
      const info = await takeDeliveryInfo(consume.accountId, single);
      if (info) await applyBridgeInToConsumeRow(consumeId, { ...info, midenNoteId: single.id });
      return;
    }
    // A batch's per-faucet total is no single delivery's amount, and native USDCx mints are auto-claimed together.
    for (const note of open) {
      if (registryNoteKey !== undefined && noteIdKey(note.id) === registryNoteKey) continue;
      const info = await takeDeliveryInfo(consume.accountId, note);
      if (!info?.bridgeReceiveTxId || note.amount === undefined) continue;
      const { updateBridgedReceivePhase } = await import('../transaction/complete');
      await updateBridgedReceivePhase(
        info.bridgeReceiveTxId,
        'received',
        { midenNoteId: note.id },
        { amount: note.amount, faucetId: note.faucetId, transactionId: consume.transactionId }
      );
    }
  } catch (err) {
    console.warn('[bridge-in] consume tagging failed (non-fatal)', consumeId, err);
  }
}

/**
 * Adoption for a consume completed with no transaction result, by a landing the node proved: the per-note facts the
 * row kept are all there is to pair by. Never throws.
 */
export async function adoptLandedConsume(consumeId: string): Promise<void> {
  try {
    const consume = await Repo.transactions.where({ id: consumeId }).first();
    if (consume?.type !== 'consume' || consume.status !== ITransactionStatus.Completed || consume.restoredFromBackup)
      return;
    const notes = adoptableNotesOf(consume);
    if (notes === undefined) {
      console.warn('[bridge-in] a landed batch consume kept no per-note facts, so none is adopted', consumeId);
      return;
    }
    await adoptBridgeDeliveries(consumeId, notes);
  } catch (err) {
    console.warn('[bridge-in] landed consume adoption failed (non-fatal)', consumeId, err);
  }
}

/** Persist each submitted owner/nonce once, before its delivery is known. */
export async function registerPendingBridgeIn(
  userAddress: string,
```

- [ ] **Step 4: Delegate `completeConsumeTransaction` to it**

`src/lib/miden/transaction/complete.ts:40-52`, current text (unique in the file):

```ts
  updateTransactionStatus
} from './helper';
import { ensureGuardianProcedureThresholds } from './initiate';
import {
  applyBridgeInInfoForNotes,
  applyBridgeInToConsumeRow,
  noteIdKey,
  takeAgglayerBridgeInInfo,
  takeUsdcxBridgeInInfo
} from '../activity/bridge-in';
import { feeFieldsFromResult, splitExecutedOutputNotes } from '../activity/fee';
import { interpretTransactionResult } from '../activity/helpers';
import { compareAccountIds } from '../activity/utils';
```

becomes:

```ts
  updateTransactionStatus
} from './helper';
import { ensureGuardianProcedureThresholds } from './initiate';
import { adoptBridgeDeliveries } from '../activity/bridge-in';
import { feeFieldsFromResult, splitExecutedOutputNotes } from '../activity/fee';
import { interpretTransactionResult } from '../activity/helpers';
import { compareAccountIds } from '../activity/utils';
```

`src/lib/miden/transaction/complete.ts:316-371`, current text (unique in the file):

```ts
    resultBytes: result.serialize()
  });

  // Best-effort bridge-in tagging: if this consume claimed a note parked by an
  // EVM→Miden intent (plain bridge deposit OR a Smart Withdraw delivery), tag the
  // row as "Bridged from EVM". A bridge-in with a `bridgeReceiveTxId` also flips
  // that tracking row to `received`; one with an `earnWithdrawTxId` flips the
  // linked Smart Withdraw row instead, with the actual consumed amount. Must never
  // fail the consume itself.
  try {
    const consumedNoteIds = inputNotes.map(inputNote => inputNote.note().id().toString());
    // The registry takes at most one note; the batch below pairs every other one, by the registry's canonical id.
    let registryNoteKey: string | undefined;
    const applied = await applyBridgeInInfoForNotes(consumedNoteIds, info => {
      if (info.midenNoteId) registryNoteKey = noteIdKey(info.midenNoteId);
      return applyBridgeInToConsumeRow(id, info);
    });
    const accountId = dbTransaction?.accountId ?? '';
    if (!applied && inputNotes.length === 1) {
      // A note the USDCx faucet minted for an xReserve deposit is otherwise an ordinary faucet receive.
      const info =
        (await takeAgglayerBridgeInInfo({ accountId, senderAccountId: sender, amount })) ??
        (await takeUsdcxBridgeInInfo({ accountId, senderAccountId: sender, faucetId, amount }));
      if (info) await applyBridgeInToConsumeRow(id, { ...info, midenNoteId: consumedNoteIds[0] });
    } else if (inputNotes.length > 1) {
      // A batch's per-faucet total is no single delivery's amount, and native USDCx mints are auto-claimed together,
      // so each note is paired by its own sender, faucet and amount, one at a time so two same-amount mints adopt two
      // rows. Only the tracking rows move; the batch row keeps its own label.
      for (const inputNote of inputNotes) {
        const batchNote = inputNote.note();
        if (registryNoteKey !== undefined && noteIdKey(batchNote.id().toString()) === registryNoteKey) continue;
        const noteAsset = batchNote.assets().fungibleAssets()[0];
        if (!noteAsset) continue;
        const noteSender = getBech32AddressFromAccountId(batchNote.metadata().sender());
        const noteFaucetId = getBech32AddressFromAccountId(noteAsset.faucetId());
        const noteAmount = noteAsset.amount();
        const info =
          (await takeAgglayerBridgeInInfo({ accountId, senderAccountId: noteSender, amount: noteAmount })) ??
          (await takeUsdcxBridgeInInfo({
            accountId,
            senderAccountId: noteSender,
            faucetId: noteFaucetId,
            amount: noteAmount
          }));
        if (!info?.bridgeReceiveTxId) continue;
        await updateBridgedReceivePhase(
          info.bridgeReceiveTxId,
          'received',
          { midenNoteId: batchNote.id().toString() },
          { amount: noteAmount, faucetId: noteFaucetId, transactionId: executedTransaction.id().toHex() }
        );
      }
    }
  } catch (err) {
    console.warn('[bridge-in] consume tagging failed (non-fatal)', err);
  }
```

becomes:

```ts
    resultBytes: result.serialize()
  });

  // A note parked by an EVM→Miden intent, or minted for a tracked deposit, settles its bridge row. Each executed
  // note goes over by its own first asset: the per-faucet totals above are no single delivery's amount. Must never
  // fail the consume itself.
  try {
    await adoptBridgeDeliveries(
      id,
      inputNotes.map(inputNote => {
        const executed = inputNote.note();
        const noteAsset = executed.assets().fungibleAssets()[0];
        // A note with no fungible asset can only be a registry delivery, which pairs by id alone.
        if (!noteAsset) return { id: executed.id().toString(), senderAddress: '', faucetId: '' };
        return {
          id: executed.id().toString(),
          senderAddress: getBech32AddressFromAccountId(executed.metadata().sender()),
          faucetId: getBech32AddressFromAccountId(noteAsset.faucetId()),
          amount: noteAsset.amount()
        };
      })
    );
  } catch (err) {
    console.warn('[bridge-in] consume tagging failed (non-fatal)', err);
  }
```

- [ ] **Step 5: Run them and watch them pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/activity/bridge-in.adopt.test.ts src/lib/miden/transaction/complete.bridge-in.test.ts src/lib/miden/activity/bridge-in.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 2 passed, 2 total / Tests:       20 passed, 20 total for the two new and rewritten suites, and bridge-in.test.ts green. Then:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction src/lib/miden/activity --maxWorkers=2
```

Expected: PASS. Suites whose fixtures build notes without `id()` (transactions.extended.test.ts, transactions.gaps.test.ts) stay green only because the hand-over is inside its try/catch.

- [ ] **Step 6: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/activity/bridge-in.ts src/lib/miden/transaction/complete.ts src/lib/miden/activity/bridge-in.adopt.test.ts src/lib/miden/transaction/complete.bridge-in.test.ts && npx eslint --max-warnings 0 src/lib/miden/activity/bridge-in.ts src/lib/miden/transaction/complete.ts src/lib/miden/activity/bridge-in.adopt.test.ts src/lib/miden/transaction/complete.bridge-in.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && { git diff -U0 -- src/lib/miden/activity/bridge-in.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/complete.bridge-in.test.ts | grep '^+'; cat src/lib/miden/activity/bridge-in.adopt.test.ts; } | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 7: Commit**

Commit deferred to Task 12 (p1-landing-paths), which makes spec commit 4.

---

### Task 12: Adopt on every result-less consume landing path (p1-landing-paths)

Spec 10(e) gap 2. Five paths complete a consume without a `TransactionResult` and, until now, without adoption, so the deposit row stayed `ready` beside a separate Received consume until the timeout failed it. Each now calls `adoptLandedConsume(id)` right after its Completed write:
1. `writeLanding` (reconcile-unconfirmed.ts:114-141, also reached by Retry's `checkEvidenceForRetry`, :239-257), after its rw transaction and report, for a consume row;
2. the Guardian landed-after-apply-failure branch (transaction/index.ts:1451-1473), after its try/catch, for a consume;
3. the loop's landed-after-apply-failure branch (index.ts:4342-4355), inside its `!hasLeftQueue` write, for a consume;
4. `tryCompleteKilledConsume` (index.ts:1228-1232), after its Completed write;
5. the stuck-consume reaper (cancel.ts:965-985), after `resolvedCount++`.
`adoptLandedConsume` never throws and re-checks Completed itself, so the Guardian branch may call it after its own write was refused.

Imports are static. bridge-in.ts's static import closure (43 modules, crawled) reaches no module under `src/lib/miden/transaction/`, and index.ts already reaches bridge-in through complete.ts, so none of the three new edges closes a cycle of the kind verdict-rules.ts:1-3 warns about.

The new suite drives each path through its real entry point (`judgeAndWrite`, `verifyStuckTransactionsFromNode`, `generateTransactionsLoop`, `generateTransaction`) on the real store with the real adopter and matchers, standing in only for the client proxy, the WASM lock, the Guardian service, the SDK id helpers and the native asset id.

**Files:**
- Create: `src/lib/miden/transaction/consume-landing-adoption.test.ts`
- Modify: `src/lib/miden/transaction/index.ts`, `src/lib/miden/transaction/cancel.ts`, `src/lib/miden/transaction/reconcile-unconfirmed.ts`

**Interfaces:**
- Consumes: `adoptLandedConsume(consumeId: string): Promise<void>` (Task 11, p1-adopter), `ITransaction.consumedNotes` (Task 10, p1-consumed-notes).
- Produces: behavior only. A consume of a USDCx mint that lands through any of the five paths moves its bridged-receive row to `received` with `midenNoteId` set; the consume row itself keeps the landed shape (status 2, no `resultBytes`, no `resultReleasedAt`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/miden/transaction/consume-landing-adoption.test.ts` with exactly this content:

```ts
// Every path that completes a consume without a TransactionResult must still land the USDCx deposit its note was
// minted for. Real store, real adopter and real matchers; the client, the node and the Guardian are stood in for.
import * as Repo from 'lib/miden/repo';

import { verifyStuckTransactionsFromNode } from './cancel';
import { generateTransaction, generateTransactionsLoop } from './index';
import { NodeReads } from './reconcile-reads';
import { judgeAndWrite } from './reconcile-unconfirmed';
import { OperationAbortedError } from '../back/offscreen-codec';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockConsumeNoteId = jest.fn();
const mockGetInputNoteDetails = jest.fn();
const mockDispatchGuardianPipeline = jest.fn();
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: (...a: unknown[]) => mockDispatchGuardianPipeline(...a),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    consumeNoteId: (...a: unknown[]) => mockConsumeNoteId(...a),
    getInputNoteDetails: (...a: unknown[]) => mockGetInputNoteDetails(...a)
  }
}));
jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }));
let mockHold: object | null = null;
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({ syncState: async () => {} }),
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = {};
    mockHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (mockHold === hold) mockHold = null;
    }
  },
  getCurrentWasmLockHold: () => mockHold,
  assertWasmHoldCurrent: () => {},
  withWasmLockWatchdogPaused: async <T>(fn: () => Promise<T>) => fn()
}));
const mockIsGuardianAccount = jest.fn(async () => false);
const mockService = {
  guardianEndpoint: 'https://guardian.test',
  priorCandidateState: jest.fn(async () => 'settled'),
  createConsumeNotesProposal: jest.fn(async () => ({ id: 'prop', nonce: 7 })),
  signAndCreateTransactionRequest: jest.fn(async () => ({
    serialize: () => new Uint8Array([1]),
    authArg: () => undefined
  })),
  abandonCandidate: jest.fn(async () => {}),
  sync: jest.fn(async () => {})
};
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: () => mockIsGuardianAccount(),
  getOrCreateMultisigService: async () => mockService,
  clearGuardianServiceFor: jest.fn()
}));
jest.mock('../activity/notes', () => ({ importAllNotes: jest.fn(), queueNoteImport: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetId: async () => 'usdcx-faucet'
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({}),
  initBridgeConfig: async () => ({})
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn(), reportProve: jest.fn() }));
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => false,
  isExtension: () => true
}));
jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));

const NOW = Math.floor(Date.now() / 1000);
const MINT = 1_000_000n;
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const signCallback = jest.fn(async () => new Uint8Array([1]));
const provider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

const addDeposit = () =>
  Repo.transactions.add({
    id: 'deposit',
    type: 'bridged-receive',
    accountId: 'account',
    amount: MINT,
    faucetId: 'usdcx-faucet',
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    initiatedAt: NOW - 60,
    extraInputs: {
      provider: 'usdcx',
      phase: 'ready',
      sourceAddress: '0xsource',
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      evmTxHash: hex(5)
    }
  });

/** The consume of one USDCx mint, as `ConsumeTransaction` queues it. */
const mintConsume = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'consume',
  type: 'consume',
  accountId: 'account',
  noteId: 'mint-note',
  noteIds: ['mint-note'],
  secondaryAccountId: 'usdcx-faucet',
  faucetId: 'usdcx-faucet',
  amount: MINT,
  consumedNotes: [{ id: 'mint-note', senderAddress: 'usdcx-faucet', faucetId: 'usdcx-faucet', amount: MINT }],
  status: ITransactionStatus.Queued,
  initiatedAt: NOW,
  displayIcon: 'RECEIVE',
  ...overrides
});

const deposit = () => Repo.transactions.get('deposit');
const consume = () => Repo.transactions.get('consume');

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsGuardianAccount.mockResolvedValue(false);
  mockGetInputNoteDetails.mockResolvedValue([]);
  delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  await Repo.transactions.clear();
  await addDeposit();
});

/** What a landing left: the consume's status and kept result, and the deposit's phase and note. */
const outcome = async () => {
  const [row, tracker] = [await consume(), await deposit()];
  return {
    status: row?.status,
    resultBytes: row?.resultBytes,
    phase: tracker?.extraInputs?.phase,
    midenNoteId: tracker?.extraInputs?.midenNoteId
  };
};
const LANDED = { status: ITransactionStatus.Completed, phase: 'received', midenNoteId: 'mint-note' };

it('the unconfirmed reconciler landing a consume lands its deposit', async () => {
  await Repo.transactions.put(
    mintConsume({
      status: ITransactionStatus.Unconfirmed,
      completedAt: NOW - 30,
      mayHaveSubmitted: true,
      submitEvidence: [
        {
          attemptId: 'a1',
          capturedAt: NOW - 30,
          source: 'stage',
          transactionId: hex(2),
          initialCommitment: hex(10),
          finalCommitment: hex(11),
          initialNonce: '5',
          outputNoteIds: [],
          nullifiers: [],
          refBlock: 100,
          refBlockCommitment: hex(1),
          expirationBlock: 700
        }
      ]
    })
  );
  const node: NodeReads = {
    blockCommitment: async () => hex(1),
    account: async () => ({ ok: true, state: { blockNum: 150, commitment: hex(11) } }),
    noteInclusions: async () => new Map(),
    nullifierHeight: async () => null
  };

  expect((await judgeAndWrite('consume', { node, nowSec: NOW, cadenceMs: 3_000 })).kind).toBe('landed');

  expect(await outcome()).toEqual(LANDED);
});

it('the stuck-consume reaper completing a consume lands its deposit', async () => {
  await Repo.transactions.put(
    mintConsume({ status: ITransactionStatus.GeneratingTransaction, processingStartedAt: NOW - 30 })
  );
  mockGetInputNoteDetails.mockResolvedValue([{ state: 'ConsumedAuthenticatedLocal' }]);

  await verifyStuckTransactionsFromNode();

  expect(await outcome()).toEqual(LANDED);
});

it('a killed consume the node shows landed lands its deposit', async () => {
  await Repo.transactions.put(mintConsume());
  mockConsumeNoteId.mockRejectedValue(new OperationAbortedError('op-kill', 'deadline'));
  mockGetInputNoteDetails.mockResolvedValue([{ state: 'ConsumedAuthenticatedLocal' }]);

  await generateTransactionsLoop(signCallback, false, provider);

  expect(await outcome()).toEqual(LANDED);
});

it('a consume whose submit landed but whose local apply failed lands its deposit', async () => {
  await Repo.transactions.put(mintConsume());
  const applyFailed = Object.assign(new Error('local apply failed after submit'), {
    errorCode: 'ApplyTransactionAfterSubmitFailed',
    landed: { transactionId: hex(2) }
  });
  mockConsumeNoteId.mockRejectedValue(applyFailed);

  await generateTransactionsLoop(signCallback, false, provider);

  expect(await outcome()).toEqual(LANDED);
});

it('a Guardian consume whose submit landed but whose local apply failed lands its deposit', async () => {
  process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
  mockIsGuardianAccount.mockResolvedValue(true);
  await Repo.transactions.put(mintConsume({ status: ITransactionStatus.GeneratingTransaction }));
  const applyFailed = Object.assign(new Error('local apply failed after submit'), {
    errorCode: 'ApplyTransactionAfterSubmitFailed',
    landed: { transactionId: hex(2) }
  });
  mockDispatchGuardianPipeline.mockRejectedValue(applyFailed);

  await generateTransaction(
    mintConsume({ status: ITransactionStatus.GeneratingTransaction }),
    signCallback,
    false,
    provider
  );

  expect(await outcome()).toEqual(LANDED);
});
```

Mutation note: removing any one of the five `adoptLandedConsume` calls fails exactly that path's case (deposit `"phase": "ready"`); with all five removed every case fails while the consume row still reads Completed, which is gap 2 as the spec states it.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction/consume-landing-adoption.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 1 failed, 1 total / Tests:       5 failed, 5 total; each case reaches a Completed consume and fails on the deposit (`- "phase": "received"` / `+ "phase": "ready"`):
  - `a Guardian consume whose submit landed but whose local apply failed lands its deposit`
  - `a consume whose submit landed but whose local apply failed lands its deposit`
  - `a killed consume the node shows landed lands its deposit`
  - `the stuck-consume reaper completing a consume lands its deposit`
  - `the unconfirmed reconciler landing a consume lands its deposit`

- [ ] **Step 3: Implement the five call sites**

`src/lib/miden/transaction/index.ts:104-109`, current text (unique in the file):

```ts
import type { CandidateRelease } from './reconcile-unconfirmed';
import { bridgeProviderOf } from './retry';
import { canAwaitVerdict } from './verdict-rules';
import { isLikelyNetworkError, isPermanentHttpRejection } from '../activity/connectivity-classify';
import { clearConnectivityIssue, markConnectivityIssue } from '../activity/connectivity-state';
import { importAllNotes } from '../activity/notes';
```

becomes:

```ts
import type { CandidateRelease } from './reconcile-unconfirmed';
import { bridgeProviderOf } from './retry';
import { canAwaitVerdict } from './verdict-rules';
import { adoptLandedConsume } from '../activity/bridge-in';
import { isLikelyNetworkError, isPermanentHttpRejection } from '../activity/connectivity-classify';
import { clearConnectivityIssue, markConnectivityIssue } from '../activity/connectivity-state';
import { importAllNotes } from '../activity/notes';
```

`src/lib/miden/transaction/index.ts:1229-1234`, current text (unique in the file):

```ts
    displayMessage: reclaimed ? 'Reclaimed' : 'Received',
    completedAt: Math.floor(Date.now() / 1000) // seconds
  });
  return true;
}

```

becomes:

```ts
    displayMessage: reclaimed ? 'Reclaimed' : 'Received',
    completedAt: Math.floor(Date.now() / 1000) // seconds
  });
  await adoptLandedConsume(transaction.id);
  return true;
}

```

`src/lib/miden/transaction/index.ts:1470-1474`, current text (unique in the file):

```ts
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        return;
      }
      // An offscreen wedge-kill (deadline / `closeDocument`) surfaces as a
```

becomes:

```ts
          console.warn('[Guardian] could not re-mark Completed (likely already finalized):', markErr);
        }
        if (transaction.type === 'consume') await adoptLandedConsume(transaction.id);
        return;
      }
      // An offscreen wedge-kill (deadline / `closeDocument`) surfaces as a
```

`src/lib/miden/transaction/index.ts:4354-4359`, current text (unique in the file):

```ts
          ...landedRowFields(tx, e),
          completedAt: Math.floor(Date.now() / 1000)
        });
      }
      return false;
    }
```

becomes:

```ts
          ...landedRowFields(tx, e),
          completedAt: Math.floor(Date.now() / 1000)
        });
        if (tx.type === 'consume') await adoptLandedConsume(tx.id);
      }
      return false;
    }
```

`src/lib/miden/transaction/cancel.ts:33-38`, current text (unique in the file):

```ts
  updateTransactionStatus
} from './helper';
import { canAwaitVerdict, upsertEvidenceEntry } from './verdict-rules';
import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed
```

becomes:

```ts
  updateTransactionStatus
} from './helper';
import { canAwaitVerdict, upsertEvidenceEntry } from './verdict-rules';
import { adoptLandedConsume } from '../activity/bridge-in';
import {
  notifyBackgroundTransactionFailed,
  notifyBackgroundTransactionNotConfirmed
```

`src/lib/miden/transaction/cancel.ts:976-981`, current text (unique in the file):

```ts
          completedAt: Math.floor(Date.now() / 1000)
        });
        resolvedCount++;
      } catch (e) {
        // Deliberately not diagnosed as "no longer in progress": the throw is
        // also what a deleted row ('No transaction found to update') and a real
```

becomes:

```ts
          completedAt: Math.floor(Date.now() / 1000)
        });
        resolvedCount++;
        await adoptLandedConsume(tx.id);
      } catch (e) {
        // Deliberately not diagnosed as "no longer in progress": the throw is
        // also what a deleted row ('No transaction found to update') and a real
```

`src/lib/miden/transaction/reconcile-unconfirmed.ts:15-20`, current text (unique in the file):

```ts
import { accountOthers, deferralHolds, judgeSubmitEvidence, RowJudgement } from './reconcile-judge';
import { createNodeReads, NodeReads, observedCadenceMs } from './reconcile-reads';
import { awaitingVerdict, evidenceKey, isCheckable, nowSeconds } from './verdict-rules';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

```

becomes:

```ts
import { accountOthers, deferralHolds, judgeSubmitEvidence, RowJudgement } from './reconcile-judge';
import { createNodeReads, NodeReads, observedCadenceMs } from './reconcile-reads';
import { awaitingVerdict, evidenceKey, isCheckable, nowSeconds } from './verdict-rules';
import { adoptLandedConsume } from '../activity/bridge-in';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import { sameWalletAccountId } from '../sdk/helpers';

```

`src/lib/miden/transaction/reconcile-unconfirmed.ts:137-142`, current text (unique in the file):

```ts
  });
  if (landed === undefined) return false;
  reportVerifiedLanding(landed);
  return true;
}

```

becomes:

```ts
  });
  if (landed === undefined) return false;
  reportVerifiedLanding(landed);
  if (landed.type === 'consume') await adoptLandedConsume(landed.id);
  return true;
}

```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction/consume-landing-adoption.test.ts --maxWorkers=2
```

Expected: PASS, Test Suites: 1 passed, 1 total / Tests:       5 passed, 5 total. Then every suite in the touched directories, since the loop, the Guardian leaf and the reaper are shared:

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/miden/transaction src/lib/miden/activity src/lib/miden/db src/app/hooks --maxWorkers=2
```

Expected: PASS, no failed suite.

- [ ] **Step 5: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/transaction/index.ts src/lib/miden/transaction/cancel.ts src/lib/miden/transaction/reconcile-unconfirmed.ts src/lib/miden/transaction/consume-landing-adoption.test.ts && npx eslint --max-warnings 0 src/lib/miden/transaction/index.ts src/lib/miden/transaction/cancel.ts src/lib/miden/transaction/reconcile-unconfirmed.ts src/lib/miden/transaction/consume-landing-adoption.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && { git diff -U0 -- src/lib/miden/transaction/index.ts src/lib/miden/transaction/cancel.ts src/lib/miden/transaction/reconcile-unconfirmed.ts | grep '^+'; cat src/lib/miden/transaction/consume-landing-adoption.test.ts; } | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 6: Commit (spec commit 4)**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && git add src/lib/miden/db/types.ts src/lib/miden/db/types.test.ts src/lib/miden/activity/bridge-in.ts src/lib/miden/activity/bridge-in.adopt.test.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/complete.bridge-in.test.ts src/lib/miden/transaction/index.ts src/lib/miden/transaction/cancel.ts src/lib/miden/transaction/reconcile-unconfirmed.ts src/lib/miden/transaction/consume-landing-adoption.test.ts && git commit -m "fix(usdcx): adopt a delivered deposit on every consume landing path"
```

---

### Task 13: Name the fee asset in USDCx fee labels (spec commit 5) (p2-fee-labels)

**Key:** `p2-fee-labels`. Runs after Task 12 (`p1-landing-paths`) (commit 4).

**Files:** (origin/main lines)
- Modify: `src/screens/send-flow/Route.tsx` (:6, :12-14, after :91, :131-150)
- Modify: `src/screens/send-flow/ReviewTransaction.tsx` (:8, :28, after :112, :687)
- Modify: `public/_locales/en/en.json` (:4, :17)
- Modify: `public/_locales/en/messages.json` (:10-13, :62-65)
- Test: `src/screens/send-flow/Route.test.tsx` (:6-7, :12-13, :140-142)
- Test: `src/screens/send-flow/ReviewTransaction.test.tsx` (:47, :109-115, :256-259, :430, before :508)

**Interfaces:**
- Consumes: `resolveDisplayMetadata(faucetId: string | undefined, assetsMetadata: Record<string, AssetMetadata> | undefined, nativeFaucetId: string | null): AssetMetadata` (src/lib/miden/metadata/resolve.ts:8-20); `useNativeFeeFaucetId(): string | null` (default export, src/app/hooks/useNativeFeeFaucetId.ts:6); `useWalletStore` (src/lib/store/index.ts), selector `state => state.assetsMetadata`.
- Produces: en `usdcxMidenFees` = `$symbol$ fees` (Route subtitle) and `usdcxSponsorshipFee` = `Paid in $symbol$, including faucet execution sponsorship` (review fee row), each rendered with `{ symbol }` where `symbol = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol` (contract 2.4; p3's `enText` and `readNativeDisplaySymbol` read these). en/messages.json declares `placeholders.symbol` for both. A new non-exported `UsdcxRouteOption` component in Route.tsx now renders the USDCx card and the notice `<p>` that was at :147.

- [ ] **Step 1: Write the failing tests**

`src/screens/send-flow/Route.test.tsx`: after `:6` (`import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';`) add:

```ts
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
```

Replace `:12-13`:

```ts
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
```

with:

```ts
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { symbol?: string }) => (params?.symbol === undefined ? key : `${key}|${params.symbol}`)
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
// The USDCx card names the native fee asset as the wallet resolves it; on testnet that is USDCx.
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'mtst1usdcxnative' }));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { assetsMetadata: Record<string, never> }) => unknown) =>
    selector({ assetsMetadata: {} })
}));
jest.mock('lib/miden/metadata/resolve', () => ({
  resolveDisplayMetadata: jest.fn(() => ({ symbol: 'USDCx', name: 'USDCx', decimals: 6 }))
}));
```

At the end of `describe('RouteOptions', ...)`, replace `:140-142`:

```ts
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });
});
```

with:

```ts
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });

  it('names the native fee asset under the USDCx route, never MIDEN', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        {...UP}
      />
    );

    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxMidenFees|USDCx');
    expect(resolveDisplayMetadata).toHaveBeenCalledWith('mtst1usdcxnative', {}, 'mtst1usdcxnative');
  });
});
```

`src/screens/send-flow/ReviewTransaction.test.tsx`: after `:47` (`let mockBurnPreflight = { minimum: 1n, loading: false, error: undefined };`) add:

```ts
// The native asset's chain metadata; null until a test discovers one, as before discovery.
let mockNativeMetadata: { symbol: string; decimals: number } | null = null;
```

Replace the `t` of the react-i18next mock (:111-113):

```ts
    // The recall note's only parameter is the amount it names; every other key reads as itself.
    t: (key: string, params?: { amount?: string }) =>
      key === 'recallReturnsNote' && params?.amount ? `${key} ${params.amount}` : key
```

with:

```ts
    // The recall note names its amount and a fee label its fee asset; every other key reads as itself.
    t: (key: string, params?: { amount?: string; symbol?: string }) =>
      key === 'recallReturnsNote' && params?.amount
        ? `${key} ${params.amount}`
        : params?.symbol !== undefined
          ? `${key}|${params.symbol}`
          : key
```

In the `lib/miden-chain/native-asset` mock (:256-259) replace:

```ts
  getNativeAssetIdSync: () => 'mtst1usdcxnative'
}));
```

with:

```ts
  getNativeAssetIdSync: () => 'mtst1usdcxnative',
  getNativeAssetMetadataSync: () => mockNativeMetadata
}));
```

In the top-level `beforeEach`, after `:430` (`  mockEpochQuote = { amount: undefined, loading: false, error: null, symbol: 'USDC' };`) add:

```ts
  mockNativeMetadata = null;
```

In `describe('USDCx burn review', ...)`, before `:508` (`  it('rejects a deep link trying to burn a different faucet', async () => {`) add:

```ts
  it('names the native fee asset in the burn fee row, never MIDEN', async () => {
    mockNativeMetadata = { symbol: 'USDCx', decimals: 6 };
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxSponsorshipFee|USDCx')).toBeInTheDocument();
  });

```

Mutation notes: passing `{ symbol: 'MIDEN' }` at the new Route.tsx subtitle fails `names the native fee asset under the USDCx route, never MIDEN`; the same at ReviewTransaction.tsx:687 fails `names the native fee asset in the burn fee row, never MIDEN` (both verified on a scratch copy).

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx --maxWorkers=2
```

Expected: `Tests: 2 failed, 93 passed, 95 total`. Route: `Expected element to have text content: usdcxMidenFees|USDCx Received: usdcxRouteLabelusdcxMidenFees`. Review: `Unable to find an element with the text: usdcxSponsorshipFee|USDCx`.

- [ ] **Step 3: Implement**

`src/screens/send-flow/Route.tsx`, before `:6` (`import { Button, ButtonVariant } from 'components/Button';`) add:

```ts
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
```

Replace `:12-14`:

```ts
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import type { FeatureAvailability } from 'lib/remote-config/availability';
```

with:

```ts
import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hapticLight } from 'lib/mobile/haptics';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { useWalletStore } from 'lib/store';
```

After `:91` (`> & { accent?: FlowAccent; slowStatus: AgglayerEligibility };`) and its blank line, add:

```tsx
/** The USDCx burn's one route card. Its fees are paid in the native asset, so the subtitle names that asset. */
const UsdcxRouteOption: React.FC<Pick<RouteOptionsProps, 'route' | 'onRouteChange'>> = ({ route, onRouteChange }) => {
  const { t } = useTranslation();
  const nativeFaucetId = useNativeFeeFaucetId();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeSymbol = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <ChoiceCardGroup
        items={[
          {
            id: 'usdcx',
            title: t('usdcxRouteLabel'),
            subtitle: t('usdcxMidenFees', { symbol: nativeSymbol }),
            'data-testid': 'bridge-route-usdcx'
          }
        ]}
        value={route === 'usdcx' ? 'usdcx' : null}
        onChange={() => onRouteChange('usdcx')}
        aria-label={t('route')}
      />
      <p className="text-caption text-muted">{t('usdcxWithdrawalNotice')}</p>
    </div>
  );
};

```

Replace `:131-150`:

```tsx
  if (usdcxAvailable) {
    return (
      <div className="mt-6 flex flex-col gap-4">
        <ChoiceCardGroup
          items={[
            {
              id: 'usdcx',
              title: t('usdcxRouteLabel'),
              subtitle: t('usdcxMidenFees'),
              'data-testid': 'bridge-route-usdcx'
            }
          ]}
          value={route === 'usdcx' ? 'usdcx' : null}
          onChange={() => onRouteChange('usdcx')}
          aria-label={t('route')}
        />
        <p className="text-caption text-muted">{t('usdcxWithdrawalNotice')}</p>
      </div>
    );
  }
```

with:

```tsx
  if (usdcxAvailable) {
    return <UsdcxRouteOption route={route} onRouteChange={onRouteChange} />;
  }
```

(The hooks live in the child so the Fast/Slow paths and their tests never read the store.)

`src/screens/send-flow/ReviewTransaction.tsx`, after `:7` (`import { useAppEnv } from 'app/env';`) add:

```ts
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
```

After `:28` (`import { zustandProvider } from 'lib/miden/front/guardian-sync';`) add:

```ts
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
```

After `:112` (`  const tokenLabel = token ? midenTokenLabel(bridgeConfig, token.id, token.name) : '';`) add:

```ts
  // A burn's fee and the faucet's sponsorship are paid in the native asset, whatever it is on this network.
  const nativeFaucetId = useNativeFeeFaucetId();
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const nativeSymbol = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol;
```

`:687`, before:

```tsx
                  <DetailRow label={t('networkFee')}>{t('usdcxSponsorshipFee')}</DetailRow>
```

after:

```tsx
                  <DetailRow label={t('networkFee')}>{t('usdcxSponsorshipFee', { symbol: nativeSymbol })}</DetailRow>
```

`public/_locales/en/en.json` (edit by hand, never prettier), `:4`, before / after:

```json
  "usdcxMidenFees": "MIDEN fees",
```

```json
  "usdcxMidenFees": "$symbol$ fees",
```

`:17`, before / after:

```json
  "usdcxSponsorshipFee": "Paid in MIDEN, including sponsorship of the execution by the faucet",
```

```json
  "usdcxSponsorshipFee": "Paid in $symbol$, including faucet execution sponsorship",
```

`public/_locales/en/messages.json` (by hand), `:10-13`, before:

```json
  "usdcxMidenFees": {
    "message": "MIDEN fees",
    "englishSource": "MIDEN fees"
  },
```

after:

```json
  "usdcxMidenFees": {
    "message": "$symbol$ fees",
    "englishSource": "$symbol$ fees",
    "placeholders": {
      "symbol": {
        "content": "$1"
      }
    }
  },
```

`:62-65` (`:67-70` after the edit above), before:

```json
  "usdcxSponsorshipFee": {
    "message": "Paid in MIDEN, including sponsorship of the execution by the faucet",
    "englishSource": "Paid in MIDEN, including sponsorship of the execution by the faucet"
  },
```

after:

```json
  "usdcxSponsorshipFee": {
    "message": "Paid in $symbol$, including faucet execution sponsorship",
    "englishSource": "Paid in $symbol$, including faucet execution sponsorship",
    "placeholders": {
      "symbol": {
        "content": "$1"
      }
    }
  },
```

`node -e "JSON.parse(require('fs').readFileSync('public/_locales/en/en.json','utf8'));JSON.parse(require('fs').readFileSync('public/_locales/en/messages.json','utf8'))"` exits 0.

- [ ] **Step 4: Run the tests, the whole directory and the i18n gates**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/screens/send-flow --maxWorkers=2
yarn jest src/lib/i18n/key-coverage.test.ts src/lib/i18n/locale-bundle-parity.test.ts --maxWorkers=2
```

Expected: `src/screens/send-flow` 20 suites pass, 0 failed. `key-coverage.test.ts` passes, and the `Chrome i18n placeholder declarations` cases pass for every locale. `locale-bundle-parity.test.ts` fails exactly 26 cases until CI's DeepL pass commits translations back (expected, do not "fix" other locales by hand): `es locale parity with en (#469) > preserves each key's placeholder set...`, `<loc> translates every shipped English key it has a current translation for` for the 12 runtime locales, and `<loc>.json is the current-translation flatten of messages.json` for those 12 plus en_GB. No other i18n test may fail.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx && npx eslint --max-warnings 0 src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx
```

Expected: eslint exits 0. Never run prettier on `public/_locales`.

- [ ] **Step 6: Commit**

```bash
git add src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx public/_locales/en/en.json public/_locales/en/messages.json
git diff --cached --name-only | wc -l   # 6
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0 (control: printf '\xe2\x80\x94\n' | LC_ALL=C grep -c -e $'\xe2\x80\x94' prints 1)
git commit -m "fix(usdcx): name the fee asset in USDCx fee labels"
```

---

### Task 14: Show each USDCx deposit source's own arrival time (spec commit 6) (p2-arrival)

**Key:** `p2-arrival`. Runs after Task 13 (`p2-fee-labels`).

**Files:** (origin/main lines; after `p2-screen-recipient` the screen's lines below :63 sit one earlier, and messages.json lines sit 10 later after `p2-fee-labels`; match on text)
- Modify: `src/lib/usdcx/constant.ts` (before :276)
- Modify: `src/app/templates/EvmConnectModal/EvmBridgeDepositReview.tsx` (:12, :30-31, :78, :93-94)
- Modify: `src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.tsx` (:6-7, :16-17, :30-32, :47)
- Modify: `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx` (:1243, :1259, :1332)
- Modify: `public/_locales/en/en.json` (after :1093), `public/_locales/en/messages.json` (after :4763-4766)
- Test: `src/lib/usdcx/constant.test.ts` (:21, before `describe('USDCx per-chain contracts'` at :150)
- Test: `src/app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx` (after :140)
- Test (new): `src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.test.tsx`
- Test: `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx` (Review mock :175-199, route mock :247-264, end of describe)

**Interfaces:**
- Consumes: `ARC_TESTNET` (src/lib/walletconnect/config.ts, imported at constant.ts:4); `sourceChainId` (EvmBridgeDepositScreen.tsx:1076, `route === 'usdcx' ? usdcxSource.chain.id : DEFAULT_CHAIN_ID`).
- Produces:
  - `export function usdcxArrivalKey(sourceChainId: number): 'usdcxArrivalArc' | 'usdcxArrival'` in `src/lib/usdcx/constant.ts`.
  - `EvmBridgeDepositReviewProps.sourceChainId?: number` (route `usdcx` reads `usdcxArrivalKey(sourceChainId)`, `usdcxArrival` when absent).
  - `EvmBridgeUsdcxRouteProps.sourceChainId: number` (required; the card's `eta`).
  - The screen passes `sourceChainId={sourceChainId}` to both.
  - en key `usdcxArrivalArc` = `~1 min`; `usdcxArrival` stays `~20 min`.

- [ ] **Step 1: Write the failing tests**

`src/lib/usdcx/constant.test.ts`: in the import list, after `  USDCX_SOURCE_CHAINS,` (:21) add `  usdcxArrivalKey,`. Before `describe('USDCx per-chain contracts', () => {` (:150) add:

```ts
describe('USDCx deposit arrival estimate', () => {
  // Circle attests an Arc deposit in seconds and the relayer mints within a minute.
  it('reads about a minute for a deposit from Arc Testnet', () => {
    expect(usdcxArrivalKey(ARC_TESTNET_ID)).toBe('usdcxArrivalArc');
  });

  it.each([sepolia.id, baseSepolia.id, arbitrumSepolia.id, arc.id, mainnet.id])(
    'reads ~20 min for a deposit from chain %i',
    chainId => {
      expect(usdcxArrivalKey(chainId)).toBe('usdcxArrival');
    }
  );
});

```

`src/app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx`: after the test `labels the Circle xReserve route "USDCx" with its arrival estimate` (:137-140) add:

```tsx

    it('reads about a minute for a USDCx deposit from Arc Testnet', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'usdcx', sourceChainId: 5042002 })} />);
      expect(screen.getByText('usdcxRouteName usdcxArrivalArc')).toBeInTheDocument();
    });

    it.each([11155111, 84532, 421614])('reads ~20 min for a USDCx deposit from chain %i', sourceChainId => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'usdcx', sourceChainId })} />);
      expect(screen.getByText('usdcxRouteName usdcxArrival')).toBeInTheDocument();
    });

    it('keeps the Fast estimate whatever the source chain', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'epoch', sourceChainId: 5042002 })} />);
      expect(screen.getByText('fast fastArrival')).toBeInTheDocument();
    });
```

Create `src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.test.tsx`:

```tsx
import React from 'react';

import { render, screen } from '@testing-library/react';

import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// RouteCard has its own suite; this one checks the estimate the step hands it.
jest.mock('screens/send-flow/Route', () => ({
  RouteCard: ({ eta, testId }: { eta: string; testId?: string }) => <div data-testid={testId}>{eta}</div>
}));

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({
    title,
    onClick,
    'data-testid': testId
  }: {
    title: string;
    onClick: () => void;
    'data-testid'?: string;
  }) => (
    <button type="button" onClick={onClick} data-testid={testId}>
      {title}
    </button>
  )
}));

describe('EvmBridgeUsdcxRoute', () => {
  it('reads about a minute for a deposit from Arc Testnet', () => {
    render(<EvmBridgeUsdcxRoute sourceChainId={5042002} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxArrivalArc');
  });

  it.each([11155111, 84532, 421614])('reads ~20 min for a deposit from chain %i', sourceChainId => {
    render(<EvmBridgeUsdcxRoute sourceChainId={sourceChainId} onConfirm={jest.fn()} />);
    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent(/^usdcxArrival$/);
  });
});
```

`EvmBridgeDepositScreen.usdcx.test.tsx`: in the `./EvmBridgeDepositReview` mock (:175-199) replace:

```tsx
      route,
      fee
    }: {
      onConfirm: () => void;
      symbol: string;
      label?: string;
      route: Parameters<typeof actual.arrivingTokenName>[0];
      fee?: string;
    }) => (
      <div>
        {fee && <span data-testid="review-fee">{fee}</span>}
```

with:

```tsx
      route,
      fee,
      sourceChainId
    }: {
      onConfirm: () => void;
      symbol: string;
      label?: string;
      route: Parameters<typeof actual.arrivingTokenName>[0];
      fee?: string;
      sourceChainId?: number;
    }) => (
      <div>
        {fee && <span data-testid="review-fee">{fee}</span>}
        <span data-testid="review-source">{String(sourceChainId)}</span>
```

In the `./EvmBridgeUsdcxRoute` mock (:247-264) replace:

```tsx
    onConfirm,
    fee
  }: {
    confirmDisabled?: boolean;
    onConfirm: () => void;
    fee?: string;
  }) => (
    <div>
      {fee && <span data-testid="usdcx-route-fee">{fee}</span>}
```

with:

```tsx
    onConfirm,
    fee,
    sourceChainId
  }: {
    confirmDisabled?: boolean;
    onConfirm: () => void;
    fee?: string;
    sourceChainId: number;
  }) => (
    <div>
      {fee && <span data-testid="usdcx-route-fee">{fee}</span>}
      <span data-testid="usdcx-route-source">{String(sourceChainId)}</span>
```

Before the describe's closing `});` (after the `quotes and burns an executor deposit for the recipient usdcxRemoteRecipientFor derives` test from Task 6 (`p2-screen-recipient`)) add:

```tsx

  // Each source has its own arrival estimate, so the route card and the review are told which chain the deposit leaves.
  it('hands the Arc Testnet source to the route card and the review', async () => {
    renderScreen();
    await reachUsdcxRoute();
    expect(screen.getByTestId('usdcx-route-source')).toHaveTextContent('5042002');
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-source')).toHaveTextContent('5042002');
  });

  it('hands an executor source to the route card and the review', async () => {
    renderScreen();
    await reachBaseSepoliaRoute();
    expect(screen.getByTestId('usdcx-route-source')).toHaveTextContent('84532');
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-source')).toHaveTextContent('84532');
  });
```

Mutation notes: returning `'usdcxArrival'` unconditionally from `usdcxArrivalKey` fails `reads about a minute for a deposit from Arc Testnet` (constant, review and route suites); passing `DEFAULT_CHAIN_ID` instead of `sourceChainId` to `EvmBridgeUsdcxRoute` fails both `hands ... source` screen tests (verified on a scratch copy).

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx/constant.test.ts src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.test.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx --maxWorkers=2
```

Expected: `Tests: 10 failed`; constant fails with `TypeError: (0 , _constant.usdcxArrivalKey) is not a function` (6 cases), the route and review Arc cases fail on the `usdcxArrivalArc` text, and the two screen cases fail on `usdcx-route-source` (empty text content).

- [ ] **Step 3: Implement**

`src/lib/usdcx/constant.ts`, before `:276` (`/** The source chain a bridge-in starts from until the screen offers a picker. */`) add:

```ts
/**
 * The i18n key of a USDCx deposit's arrival time for its source chain: Arc Testnet reads ~1 min, every other source
 * ~20 min. On Arc, Circle attests the deposit in seconds and the relayer mints within a minute.
 */
export function usdcxArrivalKey(sourceChainId: number): 'usdcxArrivalArc' | 'usdcxArrival' {
  return sourceChainId === ARC_TESTNET.id ? 'usdcxArrivalArc' : 'usdcxArrival';
}

```

`EvmBridgeDepositReview.tsx:12`, before / after:

```ts
import { USDCX_SYMBOL } from 'lib/usdcx/constant';
```

```ts
import { USDCX_SYMBOL, usdcxArrivalKey } from 'lib/usdcx/constant';
```

After `:30-31` (`  /** Source network name (e.g. Sepolia). */` / `  networkName: string;`) add:

```ts
  /** Source chain id; on the USDCx route it picks the arrival estimate (`usdcxArrivalKey`). */
  sourceChainId?: number;
```

After `:78` (`  networkName,` in the destructuring) add `  sourceChainId,`. Replace `:93-94`:

```ts
      case 'usdcx':
        return { routeLabel: t('usdcxRouteName'), arrivalLabel: t('usdcxArrival') };
```

with:

```ts
      case 'usdcx':
        return {
          routeLabel: t('usdcxRouteName'),
          arrivalLabel: t(sourceChainId === undefined ? 'usdcxArrival' : usdcxArrivalKey(sourceChainId))
        };
```

`EvmBridgeUsdcxRoute.tsx`, after `:6` (`import { Button, ButtonVariant } from 'components/Button';`) add:

```ts
import { usdcxArrivalKey } from 'lib/usdcx/constant';
```

After `:16-17` (the `fee?: string;` prop and its doc line) add:

```ts
  /** The deposit's source chain, which sets the card's arrival estimate. */
  sourceChainId: number;
```

After `:30` (`  fee,` in the destructuring) add `  sourceChainId,`. `:47`, before / after:

```tsx
            eta={t('usdcxArrival')}
```

```tsx
            eta={t(usdcxArrivalKey(sourceChainId))}
```

`EvmBridgeDepositScreen.tsx`: after `:1243` (`              networkName={networkName}` inside `<EvmBridgeDepositReview`) add:

```tsx
              sourceChainId={sourceChainId}
```

After `:1259` (`                onConfirm={handleContinueToReview}` inside `<EvmBridgeUsdcxRoute`) add:

```tsx
                sourceChainId={sourceChainId}
```

In the `renderStep` dependency list, after `:1332` (`      networkName,`) add `      sourceChainId,`.

`public/_locales/en/en.json`, after `:1093` (`  "usdcxArrival": "~20 min",`) add:

```json
  "usdcxArrivalArc": "~1 min",
```

`public/_locales/en/messages.json`, after the `usdcxArrival` entry (@main :4763-4766, :4773-4776 after Task 13 (`p2-fee-labels`)):

```json
  "usdcxArrival": {
    "message": "~20 min",
    "englishSource": "~20 min"
  },
```

add:

```json
  "usdcxArrivalArc": {
    "message": "~1 min",
    "englishSource": "~1 min"
  },
```

Both JSON files must still parse (same `node -e` check as Task 13 (`p2-fee-labels`)).

- [ ] **Step 4: Run the tests, the whole directories and the i18n gates**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx src/app/templates/EvmConnectModal --maxWorkers=2
yarn jest src/lib/i18n/key-coverage.test.ts src/lib/i18n/locale-bundle-parity.test.ts --maxWorkers=2
```

Expected: every suite in both directories passes, 0 failed. `locale-bundle-parity.test.ts` now fails 27 cases until CI translates: Task 13 (`p2-fee-labels`)'s 26 plus `es locale parity with en (#469) > has a Spanish entry for every shipped English key (no English fallback)` (the new `usdcxArrivalArc`). `key-coverage.test.ts` passes.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositReview.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.tsx src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.test.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx && npx eslint --max-warnings 0 src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositReview.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.tsx src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.test.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx
```

Expected: eslint exits 0 (react-hooks/exhaustive-deps is satisfied by the new `sourceChainId` dependency).

- [ ] **Step 6: Commit**

```bash
git add src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositReview.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositReview.test.tsx src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.tsx src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute.test.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx public/_locales/en/en.json public/_locales/en/messages.json
git diff --cached --name-only | wc -l   # 10
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0
git commit -m "fix(usdcx): show each USDCx deposit source's own arrival time"
```

---

### Task 15: Keep a stranded executor leg executable (p1-executor-stall)

Spec 10(f), Q11. The Execute button renders only in `delivering` with no saved hash (UsdcxExecuteAction.tsx:57,62-68); a saved hash that never mines reads `pending` forever (walletconnect/receipt.ts:37-48; bridge-receive.ts:160-171), and the 7-day cutoff then failed the row while the message could still be executed (`failed -> delivering` is refused, complete.ts:1546-1548). Now:
- `updateBridgedReceivePhase` stamps `cctp.executeSavedAt` (Unix seconds) whenever a write sets an execute hash different from the row's, from either side.
- The reconciler reopens a leg whose hash still reads `pending` after `USDCX_EXECUTE_STALL_SEC` (30 min, the bounded window Q11 asks for), but only when the leg holds the message and attestation, so the Execute button can return; a hash saved before the stamp is timed from `initiatedAt`. The reopen keeps the message and proof, clears the hash and its stamp, and records `stalledExecuteTxHash`; like the revert reopen it lands only while the row still holds that hash.
- A reopened leg keeps asking xReserve about the stalled hash, so a late mine still reaches `ready`, and Iris's forward hash equal to it is never adopted again (otherwise a forward leg would reopen and re-adopt every 30 min).
- An executor row in `delivering` that holds an attested message and no saved execute hash is exempt from the 7-day failure, and one with a saved hash counts its week from `cctp.executeSavedAt`: a hash that mined but whose deposit Circle attests to something else never reopens (only a pending one stalls) and only warns (Q10), so without that week the row would stay `delivering`, and be polled, forever. A second execute of a message that already landed reverts on Arc, so nothing mints twice.
No live suite runs this leg (Q4), so unit tests carry it.

**Files:**
- Modify: `src/lib/miden/db/types.ts` (`IUsdcxCctpLeg`, :146-162), `src/lib/usdcx/cctp.ts`, `src/lib/miden/transaction/complete.ts`, `src/lib/miden/activity/bridge-receive.ts`
- Test: `src/lib/usdcx/cctp.test.ts`, `src/lib/miden/transaction/bridged-receive-phase.test.ts`, `src/lib/miden/activity/bridge-receive.test.ts`

**Interfaces:**
- Consumes: `readEvmReceiptOutcome(hash: Hash, chain: Chain): Promise<'success' | 'reverted' | 'pending'>` (receipt.ts:37), `isUsdcxExecutorSource(chainId: number | undefined): boolean` (constant.ts:302), `revertedExecuteLeg` (cctp.ts:116), `matchUsdcxDeposit` (Task 7, p1-reconciler-match).
- Produces:
  - `IUsdcxCctpLeg.executeSavedAt?: number` (stamped by `updateBridgedReceivePhase`) and `IUsdcxCctpLeg.stalledExecuteTxHash?: string`
  - `export const USDCX_EXECUTE_STALL_SEC = 30 * 60` (cctp.ts)
  - module-private `cutoffStart(row: ITransaction, inputs: IBridgedReceiveExtraInputs): number` (bridge-receive.ts): a ready row's week from `readyAt`, a saved execute's from `cctp.executeSavedAt`, else from `initiatedAt`
  - `stalledExecuteLeg(sourceDomain: number, hash: string): IUsdcxCctpLeg` (cctp.ts): `{ sourceDomain, executeTxHash: undefined, executeSavedAt: undefined, stalledExecuteTxHash: hash }`
  - `revertedExecuteLeg(sourceDomain: number, hash: string): IUsdcxCctpLeg` now also clears `executeSavedAt`.

Two existing `toEqual` assertions on a saved execute leg (bridged-receive-phase.test.ts, 'keeps the message, the proof and the forward when the execute hash is saved' and 'lets a manual execute replace an adopted forward hash') gain `executeSavedAt: expect.any(Number)`; they fail first too.

- [ ] **Step 1: Write the failing tests**

`src/lib/usdcx/cctp.test.ts:3-9`, current text (unique in the file):

```ts
  fetchAttestedCctpMessage,
  fetchCctpBurnQuote,
  fetchCctpMessages,
  isCctpForwardFailed
} from './cctp';

const fetchMock = jest.fn();
```

becomes:

```ts
  fetchAttestedCctpMessage,
  fetchCctpBurnQuote,
  fetchCctpMessages,
  isCctpForwardFailed,
  revertedExecuteLeg,
  stalledExecuteLeg
} from './cctp';

const fetchMock = jest.fn();
```

`src/lib/usdcx/cctp.test.ts:123-128`, current text (unique in the file):

```ts
  });
});

describe('fetchCctpBurnQuote', () => {
  const options = {
    baseUrl: BASE_URL,
```

becomes:

```ts
  });
});

// A stalled execute leaves the message, so the Execute button returns; a reverted one also drops the proof, which the
// reconciler reads again from Iris. Either clears the hash and its saved time.
describe('reopened execute legs', () => {
  it('keeps the message and proof of a stalled execute and remembers its hash', () => {
    expect(stalledExecuteLeg(6, TX_HASH)).toEqual({
      sourceDomain: 6,
      executeTxHash: undefined,
      executeSavedAt: undefined,
      stalledExecuteTxHash: TX_HASH
    });
  });

  it('drops the message and proof of a reverted execute and remembers its hash', () => {
    expect(revertedExecuteLeg(6, TX_HASH)).toEqual({
      sourceDomain: 6,
      executeTxHash: undefined,
      executeSavedAt: undefined,
      message: undefined,
      attestation: undefined,
      forwarded: false,
      revertedExecuteTxHash: TX_HASH
    });
    expect(Object.keys(revertedExecuteLeg(6, TX_HASH))).toContain('executeSavedAt');
  });
});

describe('fetchCctpBurnQuote', () => {
  const options = {
    baseUrl: BASE_URL,
```

`src/lib/miden/transaction/bridged-receive-phase.test.ts:1-6`, current text (unique in the file):

```ts
import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs, IBridgedReceivePhase } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { revertedExecuteLeg } from 'lib/usdcx/cctp';

import { updateBridgedReceivePhase } from './complete';

```

becomes:

```ts
import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs, IBridgedReceivePhase } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { revertedExecuteLeg, stalledExecuteLeg } from 'lib/usdcx/cctp';

import { updateBridgedReceivePhase } from './complete';

```

`src/lib/miden/transaction/bridged-receive-phase.test.ts:130-136`, current text (unique in the file):

```ts

    await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H1 });
  });

  it('reopens the execute it saw revert, clearing its hash and proof', async () => {
```

becomes:

```ts

    await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({
      ...held,
      executeTxHash: H1,
      executeSavedAt: expect.any(Number)
    });
  });

  it('reopens the execute it saw revert, clearing its hash and proof', async () => {
```

`src/lib/miden/transaction/bridged-receive-phase.test.ts:167-173`, current text (unique in the file):

```ts

    await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H1 });
  });

  it('accepts the same execute hash written again', async () => {
```

becomes:

```ts

    await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({
      ...held,
      executeTxHash: H1,
      executeSavedAt: expect.any(Number)
    });
  });

  it('accepts the same execute hash written again', async () => {
```

`src/lib/miden/transaction/bridged-receive-phase.test.ts:184-189`, current text (unique in the file):

```ts
    });
  });

  it('keeps a newer execute hash saved after the revert was observed', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

```

becomes:

```ts
    });
  });

  // The stall window runs from when the current hash was saved, whichever side saved it.
  it('stamps the time an execute hash is saved, and only when the hash changes', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);
    try {
      const id = await seed('delivering', { cctp: held });

      await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H1 } });
      nowSpy.mockReturnValue(2_000_000_000);
      await updateBridgedReceivePhase(id, 'delivering', {
        cctp: { sourceDomain: 6, executeTxHash: H1, forwardState: 'COMPLETE' }
      });
      expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeSavedAt).toBe(1_000_000);

      await updateBridgedReceivePhase(id, 'delivering', { cctp: { sourceDomain: 6, executeTxHash: H2 } });
      expect((await Repo.transactions.get(id))?.extraInputs.cctp?.executeSavedAt).toBe(2_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reopens a stalled execute keeping its message and proof, and remembers the hash', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H1, executeSavedAt: 5 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: stalledExecuteLeg(6, H1) });

    const cctp = (await Repo.transactions.get(id))?.extraInputs.cctp;
    expect(cctp).toMatchObject({ ...held, stalledExecuteTxHash: H1 });
    expect(cctp?.executeTxHash).toBeUndefined();
    expect(cctp?.executeSavedAt).toBeUndefined();
  });

  it('keeps a newer execute hash saved after the stall was observed', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

    await updateBridgedReceivePhase(id, 'delivering', { cctp: stalledExecuteLeg(6, H1) });

    expect((await Repo.transactions.get(id))?.extraInputs.cctp).toEqual({ ...held, executeTxHash: H2 });
  });

  it('keeps a newer execute hash saved after the revert was observed', async () => {
    const id = await seed('delivering', { cctp: { ...held, executeTxHash: H2 } });

```

`src/lib/miden/activity/bridge-receive.test.ts:1092-1097`, current text (unique in the file):

```ts
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('never adopts a reverted forward again and offers the execute with the attested message', async () => {
    fetchAttestedMessage.mockResolvedValue({
      message: '0x1234',
```

becomes:

```ts
    expect(updatePhase).not.toHaveBeenCalled();
  });

  // A saved hash that never mines reads pending forever: past the stall window the Execute button comes back, with
  // the message the leg still holds, and xReserve is still asked about the stalled hash.
  describe('an execute that never mines', () => {
    const NOW_SEC = Math.floor(Date.now() / 1000);
    const held = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH };
    const stalledLeg = {
      sourceDomain: 6,
      executeTxHash: undefined,
      executeSavedAt: undefined,
      stalledExecuteTxHash: EXECUTE_HASH
    };

    it('reopens the execute once the hash has been pending for the stall window', async () => {
      rows.push(executorRow({ ...held, executeSavedAt: NOW_SEC - 31 * 60 }));

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledTimes(1);
      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', { cctp: stalledLeg });
    });

    it('waits while the hash is younger than the stall window', async () => {
      rows.push(executorRow({ ...held, executeSavedAt: NOW_SEC - 29 * 60 }));

      await reconcileBridgedReceives();

      expect(updatePhase).not.toHaveBeenCalled();
    });

    it('times a hash saved before the stamp from the deposit', async () => {
      rows.push({ ...executorRow(held), initiatedAt: NOW_SEC - 31 * 60 });

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', { cctp: stalledLeg });
    });

    it('never reopens a leg that holds no message to execute', async () => {
      rows.push(executorRow({ sourceDomain: 6, executeTxHash: EXECUTE_HASH, executeSavedAt: NOW_SEC - 31 * 60 }));

      await reconcileBridgedReceives();

      expect(updatePhase).not.toHaveBeenCalled();
    });

    it('lands the row when the stalled execute mines after all', async () => {
      matchAttestation.mockReturnValue({ kind: 'attested' });
      rows.push(
        executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', stalledExecuteTxHash: EXECUTE_HASH })
      );

      await reconcileBridgedReceives();

      expect(fetchAttestations).toHaveBeenCalledWith(EXECUTE_HASH, { baseUrl: ATTESTATIONS });
      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'ready');
    });

    it('never adopts a stalled forward again', async () => {
      fetchAttestedMessage.mockResolvedValue({
        message: '0x1234',
        attestation: '0xabcd',
        forwardState: 'COMPLETE',
        forwardTxHash: EXECUTE_HASH
      });
      rows.push(
        executorRow({
          sourceDomain: 6,
          forwarded: true,
          forwardState: 'FAILED',
          message: '0x1234',
          attestation: '0xabcd',
          stalledExecuteTxHash: EXECUTE_HASH
        })
      );

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledTimes(1);
      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
        cctp: { sourceDomain: 6, forwardState: 'COMPLETE' }
      });
    });
  });

  // An attested message on Arc can be executed at any time: failing the row would hide the button that recovers it.
  it('never times out an executor row that holds a message to execute', async () => {
    rows.push({
      ...executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('still times out an executor row whose burn Circle never attested', async () => {
    rows.push({ ...executorRow({ sourceDomain: 6 }), initiatedAt: WEEK_AGO_SEC });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'failed', { error: 'Bridge delivery timed out.' });
  });

  // An execute that mined but whose deposit Circle attests to something else never reopens: without a week from its
  // save, the row would stay delivering, and be polled, forever.
  it('times out an executor row a week after its execute hash was saved', async () => {
    readOutcome.mockResolvedValue('success');
    matchAttestation.mockReturnValue({ kind: 'mismatch', field: 'recipient' });
    rows.push({
      ...executorRow({
        sourceDomain: 6,
        message: '0x1234',
        attestation: '0xabcd',
        executeTxHash: EXECUTE_HASH,
        executeSavedAt: WEEK_AGO_SEC
      }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'failed', { error: 'Bridge delivery timed out.' });
  });

  it('keeps an old executor deposit whose execute hash was saved this week', async () => {
    rows.push({
      ...executorRow({
        sourceDomain: 6,
        message: '0x1234',
        attestation: '0xabcd',
        executeTxHash: EXECUTE_HASH,
        executeSavedAt: Math.floor(Date.now() / 1000) - 60
      }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('never adopts a reverted forward again and offers the execute with the attested message', async () => {
    fetchAttestedMessage.mockResolvedValue({
      message: '0x1234',
```

Mutation notes:
- Dropping `executeSavedAt: undefined` from `revertedExecuteLeg` fails its key assertion; dropping the stamp in the writer fails 'stamps the time an execute hash is saved, and only when the hash changes'; dropping `?? extra?.cctp?.stalledExecuteTxHash` from `reopened` fails 'keeps a newer execute hash saved after the stall was observed'.
- Removing the `outcome === 'pending' && executeStalled(...)` branch fails 'reopens the execute once the hash has been pending for the stall window'; timing a stamp-less hash from now instead of `row.initiatedAt` fails 'times a hash saved before the stamp from the deposit'; dropping the message guard in `executeStalled` fails 'never reopens a leg that holds no message to execute'.
- Removing the stalled-hash attestation check fails 'lands the row when the stalled execute mines after all'; leaving `leg.stalledExecuteTxHash` out of `forwardRefused` fails 'never adopts a stalled forward again'; removing `!holdsExecutableMessage(inputs)` from the cutoff fails 'never times out an executor row that holds a message to execute'.
- Dropping `inputs.cctp.executeTxHash === undefined` from `holdsExecutableMessage` fails 'times out an executor row a week after its execute hash was saved' (the row warns and stays delivering); returning `row.initiatedAt` from `cutoffStart` for a row with a saved hash fails 'keeps an old executor deposit whose execute hash was saved this week'. In the red run of Step 2 the first of these passes (today's cutoff already fails that row) and the second fails.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/cctp.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-receive.test.ts --maxWorkers=2
```

Expected: FAIL, Test Suites: 3 failed, 3 total / Tests:       13 failed, 95 passed, 108 total:
  - `reconcileBridgedReceives with a USDCx executor row › an execute that never mines › lands the row when the stalled execute mines after all`
  - `reconcileBridgedReceives with a USDCx executor row › an execute that never mines › never adopts a stalled forward again`
  - `reconcileBridgedReceives with a USDCx executor row › an execute that never mines › reopens the execute once the hash has been pending for the stall window`
  - `reconcileBridgedReceives with a USDCx executor row › an execute that never mines › times a hash saved before the stamp from the deposit`
  - `reconcileBridgedReceives with a USDCx executor row › keeps an old executor deposit whose execute hash was saved this week`
  - `reconcileBridgedReceives with a USDCx executor row › never times out an executor row that holds a message to execute`
  - `reopened execute legs › drops the message and proof of a reverted execute and remembers its hash`
  - `reopened execute legs › keeps the message and proof of a stalled execute and remembers its hash`
  - `updateBridgedReceivePhase on a USDCx CCTP leg › keeps a newer execute hash saved after the stall was observed`
  - `updateBridgedReceivePhase on a USDCx CCTP leg › keeps the message, the proof and the forward when the execute hash is saved`
  - `updateBridgedReceivePhase on a USDCx CCTP leg › lets a manual execute replace an adopted forward hash`
  - `updateBridgedReceivePhase on a USDCx CCTP leg › reopens a stalled execute keeping its message and proof, and remembers the hash`
  - `updateBridgedReceivePhase on a USDCx CCTP leg › stamps the time an execute hash is saved, and only when the hash changes`

- [ ] **Step 3: Implement**

`src/lib/miden/db/types.ts:160-165`, current text (unique in the file):

```ts
  attestation?: string;
  /** The Arc transaction that executed the message, which is the xReserve deposit Circle attests. */
  executeTxHash?: string;
  /** An Arc execute, the wallet's or Circle's forward, that reverted; never adopted again as the execute. */
  revertedExecuteTxHash?: string;
  /** Whether the burn paid Circle's forward fee, so Circle executes on Arc; absent on rows before the fee flow. */
```

becomes:

```ts
  attestation?: string;
  /** The Arc transaction that executed the message, which is the xReserve deposit Circle attests. */
  executeTxHash?: string;
  /** Unix seconds the current `executeTxHash` was saved, from either side. */
  executeSavedAt?: number;
  /** An Arc execute that stayed unmined past the stall window: never adopted again, still asked about. */
  stalledExecuteTxHash?: string;
  /** An Arc execute, the wallet's or Circle's forward, that reverted; never adopted again as the execute. */
  revertedExecuteTxHash?: string;
  /** Whether the burn paid Circle's forward fee, so Circle executes on Arc; absent on rows before the fee flow. */
```

`src/lib/usdcx/cctp.ts:117-127`, current text (unique in the file):

```ts
  return {
    sourceDomain,
    executeTxHash: undefined,
    message: undefined,
    attestation: undefined,
    forwarded: false,
    revertedExecuteTxHash: hash
  };
}

/** A signed fee quote from Iris `POST /v2/quote/burn/usdc/{source}/{destination}`. */
```

becomes:

```ts
  return {
    sourceDomain,
    executeTxHash: undefined,
    executeSavedAt: undefined,
    message: undefined,
    attestation: undefined,
    forwarded: false,
    revertedExecuteTxHash: hash
  };
}

/** How long an Arc execute may stay unmined before the wallet offers the execute again. */
export const USDCX_EXECUTE_STALL_SEC = 30 * 60;

/**
 * The CCTP leg after the Arc execute `hash` stayed unmined for `USDCX_EXECUTE_STALL_SEC`: the message and proof
 * stay, so the wallet can execute again, and `hash` is never adopted as the execute again. A second execute of a
 * message that already landed reverts on Arc, so the message is never minted twice.
 */
export function stalledExecuteLeg(sourceDomain: number, hash: string): IUsdcxCctpLeg {
  return { sourceDomain, executeTxHash: undefined, executeSavedAt: undefined, stalledExecuteTxHash: hash };
}

/** A signed fee quote from Iris `POST /v2/quote/burn/usdc/{source}/{destination}`. */
```

`src/lib/miden/transaction/complete.ts:1538-1549`, current text (unique in the file):

```ts
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    if (!canMoveBridgedReceivePhase(inputs?.phase, phase)) return;
    // A reopen clears only the Arc execute it saw revert: a newer execute saved meanwhile, with its proof, stands.
    const reopened = extra?.cctp?.revertedExecuteTxHash;
    if (reopened !== undefined && inputs?.cctp?.executeTxHash !== reopened) return;
    if (onlyIfNoExecuteHash && inputs?.cctp?.executeTxHash !== undefined) return;
    // The CCTP leg is written a field at a time (the burn's domain, then the attestation, then the
    // execute hash), so a write merges into what the row holds instead of replacing it.
    const cctp = extra?.cctp ? { ...inputs?.cctp, ...extra.cctp } : inputs?.cctp;
    // Unlike the earn-withdraw writer there is no monotonic guard here, so the
    // only thing keeping one bridge from reporting twice is comparing against
```

becomes:

```ts
  await Repo.transactions.where({ id }).modify(tx => {
    const inputs: IBridgedReceiveExtraInputs | undefined = tx.extraInputs;
    if (!canMoveBridgedReceivePhase(inputs?.phase, phase)) return;
    // A reopen clears only the Arc execute it saw revert or stall: a newer execute saved meanwhile, with its proof,
    // stands.
    const reopened = extra?.cctp?.revertedExecuteTxHash ?? extra?.cctp?.stalledExecuteTxHash;
    if (reopened !== undefined && inputs?.cctp?.executeTxHash !== reopened) return;
    if (onlyIfNoExecuteHash && inputs?.cctp?.executeTxHash !== undefined) return;
    const nowSec = Math.floor(Date.now() / 1000);
    // The CCTP leg is written a field at a time (the burn's domain, then the attestation, then the
    // execute hash), so a write merges into what the row holds instead of replacing it.
    const merged = extra?.cctp ? { ...inputs?.cctp, ...extra.cctp } : inputs?.cctp;
    // The stall window runs from when the current hash was saved.
    const savedHash = extra?.cctp?.executeTxHash;
    const cctp =
      merged && savedHash !== undefined && savedHash !== inputs?.cctp?.executeTxHash
        ? { ...merged, executeSavedAt: nowSec }
        : merged;
    // Unlike the earn-withdraw writer there is no monotonic guard here, so the
    // only thing keeping one bridge from reporting twice is comparing against
```

`src/lib/miden/transaction/complete.ts:1559-1566`, current text (unique in the file):

```ts
    }
    // Once, so a row that later times out still says Circle attested it: only such a row takes a late mint. A row that
    // was ready before the stamp existed takes it as it moves on.
    const readyAt =
      inputs?.readyAt ?? (phase === 'ready' || fromPhase === 'ready' ? Math.floor(Date.now() / 1000) : undefined);
    tx.extraInputs = {
      ...inputs,
      phase,
```

becomes:

```ts
    }
    // Once, so a row that later times out still says Circle attested it: only such a row takes a late mint. A row that
    // was ready before the stamp existed takes it as it moves on.
    const readyAt = inputs?.readyAt ?? (phase === 'ready' || fromPhase === 'ready' ? nowSec : undefined);
    tx.extraInputs = {
      ...inputs,
      phase,
```

`src/lib/miden/activity/bridge-receive.ts:12-29`, current text (unique in the file):

```ts
  UsdcxAttestationMismatchField,
  UsdcxDepositExpectation
} from 'lib/usdcx/attestation';
import { fetchAttestedCctpMessage, isCctpForwardFailed, revertedExecuteLeg } from 'lib/usdcx/cctp';
import { USDCX_SOURCE_CHAINS, UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { readEvmReceiptOutcome, waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import {
  BRIDGE_DELIVERY_TIMED_OUT,
  BRIDGE_RECEIVE_MAX_AGE_MS,
  registerPendingBridgeIn,
  resolveBridgeInNoteId
} from './bridge-in';
import { IBridgedReceiveExtraInputs, ITransaction } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

const SUBMISSION_LOCK = 'bridge-receive-submission';
```

becomes:

```ts
  UsdcxAttestationMismatchField,
  UsdcxDepositExpectation
} from 'lib/usdcx/attestation';
import {
  fetchAttestedCctpMessage,
  isCctpForwardFailed,
  revertedExecuteLeg,
  stalledExecuteLeg,
  USDCX_EXECUTE_STALL_SEC
} from 'lib/usdcx/cctp';
import { isUsdcxExecutorSource, USDCX_SOURCE_CHAINS, UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { readEvmReceiptOutcome, waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import {
  BRIDGE_DELIVERY_TIMED_OUT,
  BRIDGE_RECEIVE_MAX_AGE_MS,
  registerPendingBridgeIn,
  resolveBridgeInNoteId
} from './bridge-in';
import { IBridgedReceiveExtraInputs, ITransaction, IUsdcxCctpLeg } from '../db/types';
import { updateBridgedReceivePhase } from '../transaction/complete';

const SUBMISSION_LOCK = 'bridge-receive-submission';
```

`src/lib/miden/activity/bridge-receive.ts:216-229`, current text (unique in the file):

```ts
  }
}

/**
 * An executor-route deposit has two Circle attestations. First Iris attests the CCTP burn. A forwarded burn
 * is then executed on Arc by Circle, and the reconciler waits for the forward transaction hash; a manual
 * burn, or a forward Circle gave up on, keeps the attested message on the row, where the status screen and
 * Activity offer the execute. Once an Arc transaction hash is on the row, from either side, the reconciler
 * asks xReserve's attestation service for it, which is the deposit, and the row becomes `ready` as a direct
 * deposit would. An Arc execute that reverted, seen here or by the foreground hook, reopens the leg for the
 * wallet to execute, and its hash is never adopted again.
 */
async function reconcileUsdcxExecutorRow(
  row: ITransaction,
```

becomes:

```ts
  }
}

/** A leg that holds the message to execute again, whose hash has been unmined for the whole stall window. */
function executeStalled(row: ITransaction, leg: IUsdcxCctpLeg): boolean {
  if (leg.message === undefined || leg.attestation === undefined) return false;
  // A hash saved before the stamp existed is timed from the deposit, which only ever reopens it sooner.
  const savedAt = leg.executeSavedAt ?? row.initiatedAt;
  return Math.floor(Date.now() / 1000) - savedAt >= USDCX_EXECUTE_STALL_SEC;
}

/** An executor deposit whose attested message is on the row and not yet executed: it can be executed at any age. */
function holdsExecutableMessage(inputs: IBridgedReceiveExtraInputs): boolean {
  return (
    inputs.provider === 'usdcx' &&
    inputs.phase === 'delivering' &&
    isUsdcxExecutorSource(inputs.sourceChainId) &&
    inputs.cctp?.message !== undefined &&
    inputs.cctp.attestation !== undefined &&
    inputs.cctp.executeTxHash === undefined
  );
}

/**
 * When a row's week starts: a ready row's at its attestation and a saved Arc execute's when it was saved, so a deposit
 * attested or executed late in its first week gets a week of its own.
 */
function cutoffStart(row: ITransaction, inputs: IBridgedReceiveExtraInputs): number {
  if (inputs.phase === 'ready') return inputs.readyAt ?? row.initiatedAt;
  return inputs.cctp?.executeTxHash === undefined ? row.initiatedAt : (inputs.cctp.executeSavedAt ?? row.initiatedAt);
}

/**
 * An executor-route deposit has two Circle attestations. First Iris attests the CCTP burn. A forwarded burn
 * is then executed on Arc by Circle, and the reconciler waits for the forward transaction hash; a manual
 * burn, or a forward Circle gave up on, keeps the attested message on the row, where the status screen and
 * Activity offer the execute. Once an Arc transaction hash is on the row, from either side, the reconciler
 * asks xReserve's attestation service for it, which is the deposit, and the row becomes `ready` as a direct
 * deposit would. An Arc execute that reverted, seen here or by the foreground hook, or that stayed unmined past
 * the stall window, reopens the leg for the wallet to execute, and its hash is never adopted again.
 */
async function reconcileUsdcxExecutorRow(
  row: ITransaction,
```

`src/lib/miden/activity/bridge-receive.ts:244-265`, current text (unique in the file):

```ts
      warnUsdcxRowOnce(row.id, `execute attestation ${verdict.kind}`, leg.executeTxHash);
      return;
    }
    // The foreground hook sees a revert only while its screen is open.
    if (isHash(leg.executeTxHash) && (await readEvmReceiptOutcome(leg.executeTxHash, target.chain)) === 'reverted') {
      await updateBridgedReceivePhase(row.id, 'delivering', {
        cctp: revertedExecuteLeg(leg.sourceDomain, leg.executeTxHash)
      });
    }
    return;
  }
  if (leg.attestation && !leg.forwarded) return;
  const attested = await fetchAttestedCctpMessage(leg.sourceDomain, inputs.evmTxHash, { baseUrl: source.irisApi });
  if (!attested) return;
  const forwardReverted =
    attested.forwardTxHash !== undefined &&
    leg.revertedExecuteTxHash !== undefined &&
    sameHash(attested.forwardTxHash, leg.revertedExecuteTxHash);
  if (attested.forwardTxHash && !forwardReverted) {
    await updateBridgedReceivePhase(
      row.id,
      'delivering',
```

becomes:

```ts
      warnUsdcxRowOnce(row.id, `execute attestation ${verdict.kind}`, leg.executeTxHash);
      return;
    }
    if (!isHash(leg.executeTxHash)) return;
    // The foreground hook sees a revert only while its screen is open.
    const outcome = await readEvmReceiptOutcome(leg.executeTxHash, target.chain);
    if (outcome === 'reverted') {
      await updateBridgedReceivePhase(row.id, 'delivering', {
        cctp: revertedExecuteLeg(leg.sourceDomain, leg.executeTxHash)
      });
    } else if (outcome === 'pending' && executeStalled(row, leg)) {
      await updateBridgedReceivePhase(row.id, 'delivering', {
        cctp: stalledExecuteLeg(leg.sourceDomain, leg.executeTxHash)
      });
    }
    return;
  }
  // A stalled execute can still mine, and its deposit then lands the row.
  if (leg.stalledExecuteTxHash) {
    const verdict = await matchUsdcxDeposit(row, inputs, leg.stalledExecuteTxHash, target.attestationApi);
    if (verdict?.kind === 'attested') {
      await updateBridgedReceivePhase(row.id, 'ready');
      return;
    }
  }
  if (leg.attestation && !leg.forwarded) return;
  const attested = await fetchAttestedCctpMessage(leg.sourceDomain, inputs.evmTxHash, { baseUrl: source.irisApi });
  if (!attested) return;
  const forwardTxHash = attested.forwardTxHash;
  const forwardRefused =
    forwardTxHash !== undefined &&
    [leg.revertedExecuteTxHash, leg.stalledExecuteTxHash].some(
      hash => hash !== undefined && sameHash(forwardTxHash, hash)
    );
  if (attested.forwardTxHash && !forwardRefused) {
    await updateBridgedReceivePhase(
      row.id,
      'delivering',
```

`src/lib/miden/activity/bridge-receive.ts:310-316`, current text (unique in the file):

```ts
  }
  // A ready row's week runs from its attestation, so a deposit attested late in its first week gets its own.
  const since = inputs.phase === 'ready' ? (inputs.readyAt ?? row.initiatedAt) : row.initiatedAt;
  if (since < cutoffSec) {
    await updateBridgedReceivePhase(row.id, 'failed', { error: BRIDGE_DELIVERY_TIMED_OUT });
    return;
  }
```

becomes:

```ts
  }
  if (cutoffStart(row, inputs) < cutoffSec && !holdsExecutableMessage(inputs)) {
    await updateBridgedReceivePhase(row.id, 'failed', { error: BRIDGE_DELIVERY_TIMED_OUT });
    return;
  }
```

- [ ] **Step 4: Run them and watch them pass**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && yarn jest src/lib/usdcx/cctp.test.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-receive.test.ts src/lib/miden/activity/bridge-receive.usdcx.test.ts src/lib/miden/activity/bridge-in.test.ts src/lib/miden/activity/bridge-in.adopt.test.ts --maxWorkers=2
```

Expected: PASS (Test Suites: 3 passed, 3 total / Tests:       108 passed, 108 total for the three changed suites; the other three stay green).

- [ ] **Step 5: Format, lint and dash check**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && npx prettier --write src/lib/miden/db/types.ts src/lib/usdcx/cctp.ts src/lib/usdcx/cctp.test.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts && npx eslint --max-warnings 0 src/lib/miden/db/types.ts src/lib/usdcx/cctp.ts src/lib/usdcx/cctp.test.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts
```

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" && printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/' && git diff -U0 -- src/lib/miden/db/types.ts src/lib/usdcx/cctp.ts src/lib/usdcx/cctp.test.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: eslint exit 0; exactly `control hit`.

- [ ] **Step 6: Commit (spec commit 7a)**

```bash
cd /Users/celrisen/miden/wt-usdcx-e2e && git add src/lib/miden/db/types.ts src/lib/usdcx/cctp.ts src/lib/usdcx/cctp.test.ts src/lib/miden/transaction/complete.ts src/lib/miden/transaction/bridged-receive-phase.test.ts src/lib/miden/activity/bridge-receive.ts src/lib/miden/activity/bridge-receive.test.ts && git commit -m "fix(usdcx): keep a stranded executor leg executable"
```

---

### Task 16: Make Sepolia an executor bridge-in source (spec commit 7b) (p2-sepolia-executor)

**Key:** `p2-sepolia-executor`. Runs after Task 15 (`p1-executor-stall`) (commit 7a).

**Files:** (origin/main lines; match on text)
- Modify: `src/lib/usdcx/constant.ts` (:245-251)
- Modify: `playwright/e2e/ios/helpers/xreserve-fork.ts` (:12, :36)
- Test: `src/lib/usdcx/constant.test.ts` (:50, :63, :83-91, :93-99, new describe before :102, :151-155)
- Test: `src/lib/usdcx/deposit.test.ts` (:1, :16, :66-72, :111-118)
- Test: `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx` (the test at origin/main :534-581)

**Interfaces:**
- Consumes: `E2E_USDCX_CHAIN` (constant.ts:10, `MIDEN_E2E_TEST === 'true' ? MIDEN_E2E_USDCX_CHAIN : ''`), `sourceChain` (:163-172), `executorSource` (:195-218), `ARC_TESTNET_EXECUTOR` (:220), `TOKEN_MESSENGER_WITH_FEES_ADDRESS.get(sepolia.id)` (:37), `CIRCLE_DOMAIN.get(sepolia.id) = 0` (:46).
- Produces: `USDCX_SOURCE_CHAINS.get(11155111)` is `{ route: 'cctp-executor', target: <Arc Testnet executor>, ... }` unless the e2e build sets both `MIDEN_E2E_TEST=true` and `MIDEN_E2E_USDCX_CHAIN=sepolia`, in which case it is `sourceChain(sepolia)` as today (contract 2.2). Map order, `XRESERVE_ADDRESS`, `CIRCLE_USDC_ADDRESS` and every Arc Testnet entry are unchanged. `xreserve-fork.ts` exports `FORK_XRESERVE_ADDRESS` (`0x008888878f94C0d87defdf0B07f46B93C1934442`) and `FORK_USDC_ADDRESS` (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) with unchanged values (contract 2.7).

- [ ] **Step 1: Write the failing tests and retarget the Sepolia-as-xReserve ones**

`src/lib/usdcx/constant.test.ts`:

`:50`, before / after:

```ts
    expect(sources.map(source => source.chain.id)).toEqual([ARC_TESTNET_ID, sepolia.id, arc.id, mainnet.id]);
```

```ts
    expect(sources.map(source => source.chain.id)).toEqual([ARC_TESTNET_ID, arc.id, mainnet.id]);
```

`:63`, before:

```ts
    expect(sources.map(source => source.chain.id)).toEqual([baseSepolia.id, arbitrumSepolia.id, base.id, arbitrum.id]);
```

after:

```ts
    expect(sources.map(source => source.chain.id)).toEqual([
      sepolia.id,
      baseSepolia.id,
      arbitrumSepolia.id,
      base.id,
      arbitrum.id
    ]);
```

`:83-91`, before:

```ts
  it('routes Base and Arbitrum through the executor on Arc of the same network family', () => {
    expect(getUsdcxExecutorSource(baseSepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
```

after:

```ts
  it('routes Sepolia, Base and Arbitrum through the executor on Arc of the same network family', () => {
    expect(getUsdcxExecutorSource(sepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
    expect(getUsdcxExecutorSource(baseSepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
```

and in the same test, before:

```ts
    expect(isUsdcxExecutorSource(sepolia.id)).toBe(false);
    expect(isUsdcxExecutorSource(undefined)).toBe(false);
```

after:

```ts
    expect(isUsdcxExecutorSource(sepolia.id)).toBe(true);
    expect(isUsdcxExecutorSource(ARC_TESTNET_ID)).toBe(false);
    expect(isUsdcxExecutorSource(undefined)).toBe(false);
```

`:95-97`, before:

```ts
    expect(getUsdcxXReserveSource(sepolia.id).chain.name).toBe('Sepolia');
    expect(() => getUsdcxXReserveSource(baseSepolia.id)).toThrow('no local xReserve');
    expect(() => getUsdcxExecutorSource(sepolia.id)).toThrow('not an executor source');
```

after:

```ts
    expect(getUsdcxExecutorSource(sepolia.id).chain.name).toBe('Sepolia');
    expect(() => getUsdcxXReserveSource(sepolia.id)).toThrow('no local xReserve');
    expect(() => getUsdcxXReserveSource(baseSepolia.id)).toThrow('no local xReserve');
    expect(() => getUsdcxExecutorSource(ARC_TESTNET_ID)).toThrow('not an executor source');
```

Before `describe('USDCx destinations', () => {` (:102) add:

```ts
describe('USDCx Sepolia source under the e2e flags', () => {
  const ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV };
  });

  // The hermetic Bridge-IN job deposits into a Sepolia fork that registers Miden itself.
  it('keeps Sepolia an xReserve source, and the default, in an e2e build that picks the Sepolia fork', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    process.env.MIDEN_E2E_USDCX_CHAIN = 'sepolia';
    jest.isolateModules(() => {
      const e2e: typeof import('./constant') = require('./constant');
      expect(e2e.DEFAULT_USDCX_SOURCE_CHAIN_ID).toBe(sepolia.id);
      expect(e2e.getUsdcxXReserveSource(sepolia.id)).toMatchObject({
        xReserve: XRESERVE_ADDRESS.get(sepolia.id),
        usdc: CIRCLE_USDC_ADDRESS.get(sepolia.id),
        attestationApi: XRESERVE_ATTESTATION_API_TESTNET
      });
      expect(e2e.isUsdcxExecutorSource(sepolia.id)).toBe(false);
    });
  });

  it('keeps Sepolia an executor source when only the chain flag is set, outside an e2e build', () => {
    delete process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_USDCX_CHAIN = 'sepolia';
    jest.isolateModules(() => {
      const production: typeof import('./constant') = require('./constant');
      expect(production.DEFAULT_USDCX_SOURCE_CHAIN_ID).toBe(ARC_TESTNET_ID);
      expect(production.getUsdcxExecutorSource(sepolia.id).target.chain.id).toBe(ARC_TESTNET_ID);
    });
  });
});

```

`:151-155` (in `describe('USDCx per-chain contracts', ...)`), before:

```ts
  it('resolves Arc and Sepolia independently without silently falling back', () => {
    expect(getUsdcxXReserveSource(5042002).usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(getUsdcxXReserveSource(sepolia.id).usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(() => getUsdcxXReserveSource(999)).toThrow('not configured');
  });
```

after:

```ts
  it('resolves Arc Testnet and Ethereum independently without silently falling back', () => {
    expect(getUsdcxXReserveSource(5042002).usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(getUsdcxXReserveSource(mainnet.id).usdc).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(() => getUsdcxXReserveSource(999)).toThrow('not configured');
  });

  // The address maps keep Sepolia's xReserve: the e2e Sepolia fork deposits into it.
  it('configures CCTP, not local xReserve, for Sepolia, whose xReserve has no Miden domain', () => {
    expect(getUsdcxExecutorSource(sepolia.id).usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(getUsdcxExecutorSource(sepolia.id).tokenMessengerWithFees).toBe(
      TOKEN_MESSENGER_WITH_FEES_ADDRESS.get(sepolia.id)
    );
    expect(CIRCLE_DOMAIN.get(sepolia.id)).toBe(0);
    expect(XRESERVE_ADDRESS.get(sepolia.id)).toBe('0x008888878f94C0d87defdf0B07f46B93C1934442');
    expect(() => getUsdcxXReserveSource(sepolia.id)).toThrow('no local xReserve');
  });
```

`src/lib/usdcx/deposit.test.ts`: before `:1` (`import { USDCX_DEPOSIT_HOOK_DATA, ... } from './constant';`) add:

```ts
import { mainnet, sepolia } from 'viem/chains';

```

Delete `const SEPOLIA_ID = 11155111;` (:16, :17 after Task 5 (`p2-recipient-writers`)). Replace `:66-72`:

```ts
  it('names the USDC of the source chain as the local token', () => {
    expect(buildDepositToRemoteArgs('1', RECIPIENT, SEPOLIA_ID)[3]).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
  });

  it('refuses a chain with no xReserve', () => {
    expect(() => buildDepositToRemoteArgs('1', RECIPIENT, 84532)).toThrow('no local xReserve');
  });
```

with:

```ts
  it('names the USDC of the source chain as the local token', () => {
    expect(buildDepositToRemoteArgs('1', RECIPIENT, mainnet.id)[3]).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });

  // Sepolia's xReserve has no Miden domain, so outside the e2e build Sepolia deposits through the executor.
  it.each([84532, sepolia.id])('refuses chain %i, which has no local xReserve', chainId => {
    expect(() => buildDepositToRemoteArgs('1', RECIPIENT, chainId)).toThrow('no local xReserve');
  });
```

In `takes the xReserve and USDC of the chain the deps name` (:111-118) replace every `SEPOLIA_ID` with `mainnet.id` (three occurrences: `makeDeps({ sourceChainId: mainnet.id })`, `XRESERVE_ADDRESS.get(mainnet.id)`, `buildDepositToRemoteArgs('1', RECIPIENT, mainnet.id)`).

`EvmBridgeDepositScreen.usdcx.test.tsx`: replace the whole test that starts `  it.each([false, true])('pins the deposit to the source chain picked in the drawer (native=%s)', async native => {` (origin/main :534-581; it ends at the `  });` just before `  const reachBaseSepoliaRoute = async () => {`) with:

```tsx
  // Circle has not registered Miden on Sepolia's xReserve, so a Sepolia deposit burns through CCTP to the executor on
  // Arc, as Base and Arbitrum do; only the e2e build's Sepolia fork keeps the xReserve route.
  it.each([false, true])(
    'burns a Sepolia deposit through the executor on Arc, pinned to Sepolia (native=%s)',
    async native => {
      mockNativeAvailable = native;
      jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
        await deps.isRemoteDomainRegistered(10007);
        await deps.signer.approve('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', 1_500_000n);
        const hash = await deps.signer.depositForBurnWithHook([
          1_500_000n,
          26,
          `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
          '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
          `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
          0n,
          2000,
          `0x${recipient.slice(2)}`
        ]);
        await deps.waitForReceipt(hash);
        return hash;
      });
      renderScreen();
      await pickToken('pick-circle-usdc');
      fireEvent.click(screen.getByTestId('open-network-drawer'));
      await settle();
      fireEvent.click(screen.getByTestId('pick-network-sepolia'));
      await settle();
      // The balance of the chosen chain's USDC is read once the drawer closes.
      expect(global.fetch).toHaveBeenCalledWith('https://rpc.test/11155111', expect.any(Object));
      await reachRouteStep();
      fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
      await settle();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expect(runUsdcxDeposit).not.toHaveBeenCalled();
      expect(runUsdcxExecutorDeposit).toHaveBeenCalledWith(
        expect.any(String),
        '1.5',
        expect.any(String),
        expect.objectContaining({
          source: expect.objectContaining({ route: 'cctp-executor', chain: expect.objectContaining({ id: 11155111 }) })
        })
      );
      // Sepolia's xReserve shares Arc's address, so the URL is what proves the check read Arc, where the deposit lands.
      expect(registrationReadUrls('0x008888878f94C0d87defdf0B07f46B93C1934442')).toEqual(['https://rpc.test/5042002']);
      const signer = native ? mockNativeSend : mockWriteContract;
      expect(signer).toHaveBeenCalledTimes(2);
      expect(signer).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          chainId: 11155111,
          [native ? 'to' : 'address']: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
        })
      );
      expect(signer).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          chainId: 11155111,
          [native ? 'to' : 'address']: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
        })
      );
      expect(waitForEvmReceipt).toHaveBeenCalledWith(`0x${'2'.repeat(64)}`, expect.objectContaining({ id: 11155111 }));
      expect(mockSwitchChain.mock.calls).toEqual(native ? [] : [[{ chainId: 11155111 }]]);
    }
  );
```

Mutation notes: reverting `SEPOLIA_SOURCE` to `sourceChain(sepolia)` fails the retargeted constant tests, `refuses chain 11155111...` and both `burns a Sepolia deposit...` cases; making it always `executorSource(sepolia, ARC_TESTNET_EXECUTOR)` (dropping the override) fails `keeps Sepolia an xReserve source, and the default, in an e2e build...` with `USDCx chain 11155111 has no local xReserve` (verified on a scratch copy). The retargets to `mainnet.id` pass before and after: they stop pinning Sepolia as an xReserve source.

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx/constant.test.ts src/lib/usdcx/deposit.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx --maxWorkers=2
```

Expected: `Tests: 9 failed`: `refuses chain 11155111, which has no local xReserve`; the five retargeted or new Sepolia constant tests (`gives each xReserve source...`, `gives each executor source...`, `routes Sepolia, Base and Arbitrum...`, `starts from Arc Testnet outside the e2e build...`, `configures CCTP, not local xReserve, for Sepolia...`); `keeps Sepolia an executor source when only the chain flag is set...` (`USDCx chain 11155111 is not an executor source`); both `burns a Sepolia deposit...` cases (`expect(jest.fn()).not.toHaveBeenCalled()`, `Received number of calls: 1`).

- [ ] **Step 3: Implement the source table**

`src/lib/usdcx/constant.ts:245-251`, before:

```ts
/**
 * Every chain a bridge-in can start from, keyed by EVM chain id. Testnet entries first. Chains with a local
 * xReserve deposit directly; Base and Arbitrum reach Arc's xReserve through Circle's executor.
 */
export const USDCX_SOURCE_CHAINS: ReadonlyMap<number, UsdcxSourceChain> = new Map([
  sourceChain(ARC_TESTNET),
  sourceChain(sepolia),
```

after:

```ts
// Circle has not registered Miden on Sepolia's xReserve (a deposit there reverts), so a Sepolia deposit goes through
// the executor on Arc. The e2e build's Sepolia fork registers Miden itself and keeps the xReserve route.
const SEPOLIA_SOURCE =
  E2E_USDCX_CHAIN === 'sepolia' ? sourceChain(sepolia) : executorSource(sepolia, ARC_TESTNET_EXECUTOR);

/**
 * Every chain a bridge-in can start from, keyed by EVM chain id. Testnet entries first. Arc and Ethereum deposit
 * into their own xReserve; Sepolia, Base and Arbitrum reach Arc's xReserve through Circle's executor.
 */
export const USDCX_SOURCE_CHAINS: ReadonlyMap<number, UsdcxSourceChain> = new Map([
  sourceChain(ARC_TESTNET),
  SEPOLIA_SOURCE,
```

- [ ] **Step 4: Run the unit tests and the whole directories**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx src/app/templates/EvmConnectModal src/lib/miden/activity src/app/templates/history --maxWorkers=2
```

Expected: every suite in the four directories passes, 0 failed (`bridge-receive.ts` and `HistoryDetails.tsx` read the source table too).

- [ ] **Step 5: See the hidden Playwright dependent fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; npx playwright test -c playwright.ios.bridge-in.config.ts --list
```

Expected: exit 1, `Error: USDCx chain 11155111 has no local xReserve` at `xreserve-fork.ts:36`, `Total: 0 tests in 0 files`. The Playwright process has no `MIDEN_E2E_TEST` (the e2e-bridge-in.yml job sets only `MIDEN_E2E_USDCX_CHAIN` at job level, :64), so the hermetic Bridge-IN job on push to main would fail to load its specs.

- [ ] **Step 6: Read the fork's addresses from the maps**

`playwright/e2e/ios/helpers/xreserve-fork.ts:12`, before:

```ts
import { getUsdcxXReserveSource, USDCX_REMOTE_DOMAIN } from '../../../../src/lib/usdcx/constant';
```

after:

```ts
import { CIRCLE_USDC_ADDRESS, USDCX_REMOTE_DOMAIN, XRESERVE_ADDRESS } from '../../../../src/lib/usdcx/constant';
```

`:36`, before:

```ts
const { usdc: SEPOLIA_USDC, xReserve: XRESERVE } = getUsdcxXReserveSource(sepolia.id);
```

after:

```ts
// Read from the address maps, not the source table: this module loads in the Playwright process, which has no
// MIDEN_E2E_TEST, and there Sepolia is an executor source with no xReserve route.
function sepoliaAddress(addresses: ReadonlyMap<number, Address>, name: string): Address {
  const address = addresses.get(sepolia.id);
  if (!address) throw new Error(`xreserve-fork: no Sepolia ${name} address is configured`);
  return address;
}

const SEPOLIA_USDC = sepoliaAddress(CIRCLE_USDC_ADDRESS, 'USDC');
const XRESERVE = sepoliaAddress(XRESERVE_ADDRESS, 'xReserve');
```

(`Address` is already imported at :2.)

- [ ] **Step 7: List again and run the harness lint**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; npx playwright test -c playwright.ios.bridge-in.config.ts --list && yarn lint:e2e
```

Expected: `Total: 5 tests in 5 files` (bridge-in-deposit-epoch, bridge-in-deposit-usdcx, bridge-in-deposit, bridge-in-receive, bridge-in-wc-pairing); `lint:e2e` reports no new violation and exits 0.

- [ ] **Step 8: Format and lint**

```bash
npx prettier --write src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/lib/usdcx/deposit.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx playwright/e2e/ios/helpers/xreserve-fork.ts && npx eslint --max-warnings 0 src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/lib/usdcx/deposit.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx playwright/e2e/ios/helpers/xreserve-fork.ts
```

Expected: eslint exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/lib/usdcx/deposit.test.ts src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx playwright/e2e/ios/helpers/xreserve-fork.ts
git diff --cached --name-only | wc -l   # 5
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0
git commit -m "fix(usdcx): make Sepolia an executor bridge-in source"
```

---

### Task 17: Retry the destination balance snapshot before a burn (spec commit 7c) (p2-snapshot-retry)

**Key:** `p2-snapshot-retry`. Runs after Task 16 (`p2-sepolia-executor`).

**Files:** (origin/main lines)
- Modify: `src/lib/usdcx/destination-status.ts` (:10-20, before :32)
- Modify: `src/lib/usdcx/burn.ts` (:34, :103)
- Test: `src/lib/usdcx/destination-status.test.ts` (:3, :8-13, before :69)
- Test: `src/lib/usdcx/burn.test.ts` (:1-3, :7-11, :15-19, after :55)

**Interfaces:**
- Consumes: `UsdcxBalanceSnapshot { balance: string; blockNumber: string }` (destination-status.ts:10-13); `initiateBridgedSendTransaction(..., usdcxBurn?: IUsdcxBurn)` (transaction/initiate.ts:601-614, 12th parameter).
- Produces:
  - `readUsdcxDestinationBalance(chainId: number, recipient: string, timeoutMs?: number): Promise<UsdcxBalanceSnapshot>`: the third parameter (default 15_000) is each request's viem `http` timeout; `pollUsdcxDestination` still calls it with two arguments.
  - `export interface UsdcxSnapshotDeps { read?: typeof readUsdcxDestinationBalance; now?: () => number; sleep?: (ms: number) => Promise<void> }`.
  - `export async function readUsdcxDestinationSnapshot(chainId: number, recipient: string, deps?: UsdcxSnapshotDeps): Promise<UsdcxBalanceSnapshot>`: at most 3 attempts, 1 s then 2 s backoff, one 15 s deadline; each attempt's requests time out at what is left of it; no attempt starts whose backoff would reach the deadline; the last error is rethrown (contract 2.6).
  - `burn.ts:103` reads the snapshot through it, so a burn whose every attempt fails still throws before `initiateBridgedSendTransaction` queues a row (p3's `bridgeOutUsdcx` keeps naming burn.ts:103).

- [ ] **Step 1: Write the failing tests**

`src/lib/usdcx/destination-status.test.ts:3`, before / after:

```ts
import { pollUsdcxDestination, readUsdcxDestinationBalance } from './destination-status';
```

```ts
import { pollUsdcxDestination, readUsdcxDestinationBalance, readUsdcxDestinationSnapshot } from './destination-status';
```

Replace `:8-13`:

```ts
const mockReadContract = jest.fn();
const mockGetBlockNumber = jest.fn();
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ readContract: mockReadContract, getBlockNumber: mockGetBlockNumber })
}));
```

with:

```ts
const mockReadContract = jest.fn();
const mockGetBlockNumber = jest.fn();
const mockHttp = jest.fn((url: string, options: { timeout: number; retryCount: number }) => ({ url, options }));
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  http: (url: string, options: { timeout: number; retryCount: number }) => mockHttp(url, options),
  createPublicClient: () => ({ readContract: mockReadContract, getBlockNumber: mockGetBlockNumber })
}));
```

Before `:69` (`it('confirms arrival and preserves burn confirmation', async () => {`) add:

```ts
it('times each request out at the budget it is handed, 15 s by default, and never retries inside viem', async () => {
  mockGetBlockNumber.mockResolvedValueOnce(101n).mockResolvedValueOnce(101n);
  mockReadContract.mockResolvedValueOnce(6000000n).mockResolvedValueOnce(6000000n);
  await readUsdcxDestinationBalance(5042002, recipient);
  await readUsdcxDestinationBalance(5042002, recipient, 4_000);
  expect(mockHttp.mock.calls.map(([, options]) => options)).toEqual([
    { timeout: 15_000, retryCount: 0 },
    { timeout: 4_000, retryCount: 0 }
  ]);
});

describe('readUsdcxDestinationSnapshot', () => {
  const snapshot = { balance: '0', blockNumber: '66303813' };
  const rateLimited = () => new Error('HTTP request failed. Status: 429');

  /** A clock that moves only when the code under test sleeps or a read takes time. */
  function fakeClock() {
    let now = 1_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
      sleep: jest.fn(async (ms: number) => {
        now += ms;
      })
    };
  }

  it('reads once and does not wait when the first read lands', async () => {
    const clock = fakeClock();
    const readBalance = jest.fn(async () => snapshot);

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).resolves.toEqual(snapshot);

    expect(readBalance.mock.calls).toEqual([[5042002, recipient, 15_000]]);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  // arc.io answers intermittent 429s; one failed read must not fail the burn before its row exists.
  it('retries a failed read with backoff, each attempt drawing on what is left of the 15 s', async () => {
    const clock = fakeClock();
    const readBalance = jest
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(snapshot);

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).resolves.toEqual(snapshot);

    expect(readBalance.mock.calls).toEqual([
      [5042002, recipient, 15_000],
      [5042002, recipient, 14_000],
      [5042002, recipient, 12_000]
    ]);
    expect(clock.sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('rethrows the last error after three attempts', async () => {
    const clock = fakeClock();
    const readBalance = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).rejects.toThrow('third');

    expect(readBalance).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('starts no attempt the 15 s budget cannot hold', async () => {
    const clock = fakeClock();
    const readBalance = jest.fn(async () => {
      clock.advance(14_500);
      throw new Error('timed out');
    });

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).rejects.toThrow('timed out');

    expect(readBalance).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('waits on the real clock between attempts by default', async () => {
    jest.useFakeTimers();
    try {
      mockGetBlockNumber.mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce(101n);
      mockReadContract.mockResolvedValueOnce(6000000n);

      const outcome = readUsdcxDestinationSnapshot(5042002, recipient);
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(outcome).resolves.toEqual(arrived);
      expect(mockGetBlockNumber).toHaveBeenCalledTimes(2);
      expect(mockHttp.mock.calls.map(([, options]) => options.timeout)).toEqual([15_000, 14_000]);
    } finally {
      jest.useRealTimers();
    }
  });
});

```

`src/lib/usdcx/burn.test.ts:1-3`, before:

```ts
import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { readUsdcxMinimumBurn } from './burn';
```

after:

```ts
import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';
import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { initiateUsdcxBurn, readUsdcxMinimumBurn } from './burn';
import { readUsdcxDestinationBalance, readUsdcxDestinationSnapshot } from './destination-status';
```

Replace `:7-11`:

```ts
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteScript: { burn: () => ({ root: () => 'burn-root' }) },
  RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails, free: mockFree }))
}));
jest.mock('lib/miden/sdk/helpers', () => ({ accountRefToSdk: (ref: string) => ref }));
```

with:

```ts
// Enough of the SDK for `buildUsdcxBurnRequest` to assemble a request out of stand-ins.
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const felts = { toFelts: () => [] };
  const builder = {
    withOwnOutputNotes: () => builder,
    withFeeConversionSalt: () => builder,
    build: () => ({ serialize: () => new Uint8Array([1]) })
  };
  return {
    NoteScript: { burn: () => ({ root: () => 'burn-root' }) },
    RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails, free: mockFree })),
    FeltArray: jest.fn(),
    FungibleAsset: jest.fn(() => ({ vaultKey: () => felts, intoWord: () => felts })),
    NetworkAccountTarget: jest.fn(() => ({ toAttachment: () => ({}) })),
    Note: { withAttachments: () => ({ id: () => ({ toString: () => 'burn-note-id' }) }) },
    NoteArray: jest.fn(),
    NoteAssets: jest.fn(),
    NoteAttachment: { fromWords: () => ({}) },
    NoteAttachmentScheme: jest.fn(),
    NoteExecutionHint: { always: () => ({}) },
    NoteMetadata: jest.fn(),
    NoteRecipient: { fromScript: () => ({}) },
    NoteStorage: jest.fn(),
    NoteTag: jest.fn(),
    NoteType: { Public: 1 },
    TransactionRequestBuilder: jest.fn(() => builder),
    Word: jest.fn()
  };
});
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (ref: string) => ref,
  getBech32AddressFromAccountId: () => 'mtst1usdcxfaucet',
  randomFeeSalt: () => ({})
}));
```

Replace `:15-19`:

```ts
jest.mock('./destination-status', () => ({ readUsdcxDestinationBalance: jest.fn() }));
jest.mock('./withdrawal', () => ({
  ...jest.requireActual<typeof import('./withdrawal')>('./withdrawal'),
  requireUsdcxFaucetId: () => 'usdcx-faucet'
}));
```

with:

```ts
jest.mock('./destination-status', () => ({
  readUsdcxDestinationBalance: jest.fn(),
  readUsdcxDestinationSnapshot: jest.fn()
}));
jest.mock('./withdrawal', () => ({
  ...jest.requireActual<typeof import('./withdrawal')>('./withdrawal'),
  requireUsdcxFaucetId: () => 'usdcx-faucet',
  validateUsdcxWithdrawal: () => undefined
}));
```

After the last test (ends at :55) add:

```ts

describe('initiateUsdcxBurn', () => {
  const args = {
    senderPublicKey: 'mtst1sender',
    faucetId: 'usdcx-faucet',
    amount: 10_000_000n,
    destinationAddress: '0x1111111111111111111111111111111111111111',
    destinationChainId: 5042002
  };

  beforeEach(() => {
    mockGetAccountDetails.mockResolvedValue(account(1n, 1_000_000n));
    jest.mocked(initiateBridgedSendTransaction).mockResolvedValue('burn-row');
  });

  it('saves the destination balance through the retrying snapshot read', async () => {
    const snapshot = { balance: '0', blockNumber: '66303813' };
    jest.mocked(readUsdcxDestinationSnapshot).mockResolvedValueOnce(snapshot);

    await expect(initiateUsdcxBurn(args)).resolves.toBe('burn-row');

    expect(readUsdcxDestinationSnapshot).toHaveBeenCalledWith(5042002, args.destinationAddress);
    expect(readUsdcxDestinationBalance).not.toHaveBeenCalled();
    expect(jest.mocked(initiateBridgedSendTransaction).mock.calls[0]?.[11]).toEqual({
      noteId: 'burn-note-id',
      destinationDomain: 26,
      phase: 'pending',
      destinationBalanceBefore: snapshot
    });
  });

  it('queues no row when every snapshot attempt fails', async () => {
    jest.mocked(readUsdcxDestinationSnapshot).mockRejectedValueOnce(new Error('HTTP request failed. Status: 429'));

    await expect(initiateUsdcxBurn(args)).rejects.toThrow('Status: 429');

    expect(initiateBridgedSendTransaction).not.toHaveBeenCalled();
  });
});
```

Mutation notes: reverting burn.ts:103 to `readUsdcxDestinationBalance` fails both `initiateUsdcxBurn` tests; dropping `now() + backoff >= deadline` fails `starts no attempt the 15 s budget cannot hold`; passing a fixed 15_000 instead of `deadline - now()` fails `retries a failed read with backoff...` and `waits on the real clock...`; making the read a single attempt fails `retries...` with the 429 (all verified on a scratch copy).

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx/destination-status.test.ts src/lib/usdcx/burn.test.ts --maxWorkers=2
```

Expected: `Tests: 8 failed, 15 passed, 23 total`. The snapshot cases fail with `TypeError: (0 , _destinationstatus.readUsdcxDestinationSnapshot) is not a function`; the timeout case shows `"timeout": 4000` expected against `15000` received; `saves the destination balance...` fails with `Expected: 5042002, "0x1111111111111111111111111111111111111111"` / `Number of calls: 0`; `queues no row...` fails with `Received promise resolved instead of rejected` / `Resolved to value: "burn-row"`.

- [ ] **Step 3: Implement**

`src/lib/usdcx/destination-status.ts:15-20`, before:

```ts
/** Read USDC in six-decimal base units at one block. RPC errors stop this check. */
export async function readUsdcxDestinationBalance(chainId: number, recipient: string): Promise<UsdcxBalanceSnapshot> {
  const chain = getChain(chainId);
  const token = CIRCLE_USDC_ADDRESS.get(chainId);
  if (!chain || !token || !isAddress(recipient)) throw new Error('Invalid USDC destination');
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 15_000, retryCount: 0 }) });
```

after:

```ts
/** One destination read's request timeout, and the whole budget of the snapshot taken before a burn. */
const DESTINATION_READ_TIMEOUT_MS = 15_000;
/** The waits before the snapshot's second and third attempts. */
const SNAPSHOT_BACKOFF_MS = [1_000, 2_000];

/** Read USDC in six-decimal base units at one block. RPC errors stop this check. */
export async function readUsdcxDestinationBalance(
  chainId: number,
  recipient: string,
  timeoutMs = DESTINATION_READ_TIMEOUT_MS
): Promise<UsdcxBalanceSnapshot> {
  const chain = getChain(chainId);
  const token = CIRCLE_USDC_ADDRESS.get(chainId);
  if (!chain || !token || !isAddress(recipient)) throw new Error('Invalid USDC destination');
  const client = createPublicClient({ transport: http(chain.rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });
```

Before `:32` (`export function isUsdcxDestinationPending(burn: IUsdcxBurn): boolean {`) add:

```ts
export interface UsdcxSnapshotDeps {
  read?: typeof readUsdcxDestinationBalance;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The balance a burn is later confirmed against, read before the burn is queued. Arc's public RPC answers
 * intermittent 429s, so a failed read is tried twice more after a backoff, every attempt drawing on the 15 s one read
 * used to have. The last error is rethrown: a burn whose every attempt fails still fails before any row exists.
 */
export async function readUsdcxDestinationSnapshot(
  chainId: number,
  recipient: string,
  { read = readUsdcxDestinationBalance, now = Date.now, sleep = wait }: UsdcxSnapshotDeps = {}
): Promise<UsdcxBalanceSnapshot> {
  const deadline = now() + DESTINATION_READ_TIMEOUT_MS;
  const attempt = async (backoffs: readonly number[]): Promise<UsdcxBalanceSnapshot> => {
    try {
      return await read(chainId, recipient, deadline - now());
    } catch (error) {
      const [backoff, ...later] = backoffs;
      if (backoff === undefined || now() + backoff >= deadline) throw error;
      await sleep(backoff);
      return attempt(later);
    }
  };
  return attempt(SNAPSHOT_BACKOFF_MS);
}

```

(Recursion rather than a `for (;;)` loop: istanbul counts the unreachable loop exit as an uncovered statement.)

`src/lib/usdcx/burn.ts:34`, before / after:

```ts
import { readUsdcxDestinationBalance } from './destination-status';
```

```ts
import { readUsdcxDestinationSnapshot } from './destination-status';
```

`:103`, before / after:

```ts
  const destinationBalanceBefore = await readUsdcxDestinationBalance(destinationChainId, destinationAddress);
```

```ts
  const destinationBalanceBefore = await readUsdcxDestinationSnapshot(destinationChainId, destinationAddress);
```

- [ ] **Step 4: Run the tests, the whole directory and the new code's coverage**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx --maxWorkers=2
JEST_COVERAGE_SHARD=1 yarn jest src/lib/usdcx/destination-status.test.ts src/lib/usdcx/burn.test.ts --maxWorkers=2 --coverage --collectCoverageFrom=src/lib/usdcx/destination-status.ts --collectCoverageFrom=src/lib/usdcx/burn.ts --coverageReporters=text --coverageDirectory="$TMPDIR/p2-snapshot-cov"
```

Expected: every `src/lib/usdcx` suite passes, 0 failed; `destination-status.ts` shows 100% statements, functions and lines (its one partial branch is the pre-existing `Invalid USDC destination` guard), `burn.ts` 100% statements and lines (its partial branches are pre-existing). `JEST_COVERAGE_SHARD=1` turns off the global 95% gate (jest.config.ts:103-115), which a two-file run cannot meet on branches (90.9%); `--coverageDirectory` keeps the report out of the worktree.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/lib/usdcx/destination-status.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/burn.ts src/lib/usdcx/burn.test.ts && npx eslint --max-warnings 0 src/lib/usdcx/destination-status.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/burn.ts src/lib/usdcx/burn.test.ts
```

Expected: prettier changes nothing, eslint exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/usdcx/destination-status.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/burn.ts src/lib/usdcx/burn.test.ts
git diff --cached --name-only | wc -l   # 4
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0
git commit -m "fix(usdcx): retry the destination balance snapshot before a burn"
```

---

### Task 18: Burn notice test id and test-hook source chain and row fields (spec commit 8) (p2-testids-hooks)

**Key:** `p2-testids-hooks`. Runs after Task 17 (`p2-snapshot-retry`); p3's harness tasks consume it.

**Files:** (lines are origin/main's; Route.tsx's notice moved into `UsdcxRouteOption` in Task 13 (`p2-fee-labels`), so match on text)
- Modify: `src/screens/send-flow/Route.tsx` (the notice `<p>` in `UsdcxRouteOption`, origin/main :147)
- Modify: `src/screens/send-flow/ReviewTransaction.tsx` (:705, :711 after Task 13 (`p2-fee-labels`))
- Modify: `src/lib/miden/activity/bridge-in-test-hooks.ts` (:23-44, :61-67, before :69, :93-100, :144-150)
- Test: `src/screens/send-flow/Route.test.tsx` (end of `describe('RouteOptions')`)
- Test: `src/screens/send-flow/ReviewTransaction.test.tsx` (`describe('USDCx burn review')`)

**Interfaces:**
- Consumes: `IBridgedReceiveExtraInputs` fields `evmTxHash`, `error`, `midenNoteId`, `sourceChainId` (types.ts:165-187) and `usdcxRemoteRecipient`, `readyAt` (Tasks 1 (`p1-recipient-field`), 8 (`p1-ready-timeout-late-mint`)); `initiateBridgedReceiveTransaction(args: { ...; sourceChainId?: number; ... })` (transaction/initiate.ts:706-730, already stores `sourceChainId`).
- Produces:
  - `data-testid="usdcx-burn-notice"` on the Route and review notice `<p>`, both rendering en `usdcxWithdrawalNotice` (contract 2.3).
  - `CreateBridgeReceiveArgs.sourceChainId?: number` (type only).
  - `BridgeReceiveState` and `LatestBridgeReceive` gain `evmTxHash?: string; error?: string; midenNoteId?: string; sourceChainId?: number; usdcxRemoteRecipient?: string; readyAt?: number` through a shared `BridgeReceiveDepositFields` interface both extend. Same structural shape as contract 2.5; global names unchanged.

- [ ] **Step 1: Write the failing tests**

`src/screens/send-flow/Route.test.tsx`, after the test `names the native fee asset under the USDCx route, never MIDEN` (Task 13 (`p2-fee-labels`)), inside `describe('RouteOptions')`, add:

```tsx

  it('marks the withdrawal notice under the USDCx route for the e2e harness', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        {...UP}
      />
    );

    expect(screen.getByTestId('usdcx-burn-notice')).toHaveTextContent('usdcxWithdrawalNotice');
  });
```

`src/screens/send-flow/ReviewTransaction.test.tsx`, in `describe('USDCx burn review')`, before `  it('names the native fee asset in the burn fee row, never MIDEN', async () => {` add:

```tsx
  it('marks the withdrawal notice for the e2e harness', async () => {
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('usdcx-burn-notice')).toHaveTextContent('usdcxWithdrawalNotice');
  });

```

Mutation note: removing either `data-testid="usdcx-burn-notice"` fails its test with `Unable to find an element by: [data-testid="usdcx-burn-notice"]`.

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx -t "withdrawal notice" --maxWorkers=2
```

Expected: `Tests: 2 failed`, both `TestingLibraryElementError: Unable to find an element by: [data-testid="usdcx-burn-notice"]`.

- [ ] **Step 3: Implement the test ids**

`src/screens/send-flow/Route.tsx` (in `UsdcxRouteOption`), before (the `<p>` Task 13 (p2-fee-labels) Step 3 wrote, not origin/main :147):

```tsx
      <p className="text-caption text-muted">{t('usdcxWithdrawalNotice')}</p>
```

after:

```tsx
      <p className="text-caption text-muted" data-testid="usdcx-burn-notice">
        {t('usdcxWithdrawalNotice')}
      </p>
```

`src/screens/send-flow/ReviewTransaction.tsx` (origin/main :705), before:

```tsx
        {isUsdcxBurn && <p className="mt-3 px-4 text-caption text-muted">{t('usdcxWithdrawalNotice')}</p>}
```

after:

```tsx
        {isUsdcxBurn && (
          <p className="mt-3 px-4 text-caption text-muted" data-testid="usdcx-burn-notice">
            {t('usdcxWithdrawalNotice')}
          </p>
        )}
```

- [ ] **Step 4: Extend the E2E test hooks**

`src/lib/miden/activity/bridge-in-test-hooks.ts:27-28`, before:

```ts
  provider: IBridgeProvider;
  sourceAddress: string;
```

after:

```ts
  provider: IBridgeProvider;
  /** Type only: the hook hands its args to `initiateBridgedReceiveTransaction`, which stores it. */
  sourceChainId?: number;
  sourceAddress: string;
```

`:37-38`, before:

```ts
interface BridgeReceiveState {
  found: boolean;
```

after:

```ts
/** The deposit facts a spec checks a bridged-receive row against. */
interface BridgeReceiveDepositFields {
  evmTxHash?: string;
  error?: string;
  midenNoteId?: string;
  sourceChainId?: number;
  usdcxRemoteRecipient?: string;
  /** Unix seconds the row first reached `ready`. */
  readyAt?: number;
}

interface BridgeReceiveState extends BridgeReceiveDepositFields {
  found: boolean;
```

`:61-62`, before:

```ts
interface LatestBridgeReceive {
  id: string;
```

after:

```ts
interface LatestBridgeReceive extends BridgeReceiveDepositFields {
  id: string;
```

Before `:69` (`export function installBridgeInTestHooks(): void {`) add:

```ts
function depositFields(inputs: IBridgedReceiveExtraInputs | undefined): BridgeReceiveDepositFields {
  return {
    evmTxHash: inputs?.evmTxHash,
    error: inputs?.error,
    midenNoteId: inputs?.midenNoteId,
    sourceChainId: inputs?.sourceChainId,
    usdcxRemoteRecipient: inputs?.usdcxRemoteRecipient,
    readyAt: inputs?.readyAt
  };
}

```

In `__TEST_BRIDGE_RECEIVE_STATE__` (:98-99), before:

```ts
      amount: row.amount != null ? row.amount.toString() : undefined,
      faucetId: row.faucetId
    };
```

after:

```ts
      amount: row.amount != null ? row.amount.toString() : undefined,
      faucetId: row.faucetId,
      ...depositFields(inputs)
    };
```

In `__TEST_LATEST_BRIDGE_RECEIVE__` (:148-149), before:

```ts
      phase: inputs?.phase,
      displayMessage: row.displayMessage
    };
```

after:

```ts
      phase: inputs?.phase,
      displayMessage: row.displayMessage,
      ...depositFields(inputs)
    };
```

The module is coverage-excluded E2E code with no unit suite (jest.config.ts, `bridge-in-test-hooks\.ts$`); CI's type check, p3's `bridgeReceiveState` / `createUsdcxBridgeReceive` and the live `usdcx`, `usdcx-in` runs in Delivery exercise it.

- [ ] **Step 5: Run the tests and the whole directory**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/screens/send-flow --maxWorkers=2
```

Expected: 20 suites pass, 0 failed.

- [ ] **Step 6: Format and lint**

```bash
npx prettier --write src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx src/lib/miden/activity/bridge-in-test-hooks.ts && npx eslint --max-warnings 0 src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx src/lib/miden/activity/bridge-in-test-hooks.ts
```

Expected: prettier changes nothing, eslint exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx src/lib/miden/activity/bridge-in-test-hooks.ts
git diff --cached --name-only | wc -l   # 5
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0
git commit -m "test(usdcx): burn notice test id and test-hook source chain and row fields"
```

---

### Task 33: Expect a payout of the amount minus the fee, and refuse a burn the fee takes whole (spec 10(g)) (p2-payout-floor)

**Key:** `p2-payout-floor`. Runs after Task 18 (`p2-testids-hooks`). Spec 10(g), Q15; its commit message is this task's own (spec 14's commit list predates 10(g)).

Circle takes a flat ~1,003,500 base units (1.0035 USDC) to pay a USDCx burn out on Ethereum (domain 0), against ~16,400 on Arc and ~11,300 on Base and Arbitrum. `minimumUsdcxPayout` (constant.ts:234-243) expects the amount minus the destination's allowance (1.5 USDC on Ethereum, 0.1 elsewhere) and never less than half the amount, so a paid Ethereum burn under ~2.007 USDCx never reads Confirmed, and one of 1.5 USDCx or less, which the allowance takes whole, is confirmed by any credit of half its amount. Now:
- The floor is exactly the amount minus the allowance. The signature stays `(chainId, amount): bigint`, so PR 1b's re-export in `helpers/usdcx-constants.ts` and its `minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS)` (still 9_900_000) are untouched.
- A floor that is not positive is never met by balance: `pollUsdcxDestination` returns before its RPC read (an older such row stays at `Burn confirmed`), and the History transfer lookup does not search.
- A burn must exceed its destination's allowance. `usdcxPayoutFeeShortfall` names the allowance and the chain; the amount step blocks a smaller amount with `usdcxSendMoreThanPayoutFee`, Review shows the same copy and keeps its submit disabled, and `validateUsdcxWithdrawal` refuses it with the values on the error, which Review's submit path now renders.
- CLAUDE.md's "USDCx destination confirmation" section states the new floor.

The network name is the chain's own (`chain.name`: "Sepolia", "Arc Testnet"), the name the Send flow's network chips show, so the copy reads "Send more than 1.5 USDCx to Sepolia: Circle's fee is taken from the payout."

**Files:** (origin/main lines; where Tasks 13, 14, 16, 17 or 18 moved a line, its line at the start of this task follows in brackets; match on text)
- Modify: `src/lib/usdcx/constant.ts` (:1, :234-243)
- Modify: `src/lib/usdcx/destination-status.ts` (:52-61 [:93-102 after Task 17])
- Modify: `src/lib/usdcx/destination-transaction.ts` (:25-26, :41-43)
- Modify: `src/lib/usdcx/withdrawal.ts` (:7, :9-10, :68-69)
- Modify: `src/screens/send-flow/SendAmount.tsx` (:31-32, :53-55, :80)
- Modify: `src/screens/send-flow/SendManager.tsx` (:24, after :383, :881-882, :921-922)
- Modify: `src/screens/send-flow/ReviewTransaction.tsx` (:44 [:46], :443-444 [:449-450], :597 [:603], :604-605 [:610-611])
- Modify: `public/_locales/en/en.json` (after :23), `public/_locales/en/messages.json` (after :86-89 [:96-99 after Task 13])
- Modify: `CLAUDE.md` (:391-393)
- Test: `src/lib/usdcx/constant.test.ts` (import list after Task 14's `usdcxArrivalKey,` [:22]; :125-131 [:169-175 after Tasks 14 and 16])
- Test: `src/lib/usdcx/destination-status.test.ts` (end of file, :134-138 [:247-251 after Task 17])
- Test: `src/lib/usdcx/destination-transaction.test.ts` (end of file, :67-69)
- Test: `src/lib/usdcx/withdrawal.test.ts` (:1, :57-62, :68-72)
- Test: `src/screens/send-flow/SendAmount.test.tsx` (:16, :191-193)
- Test: `src/screens/send-flow/SendManager.test.tsx` (:165, :1789-1792)
- Test: `src/screens/send-flow/ReviewTransaction.test.tsx` (:22, the `t` mock Task 13 wrote [:113-119], :474-475 [:482-483], :513-516 [:534-537])

**Interfaces:**
- Consumes: `USDCX_DESTINATIONS` and `UsdcxDestination.payoutFeeAllowance` (constant.ts:145-153, :265-274), `USDCX_DECIMALS` (constant.ts:333), `USDCX_BRIDGE_NETWORKS` (send-flow/bridge-networks.ts:52-55), SendManager's `amountBaseUnits` (SendManager.tsx:370) and `usdcxAvailable` (:379), Review's `bridgeNetworkObj` (ReviewTransaction.tsx:100) and `amountBaseUnits` (:117).
- Produces:
  - `minimumUsdcxPayout(chainId: number, amount: bigint): bigint`: `amount` minus the chain's allowance (0 for a chain with none); not positive when the allowance takes the whole amount.
  - `usdcxPayoutFeeShortfall(chainId: number, amount: bigint): { amount: string; network: string } | undefined`: the allowance as `formatUnits(_, 6)` and `chain.name` while `amount` (positive, on a destination chain) does not exceed the allowance; undefined otherwise.
  - `UsdcxBurnError` gains `readonly values?: Record<string, string>`; `validateUsdcxWithdrawal` throws `new UsdcxBurnError('usdcxSendMoreThanPayoutFee', shortfall)` after its faucet, destination and amount checks.
  - `SendAmountProps.errorValues?: Record<string, string>`, passed to `t(error, errorValues)`.
  - SendManager's memoized `usdcxPayout: { chainId: number; amount: bigint } | undefined` (Task 34 hands it to the Route step) and `payoutFeeShortfall`.
  - en `usdcxSendMoreThanPayoutFee` = `Send more than $amount$ USDCx to $network$: Circle's fee is taken from the payout.` (en/messages.json declares `amount` and `network`).

- [ ] **Step 1: Write the failing tests**

`src/lib/usdcx/constant.test.ts`, in the import list (Task 14 (`p2-arrival`) added `usdcxArrivalKey`), before / after:

```ts
  usdcxArrivalKey,
```

```ts
  usdcxArrivalKey,
  usdcxPayoutFeeShortfall,
```

The half-floor test (origin/main :125-131; :169-175 after Tasks 14 and 16) pins the clause this task removes, so it is replaced, before:

```ts
  it('expects a payout of the amount minus the fee allowance, and never less than half the amount', () => {
    expect(minimumUsdcxPayout(baseSepolia.id, 3_000_000n)).toBe(2_900_000n);
    expect(minimumUsdcxPayout(sepolia.id, 5_000_000n)).toBe(3_500_000n);
    expect(minimumUsdcxPayout(baseSepolia.id, 150_001n)).toBe(75_001n);
    expect(minimumUsdcxPayout(sepolia.id, 1_000_000n)).toBe(500_000n);
    expect(minimumUsdcxPayout(999, 1_000_000n)).toBe(1_000_000n);
  });
```

after:

```ts
  // Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum, more than half of a 2 USDCx
  // burn, so the floor is the amount minus the allowance and nothing else.
  it('expects a payout of the amount minus the fee allowance, not positive once the allowance takes it whole', () => {
    expect(minimumUsdcxPayout(baseSepolia.id, 3_000_000n)).toBe(2_900_000n);
    expect(minimumUsdcxPayout(sepolia.id, 5_000_000n)).toBe(3_500_000n);
    expect(minimumUsdcxPayout(sepolia.id, 2_000_000n)).toBe(500_000n);
    expect(minimumUsdcxPayout(baseSepolia.id, 150_001n)).toBe(50_001n);
    expect(minimumUsdcxPayout(sepolia.id, 1_500_001n)).toBe(1n);
    expect(minimumUsdcxPayout(sepolia.id, 1_500_000n)).toBe(0n);
    expect(minimumUsdcxPayout(sepolia.id, 1_000_000n)).toBe(-500_000n);
    expect(minimumUsdcxPayout(999, 1_000_000n)).toBe(1_000_000n);
  });

  it('names the allowance a burn must exceed and its chain, until the amount exceeds it', () => {
    expect(usdcxPayoutFeeShortfall(sepolia.id, 1_500_000n)).toEqual({ amount: '1.5', network: 'Sepolia' });
    expect(usdcxPayoutFeeShortfall(ARC_TESTNET_ID, 100_000n)).toEqual({ amount: '0.1', network: 'Arc Testnet' });
    expect(usdcxPayoutFeeShortfall(sepolia.id, 1_500_001n)).toBeUndefined();
    expect(usdcxPayoutFeeShortfall(ARC_TESTNET_ID, 100_001n)).toBeUndefined();
    // No amount, or no destination: the amount and destination checks refuse those.
    expect(usdcxPayoutFeeShortfall(sepolia.id, 0n)).toBeUndefined();
    expect(usdcxPayoutFeeShortfall(999, 1n)).toBeUndefined();
  });
```

`src/lib/usdcx/destination-status.test.ts`, the end of the file (origin/main :134-138; :247-251 after Task 17 (`p2-snapshot-retry`)), before:

```ts
    stored = row({ destinationBalanceConfirmed: other });
    return arrived;
  });
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(other);
});
```

after:

```ts
    stored = row({ destinationBalanceConfirmed: other });
    return arrived;
  });
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(other);
});

// Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
describe('a burn paid out on Sepolia', () => {
  function onSepolia(amount: bigint): ITransaction {
    const base = row();
    return { ...base, amount, extraInputs: { ...base.extraInputs, destinationNetwork: 11155111 } };
  }

  it('confirms a 2 USDCx burn that arrived less the flat fee, under half the amount', async () => {
    stored = onSepolia(2_000_000n);
    const paid = { balance: '5996500', blockNumber: '101' };
    await pollUsdcxDestination(stored, async () => paid);
    expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(paid);
  });

  it('neither reads nor confirms an older burn the allowance takes whole', async () => {
    stored = onSepolia(1_500_000n);
    await pollUsdcxDestination(stored, read);
    expect(read).not.toHaveBeenCalled();
    expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
  });
});
```

`src/lib/usdcx/destination-transaction.test.ts`, the end of the file (:67-69), before:

```ts
  await expect(findUsdcxDestinationTransaction(args)).rejects.toThrow('timeout');
  expect(mockGetLogs).toHaveBeenCalledTimes(1);
});
```

after:

```ts
  await expect(findUsdcxDestinationTransaction(args)).rejects.toThrow('timeout');
  expect(mockGetLogs).toHaveBeenCalledTimes(1);
});

// Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
it('finds a Sepolia payout the flat fee cut under half the amount', async () => {
  mockGetLogs.mockResolvedValueOnce([{ ...transfer, args: { value: 996500n } }]);
  await expect(findUsdcxDestinationTransaction({ ...args, chainId: 11155111, amount: 2_000_000n })).resolves.toBe(hash);
});

it('does not search for a burn the allowance takes whole', async () => {
  await expect(
    findUsdcxDestinationTransaction({ ...args, chainId: 11155111, amount: 1_500_000n })
  ).resolves.toBeUndefined();
  expect(mockGetLogs).not.toHaveBeenCalled();
});
```

`src/lib/usdcx/withdrawal.test.ts:1`, before / after:

```ts
import { encodeBurnWithdrawal, validateUsdcxWithdrawal } from './withdrawal';
```

```ts
import { encodeBurnWithdrawal, UsdcxBurnError, validateUsdcxWithdrawal } from './withdrawal';
```

`:57-62` sends 1 base unit to every destination, which this task refuses, so it sends 2 USDCx (the reason is the new comment), before:

```ts
  it('requires the configured faucet, testnet, positive amount, and a testnet destination chain id', () => {
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 1n)).not.toThrow();
    // Sepolia, Base Sepolia and Arbitrum Sepolia are direct-payout destinations of the burn.
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 1n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 84532, 1n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 421614, 1n)).not.toThrow();
```

after:

```ts
  it('requires the configured faucet, testnet, positive amount, and a testnet destination chain id', () => {
    // 2 USDCx, since a burn must exceed its destination's payout fee allowance (1.5 USDC on Sepolia).
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 2_000_000n)).not.toThrow();
    // Sepolia, Base Sepolia and Arbitrum Sepolia are direct-payout destinations of the burn.
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 2_000_000n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 84532, 2_000_000n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 421614, 2_000_000n)).not.toThrow();
```

`:68-72`, before:

```ts
    network = 'devnet';
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 1n)).toThrow('usdcxUnsupportedFaucet');
    network = 'testnet';
  });
});
```

after:

```ts
    network = 'devnet';
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 1n)).toThrow('usdcxUnsupportedFaucet');
    network = 'testnet';
  });

  // Circle takes its payout fee from the amount: a flat ~1.0035 USDC on Ethereum, against a 1.5 USDC allowance.
  it('refuses a burn its destination fee allowance takes whole, naming the allowance and the chain', () => {
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 1_500_001n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 100_001n)).not.toThrow();
    let refusal: unknown;
    try {
      validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 1_500_000n);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UsdcxBurnError);
    expect(refusal).toMatchObject({
      translationKey: 'usdcxSendMoreThanPayoutFee',
      values: { amount: '1.5', network: 'Sepolia' }
    });
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 100_000n)).toThrow(
      'usdcxSendMoreThanPayoutFee'
    );
  });
});
```

`src/screens/send-flow/SendAmount.test.tsx:16`, the `t` of the react-i18next mock, before / after:

```tsx
    t: (key: string, params?: Record<string, string>) => (params?.value ? `${key}:${params.value}` : key)
```

```tsx
    // A fiat line names its value and a USDCx amount refusal its amount and network; other keys read as themselves.
    t: (key: string, params?: Record<string, string>) =>
      params?.value ? `${key}:${params.value}` : params?.network ? `${key}:${params.amount}:${params.network}` : key
```

`:191-193` (the end of `shows an over-balance error on the amount`), before:

```tsx
    expect(screen.getByTestId('amount-error')).toHaveTextContent('amountMustBeLessThanBalance');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('data-invalid', 'true');
  });
```

after:

```tsx
    expect(screen.getByTestId('amount-error')).toHaveTextContent('amountMustBeLessThanBalance');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('data-invalid', 'true');
  });

  it('fills the error copy with the values the send form hands it', () => {
    renderAmount({
      amount: '1.5',
      network: 'sepolia',
      error: 'usdcxSendMoreThanPayoutFee',
      errorValues: { amount: '1.5', network: 'Sepolia' }
    });

    expect(screen.getByTestId('amount-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee:1.5:Sepolia');
    expect(screen.getByTestId('send-amount-input')).toHaveAttribute('data-invalid', 'true');
  });
```

`src/screens/send-flow/SendManager.test.tsx:165`, in the `./SendAmount` mock, before / after:

```tsx
      <span data-testid="sa-error">{props.error ?? ''}</span>
```

```tsx
      <span data-testid="sa-error">{props.error ?? ''}</span>
      <span data-testid="sa-error-values">{JSON.stringify(props.errorValues ?? null)}</span>
```

`:1789-1792`, the end of `describe('USDCx withdrawal wiring', ...)`, before:

```tsx
    pickToken(otherToken);
    expect(useEpochQuoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ faucetId: 'T1', enabled: true }));
  });
});
```

after:

```tsx
    pickToken(otherToken);
    expect(useEpochQuoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ faucetId: 'T1', enabled: true }));
  });

  // Circle takes a flat ~1.0035 USDC from a Sepolia payout; the allowance a burn there must exceed is 1.5 USDC.
  it('blocks a USDCx amount the Sepolia fee allowance takes whole, naming the allowance and the network', () => {
    // Six decimals, as USDCx has; the shared mock drops them.
    stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.round(parseFloat(s) * 1_000_000)));
    setSendDraft({
      amount: '1.5',
      recipientAddress: '0xrecip',
      tokenId: usdcxToken.id,
      bridgeNetwork: 'sepolia',
      bridgeRoute: 'usdcx'
    });
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: usdcxToken.id, metadata: { symbol: 'USDCx', decimals: 6 }, balance: 100, fiatPrice: 0 }]
    });
    renderFlow();

    expect(screen.getByTestId('sa-error')).toHaveTextContent(/^usdcxSendMoreThanPayoutFee$/);
    expect(screen.getByTestId('sa-error-values')).toHaveTextContent('{"amount":"1.5","network":"Sepolia"}');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');

    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '1.500001' } });
    });
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('true');
  });
});
```

`src/screens/send-flow/ReviewTransaction.test.tsx`, the `t` of the react-i18next mock as Task 13 (`p2-fee-labels`) left it (:113-119 at the start of this task), before:

```tsx
    // The recall note names its amount and a fee label its fee asset; every other key reads as itself.
    t: (key: string, params?: { amount?: string; symbol?: string }) =>
      key === 'recallReturnsNote' && params?.amount
        ? `${key} ${params.amount}`
        : params?.symbol !== undefined
          ? `${key}|${params.symbol}`
          : key
```

after:

```tsx
    // The recall note names its amount, a fee label its fee asset and a USDCx payout line its amount and network;
    // every other key reads as itself.
    t: (key: string, params?: { amount?: string; symbol?: string; network?: string }) =>
      key === 'recallReturnsNote' && params?.amount
        ? `${key} ${params.amount}`
        : params?.symbol !== undefined
          ? `${key}|${params.symbol}`
          : params?.amount !== undefined
            ? [key, params.amount, params.network].filter(part => part !== undefined).join('|')
            : key
```

`:22`, before / after:

```tsx
import { initiateUsdcxBurn } from 'lib/usdcx/burn';
```

```tsx
import { initiateUsdcxBurn } from 'lib/usdcx/burn';
import { UsdcxBurnError } from 'lib/usdcx/withdrawal';
```

`accepts a USDCx deep link targeting %s` (origin/main :474-475) burns 1.000001 USDCx, which Sepolia's allowance now refuses, so it burns 2.000001 (the reason is the new comment), before:

```tsx
  ])('accepts a USDCx deep link targeting %s', async (network, chainId) => {
    mockSearch = mockSearch.replace('network=arc-testnet', `network=${network}`);
```

after:

```tsx
  ])('accepts a USDCx deep link targeting %s', async (network, chainId) => {
    // 2.000001 USDCx, since a burn must exceed its destination's payout fee allowance (1.5 USDC on Sepolia).
    mockSearch = mockSearch
      .replace('network=arc-testnet', `network=${network}`)
      .replace('amount=1.000001', 'amount=2.000001');
```

The end of `describe('USDCx burn review', ...)` (origin/main :513-516), before:

```tsx
    expect(screen.getByTestId('redirect')).toBeInTheDocument();
    expect(initiateUsdcxBurn).not.toHaveBeenCalled();
  });
});
```

after:

```tsx
    expect(screen.getByTestId('redirect')).toBeInTheDocument();
    expect(initiateUsdcxBurn).not.toHaveBeenCalled();
  });

  // Circle takes a flat ~1.0035 USDC from a Sepolia payout; the allowance a burn there must exceed is 1.5 USDC.
  it('disables submission of a burn the Sepolia fee allowance takes whole, naming the allowance and the network', async () => {
    mockSearch = mockSearch.replace('network=arc-testnet', 'network=sepolia').replace('amount=1.000001', 'amount=1.5');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee|1.5|Sepolia');
  });

  it('names the allowance and the network a refused burn carries', async () => {
    jest
      .mocked(initiateUsdcxBurn)
      .mockRejectedValueOnce(
        new UsdcxBurnError('usdcxSendMoreThanPayoutFee', { amount: '0.1', network: 'Arc Testnet' })
      );
    render(<ReviewTransaction />);
    await flush();
    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee|0.1|Arc Testnet')
    );
  });
});
```

Mutation notes (each verified on a scratch copy, which the named test alone fails unless noted):
- `constant.test.ts` `expects a payout of the amount minus the fee allowance, not positive once the allowance takes it whole`: restore the half clause in `minimumUsdcxPayout`; it also fails both new `destination-status` tests, both new `destination-transaction` tests and `names the allowance a burn must exceed...`.
- `names the allowance a burn must exceed and its chain, until the amount exceeds it`: drop `amount <= 0n ||` from `usdcxPayoutFeeShortfall`.
- `confirms a 2 USDCx burn that arrived less the flat fee, under half the amount`: restore the half clause.
- `neither reads nor confirms an older burn the allowance takes whole`: delete `if (minimum <= 0n) return;` in `pollUsdcxDestination`.
- `finds a Sepolia payout the flat fee cut under half the amount`: restore the half clause.
- `does not search for a burn the allowance takes whole`: put `amount <= 0n` back in place of `minimum <= 0n` in the guard.
- `refuses a burn its destination fee allowance takes whole, naming the allowance and the chain`: delete the `if (shortfall) throw` line in `validateUsdcxWithdrawal`.
- `fills the error copy with the values the send form hands it`: call `t(error)` without `errorValues` in SendAmount.
- `blocks a USDCx amount the Sepolia fee allowance takes whole, naming the allowance and the network`: drop `!payoutFeeShortfall &&` from the amount step's `isValidAmount`.
- `disables submission of a burn the Sepolia fee allowance takes whole, naming the allowance and the network`: drop the `payoutFeeShortfall` branch of `burnValidationError`.
- `names the allowance and the network a refused burn carries`: call `t(error.translationKey)` without `error.values` in `runBridgeSend`'s catch.

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx/constant.test.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/destination-transaction.test.ts src/lib/usdcx/withdrawal.test.ts src/screens/send-flow/SendAmount.test.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx --maxWorkers=2
```

Expected: `Test Suites: 7 failed, 7 total` / `Tests:       11 failed, 261 passed, 272 total`, the new tests only:
- `expects a payout of the amount minus the fee allowance, not positive once the allowance takes it whole`: `Expected: 500000n` / `Received: 1000000n`.
- `names the allowance a burn must exceed and its chain, until the amount exceeds it`: `TypeError: (0 , _constant.usdcxPayoutFeeShortfall) is not a function`.
- `confirms a 2 USDCx burn that arrived less the flat fee, under half the amount`: `Expected: {"balance": "5996500", "blockNumber": "101"}` / `Received: undefined`.
- `neither reads nor confirms an older burn the allowance takes whole`: `Expected number of calls: 0` / `Received number of calls: 1`.
- `finds a Sepolia payout the flat fee cut under half the amount`: `Received: undefined`; `does not search for a burn the allowance takes whole`: `Received: "0xaaaa...aaaa"` (the hash).
- `refuses a burn its destination fee allowance takes whole, naming the allowance and the chain`: `Expected constructor: UsdcxBurnError` / `Received value: undefined`.
- `fills the error copy with the values the send form hands it`: expected `usdcxSendMoreThanPayoutFee:1.5:Sepolia`, received `usdcxSendMoreThanPayoutFee`.
- `blocks a USDCx amount the Sepolia fee allowance takes whole, naming the allowance and the network`: expected `/^usdcxSendMoreThanPayoutFee$/`, received empty.
- `disables submission of a burn the Sepolia fee allowance takes whole, naming the allowance and the network`: `Received element is not disabled`.
- `names the allowance and the network a refused burn carries`: expected `usdcxSendMoreThanPayoutFee|0.1|Arc Testnet`, received `usdcxSendMoreThanPayoutFee`.

The two retargeted tests (`requires the configured faucet...` and `accepts a USDCx deep link targeting %s`) pass before and after.

- [ ] **Step 3: Implement**

`src/lib/usdcx/constant.ts:1`, before / after:

```ts
import type { Address, Chain, Hex } from 'viem';
```

```ts
import { Address, Chain, formatUnits, Hex } from 'viem';
```

`:234-243`, before:

```ts
/**
 * The least USDC a burn of `amount` is expected to pay out on `chainId`: the amount minus the chain's fee
 * allowance, and never less than half the amount, so a small burn is not confirmed by an unrelated credit.
 */
export function minimumUsdcxPayout(chainId: number, amount: bigint): bigint {
  const allowance = USDCX_DESTINATIONS.get(chainId)?.payoutFeeAllowance ?? 0n;
  const afterFee = amount - allowance;
  const half = (amount + 1n) / 2n;
  return afterFee > half ? afterFee : half;
}
```

after:

```ts
/**
 * The least USDC a burn of `amount` is expected to pay out on `chainId`: the amount minus the chain's fee allowance.
 * It is not positive when the allowance takes the whole amount. Any unrelated credit meets such a floor, so the wallet
 * refuses that burn (`usdcxPayoutFeeShortfall`) and never confirms an older one by balance.
 */
export function minimumUsdcxPayout(chainId: number, amount: bigint): bigint {
  return amount - (USDCX_DESTINATIONS.get(chainId)?.payoutFeeAllowance ?? 0n);
}

/**
 * The fee allowance a burn of `amount` to `chainId` fails to exceed, in USDCx, and the chain's name, as the refusal
 * names them; undefined once the amount exceeds it, and for no amount or an unknown chain, which other checks refuse.
 */
export function usdcxPayoutFeeShortfall(
  chainId: number,
  amount: bigint
): { amount: string; network: string } | undefined {
  const destination = USDCX_DESTINATIONS.get(chainId);
  if (!destination || amount <= 0n || minimumUsdcxPayout(chainId, amount) > 0n) return undefined;
  return { amount: formatUnits(destination.payoutFeeAllowance, USDCX_DECIMALS), network: destination.chain.name };
}
```

`src/lib/usdcx/destination-status.ts` (origin/main :52-61; :93-102 after Task 17 (`p2-snapshot-retry`), which leaves `pollUsdcxDestination` itself unchanged), before:

```ts
  ) {
    return;
  }

  const observed = await readBalance(extra.destinationNetwork, extra.destinationAddress);
  if (BigInt(observed.blockNumber) <= BigInt(before.blockNumber)) return;
  // Circle deducts its fee from the payout, so the balance rises by less than the sent amount.
  if (BigInt(observed.balance) < BigInt(before.balance) + minimumUsdcxPayout(extra.destinationNetwork, tx.amount)) {
    return;
  }
```

after:

```ts
  ) {
    return;
  }
  // Circle deducts its fee from the payout, so the balance rises by less than the sent amount. A burn the fee
  // allowance takes whole has no floor an unrelated credit could not meet, so it stays at Burn confirmed.
  const minimum = minimumUsdcxPayout(extra.destinationNetwork, tx.amount);
  if (minimum <= 0n) return;

  const observed = await readBalance(extra.destinationNetwork, extra.destinationAddress);
  if (BigInt(observed.blockNumber) <= BigInt(before.blockNumber)) return;
  if (BigInt(observed.balance) < BigInt(before.balance) + minimum) return;
```

`src/lib/usdcx/destination-transaction.ts:25-26`, before:

```ts
  const token = CIRCLE_USDC_ADDRESS.get(chainId);
  if (!chain || !token || !isAddress(recipient) || amount <= 0n) return undefined;
```

after:

```ts
  const token = CIRCLE_USDC_ADDRESS.get(chainId);
  // The payout is the sent amount minus Circle's fee, so match the range the balance check accepts. A burn the fee
  // allowance takes whole has no such range.
  const minimum = minimumUsdcxPayout(chainId, amount);
  if (!chain || !token || !isAddress(recipient) || minimum <= 0n) return undefined;
```

`:41-43`, before:

```ts
  // The payout is the sent amount minus Circle's fee, so match the range the balance check accepts.
  const minimum = minimumUsdcxPayout(chainId, amount);
  const matches = logs.filter(log => !log.removed && log.args.value >= minimum && log.args.value <= amount);
```

after:

```ts
  const matches = logs.filter(log => !log.removed && log.args.value >= minimum && log.args.value <= amount);
```

`src/lib/usdcx/withdrawal.ts:7`, before / after:

```ts
import { USDCX_DESTINATIONS } from './constant';
```

```ts
import { USDCX_DESTINATIONS, usdcxPayoutFeeShortfall } from './constant';
```

`:9-10`, before:

```ts
export class UsdcxBurnError extends Error {
  constructor(readonly translationKey: string) {
```

after:

```ts
export class UsdcxBurnError extends Error {
  /** `values` fills the copy's placeholders, such as the fee allowance a burn must exceed. */
  constructor(
    readonly translationKey: string,
    readonly values?: Record<string, string>
  ) {
```

`:68-69` (`validateUsdcxWithdrawal`'s last check), before:

```ts
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
}
```

after:

```ts
  if (amount <= 0n) throw new UsdcxBurnError('usdcxInvalidAmount');
  // Circle takes its fee from the payout, so a burn its fee allowance takes whole may pay out nothing.
  const shortfall = usdcxPayoutFeeShortfall(destinationChainId, amount);
  if (shortfall) throw new UsdcxBurnError('usdcxSendMoreThanPayoutFee', shortfall);
}
```

`src/screens/send-flow/SendAmount.tsx:31-32`, before:

```tsx
  /** Untranslated error key from the send form. */
  error?: string;
```

after:

```tsx
  /** Untranslated error key from the send form. */
  error?: string;
  /** The values of the error copy's placeholders. */
  errorValues?: Record<string, string>;
```

`:53-55`, before:

```tsx
  isValidAmount,
  error,
  recipientAddress,
```

after:

```tsx
  isValidAmount,
  error,
  errorValues,
  recipientAddress,
```

`:80`, before / after:

```tsx
  const amountError = error && !feeShortfall && (amount || error !== 'invalidAmount') ? t(error) : undefined;
```

```tsx
  const amountError =
    error && !feeShortfall && (amount || error !== 'invalidAmount') ? t(error, errorValues) : undefined;
```

`src/screens/send-flow/SendManager.tsx:24`, before / after:

```tsx
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';
```

```tsx
import { usdcxPayoutFeeShortfall } from 'lib/usdcx/constant';
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';
```

After the route-switching effect (:382-383), before:

```tsx
    if (!usdcxAvailable && bridgeRoute === 'usdcx') setValue('bridgeRoute', 'epoch');
  }, [usdcxAvailable, bridgeRoute, setValue]);
```

after:

```tsx
    if (!usdcxAvailable && bridgeRoute === 'usdcx') setValue('bridgeRoute', 'epoch');
  }, [usdcxAvailable, bridgeRoute, setValue]);

  // A USDCx burn's destination and amount. Circle takes its fee from the payout there, so the amount must exceed it.
  const usdcxPayout = useMemo(() => {
    const chainId =
      usdcxAvailable && isBridge
        ? USDCX_BRIDGE_NETWORKS.find(network => network.id === bridgeNetwork)?.chainId
        : undefined;
    return chainId === undefined || amountBaseUnits === undefined ? undefined : { chainId, amount: amountBaseUnits };
  }, [usdcxAvailable, isBridge, bridgeNetwork, amountBaseUnits]);
  const payoutFeeShortfall = useMemo(
    () => usdcxPayout && usdcxPayoutFeeShortfall(usdcxPayout.chainId, usdcxPayout.amount),
    [usdcxPayout]
  );
```

In the `SelectAmount` case of `renderStep` (:881-882), before:

```tsx
              isValidAmount={!errors.amount && validations.amount.isValidSync(amount)}
              error={errors.amount?.message?.toString()}
```

after:

```tsx
              isValidAmount={!errors.amount && !payoutFeeShortfall && validations.amount.isValidSync(amount)}
              error={errors.amount?.message?.toString() ?? (payoutFeeShortfall && 'usdcxSendMoreThanPayoutFee')}
              errorValues={errors.amount ? undefined : payoutFeeShortfall}
```

In `renderStep`'s dependency list (:921-922), before:

```tsx
      errors.recipientAddress,
      errors.amount,
```

after:

```tsx
      errors.recipientAddress,
      errors.amount,
      payoutFeeShortfall,
```

`src/screens/send-flow/ReviewTransaction.tsx` (origin/main :44; :46 after Task 13), before / after:

```tsx
import { USDCX_DECIMALS } from 'lib/usdcx/constant';
```

```tsx
import { USDCX_DECIMALS, usdcxPayoutFeeShortfall } from 'lib/usdcx/constant';
```

In `runBridgeSend`'s catch (origin/main :443-444; :449-450 after Task 13), before:

```tsx
          error instanceof UsdcxBurnError
            ? t(error.translationKey)
```

after:

```tsx
          error instanceof UsdcxBurnError
            ? t(error.translationKey, error.values)
```

Before `burnValidationError` (origin/main :597; :603 after Task 13), before:

```tsx
  const burnValidationError = !isUsdcxBurn
```

after:

```tsx
  // Circle takes its fee from the payout, so a burn must exceed its destination's fee allowance.
  const payoutFeeShortfall =
    isUsdcxBurn && bridgeNetworkObj && amountBaseUnits !== undefined
      ? usdcxPayoutFeeShortfall(bridgeNetworkObj.chainId, amountBaseUnits)
      : undefined;
  const burnValidationError = !isUsdcxBurn
```

Its last branch (origin/main :604-605; :610-611 after Task 13), before:

```tsx
          ? t('usdcxBelowMinimumBurn')
          : undefined;
```

after:

```tsx
          ? t('usdcxBelowMinimumBurn')
          : payoutFeeShortfall
            ? t('usdcxSendMoreThanPayoutFee', payoutFeeShortfall)
            : undefined;
```

`public/_locales/en/en.json` (edit by hand, never prettier), after `:23`, before:

```json
  "usdcxFaucetUnavailable": "Unable to read the USDCx faucet's burn policy. Reopen review to try again.",
```

after:

```json
  "usdcxFaucetUnavailable": "Unable to read the USDCx faucet's burn policy. Reopen review to try again.",
  "usdcxSendMoreThanPayoutFee": "Send more than $amount$ USDCx to $network$: Circle's fee is taken from the payout.",
```

`public/_locales/en/messages.json` (by hand), after the `usdcxFaucetUnavailable` entry (origin/main :86-89; :96-99 after Task 13), before:

```json
  "usdcxFaucetUnavailable": {
    "message": "Unable to read the USDCx faucet's burn policy. Reopen review to try again.",
    "englishSource": "Unable to read the USDCx faucet's burn policy. Reopen review to try again."
  },
```

after:

```json
  "usdcxFaucetUnavailable": {
    "message": "Unable to read the USDCx faucet's burn policy. Reopen review to try again.",
    "englishSource": "Unable to read the USDCx faucet's burn policy. Reopen review to try again."
  },
  "usdcxSendMoreThanPayoutFee": {
    "message": "Send more than $amount$ USDCx to $network$: Circle's fee is taken from the payout.",
    "englishSource": "Send more than $amount$ USDCx to $network$: Circle's fee is taken from the payout.",
    "placeholders": {
      "amount": {
        "content": "$1"
      },
      "network": {
        "content": "$2"
      }
    }
  },
```

`node -e "JSON.parse(require('fs').readFileSync('public/_locales/en/en.json','utf8'));JSON.parse(require('fs').readFileSync('public/_locales/en/messages.json','utf8'))"` exits 0.

`CLAUDE.md:391-393` (section "USDCx destination confirmation: accepted temporary limits"; the rest of the section stays), before:

```markdown
is the sent amount minus the destination's fee allowance and never less than half
the sent amount (`minimumUsdcxPayout` in `lib/usdcx/constant.ts`, approved
2026-10-10; 0.1 USDC, and 1.5 USDC on Ethereum). Replace the allowance when an API
```

after:

```markdown
is the sent amount minus the destination's fee allowance (`minimumUsdcxPayout` in
`lib/usdcx/constant.ts`, approved 2026-10-11; 0.1 USDC, and 1.5 USDC on Ethereum). The Send flow
refuses a burn that does not exceed that allowance, and an older one it takes whole stays at
`Burn confirmed`. Replace the allowance when an API
```

- [ ] **Step 4: Run the tests, the whole directories, the i18n gates and the type check**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/lib/usdcx/constant.test.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/destination-transaction.test.ts src/lib/usdcx/withdrawal.test.ts src/screens/send-flow/SendAmount.test.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx --maxWorkers=2
yarn jest src/lib/usdcx src/screens/send-flow --maxWorkers=2
yarn jest src/lib/i18n/key-coverage.test.ts src/lib/i18n/locale-bundle-parity.test.ts --maxWorkers=2
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c -e 'lib/usdcx/' -e 'screens/send-flow/'
```

Expected: `Test Suites: 7 passed, 7 total` / `Tests:       272 passed, 272 total`; every suite in both directories passes, 0 failed; `key-coverage.test.ts` passes and `locale-bundle-parity.test.ts` fails the same 27 cases as after Task 14 (`p2-arrival`), no new one (the new key falls under the `es` cases that already fail); the type check prints `0`.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/lib/usdcx/destination-status.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/destination-transaction.ts src/lib/usdcx/destination-transaction.test.ts src/lib/usdcx/withdrawal.ts src/lib/usdcx/withdrawal.test.ts src/screens/send-flow/SendAmount.tsx src/screens/send-flow/SendAmount.test.tsx src/screens/send-flow/SendManager.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx && npx eslint --max-warnings 0 src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/lib/usdcx/destination-status.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/destination-transaction.ts src/lib/usdcx/destination-transaction.test.ts src/lib/usdcx/withdrawal.ts src/lib/usdcx/withdrawal.test.ts src/screens/send-flow/SendAmount.tsx src/screens/send-flow/SendAmount.test.tsx src/screens/send-flow/SendManager.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx
```

Expected: prettier changes nothing, eslint exits 0. Never run prettier on `public/_locales` or `CLAUDE.md`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/usdcx/constant.ts src/lib/usdcx/constant.test.ts src/lib/usdcx/destination-status.ts src/lib/usdcx/destination-status.test.ts src/lib/usdcx/destination-transaction.ts src/lib/usdcx/destination-transaction.test.ts src/lib/usdcx/withdrawal.ts src/lib/usdcx/withdrawal.test.ts src/screens/send-flow/SendAmount.tsx src/screens/send-flow/SendAmount.test.tsx src/screens/send-flow/SendManager.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx public/_locales/en/en.json public/_locales/en/messages.json CLAUDE.md
git diff --cached --name-only | wc -l   # 17
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0 (control: printf '\xe2\x80\x94\n' | LC_ALL=C grep -c -e $'\xe2\x80\x94' prints 1)
git commit -m "fix(usdcx): expect a payout of the amount minus the fee and refuse a burn the fee takes whole"
```

---

### Task 34: Show Circle's fee and the least payout on the USDCx route and review (spec 10(g)) (p2-payout-display)

**Key:** `p2-payout-display`. Runs after Task 33 (`p2-payout-floor`). Spec 10(g), Q15; its commit message is this task's own.

For the destination the send chose, the USDCx route card and the review show two rows from one shared component: "Circle fee: Up to <allowance> USDC" and "You Receive: At least <amount minus allowance> USDC", amounts through `formatUnits(_, 6)` as the review's minimum-burn row formats its amount (trailing zeros trimmed). No Circle API quotes one burn's fee, so both figures come from the allowance. The payout row is left out while the allowance takes the whole amount (Task 33 blocks that amount before either screen submits).

**Files:** (lines at the start of this task, after Tasks 13, 18 and 33; origin/main in brackets where the line exists there; match on text)
- Create: `src/screens/send-flow/UsdcxPayoutRows.tsx`
- Modify: `src/screens/send-flow/Route.tsx` (:11 [:10], :19 [:16], :94 [:91], :97, :116-118, :135-137 [:103-105], :164)
- Modify: `src/screens/send-flow/SendManager.tsx` (:911-912 [:896-897], :951-953 [:935-937])
- Modify: `src/screens/send-flow/ReviewTransaction.tsx` (:59 [:57], :700-701)
- Modify: `public/_locales/en/en.json` (after :24), `public/_locales/en/messages.json` (after :100-112)
- Test: `src/screens/send-flow/Route.test.tsx` (:3, :13-17, :185-187)
- Test: `src/screens/send-flow/ReviewTransaction.test.tsx` (:462-466 [:450-454], :564-567)
- Test: `src/screens/send-flow/SendManager.test.tsx` (:260 [:259], :1818-1821)

**Interfaces:**
- Consumes: `minimumUsdcxPayout`, SendManager's `usdcxPayout` (Task 33 (`p2-payout-floor`)); `USDCX_DESTINATIONS`, `USDCX_DECIMALS` (constant.ts); `DetailCard`, `DetailRow` (components/ui/DetailCard.tsx:29, :72; `DetailRow` forwards `data-testid`); en `usdcxCircleFee` ("Circle fee", en.json:1108) and `youReceive` ("You Receive", en.json:384), both already shipped.
- Produces:
  - `export interface UsdcxPayoutTarget { chainId: number; amount: bigint }` and `export const UsdcxPayoutRows: React.FC<UsdcxPayoutTarget>` in `src/screens/send-flow/UsdcxPayoutRows.tsx`: `DetailRow`s with `data-testid="usdcx-payout-fee"` and `data-testid="usdcx-payout-net"`; nothing for a chain with no allowance.
  - `RouteOptionsProps.usdcxPayout?: UsdcxPayoutTarget` (so `SendRouteProps` carries it through its spread); the USDCx card renders the rows in a `DetailCard` between the card and the burn notice.
  - en `usdcxPayoutFeeUpTo` = `Up to $amount$ USDC`, `usdcxPayoutAtLeast` = `At least $amount$ USDC` (en/messages.json declares `amount`).

- [ ] **Step 1: Write the failing tests**

`src/screens/send-flow/Route.test.tsx:3`, before / after:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
```

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
```

The react-i18next mock Task 13 (`p2-fee-labels`) wrote (:13-17), before:

```tsx
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { symbol?: string }) => (params?.symbol === undefined ? key : `${key}|${params.symbol}`)
  })
}));
```

after:

```tsx
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // A fee label names its asset and a payout row its amount; every other key reads as itself.
    t: (key: string, params?: { symbol?: string; amount?: string }) => {
      const value = params?.symbol ?? params?.amount;
      return value === undefined ? key : `${key}|${value}`;
    }
  })
}));
```

The end of `describe('RouteOptions')`, after Task 18 (`p2-testids-hooks`)'s `marks the withdrawal notice under the USDCx route for the e2e harness` (:185-187), before:

```tsx
    expect(screen.getByTestId('usdcx-burn-notice')).toHaveTextContent('usdcxWithdrawalNotice');
  });
});
```

after:

```tsx
    expect(screen.getByTestId('usdcx-burn-notice')).toHaveTextContent('usdcxWithdrawalNotice');
  });

  // Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
  it.each([
    [11155111, 10_000_000n, '1.5', '8.5'],
    [5042002, 1_000_001n, '0.1', '0.900001']
  ])('shows Circle fee and the least payout for a burn to chain %i', (chainId, amount, fee, payout) => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        usdcxPayout={{ chainId, amount }}
        {...UP}
      />
    );

    const feeRow = within(screen.getByTestId('usdcx-payout-fee'));
    expect(feeRow.getByText('usdcxCircleFee')).toBeInTheDocument();
    expect(feeRow.getByText(`usdcxPayoutFeeUpTo|${fee}`)).toBeInTheDocument();
    const payoutRow = within(screen.getByTestId('usdcx-payout-net'));
    expect(payoutRow.getByText('youReceive')).toBeInTheDocument();
    expect(payoutRow.getByText(`usdcxPayoutAtLeast|${payout}`)).toBeInTheDocument();
  });

  it('leaves out the payout while the fee allowance takes the whole amount', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        usdcxPayout={{ chainId: 11155111, amount: 1_500_000n }}
        {...UP}
      />
    );

    expect(screen.getByTestId('usdcx-payout-fee')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-payout-net')).not.toBeInTheDocument();
  });

  it.each([
    ['before the send has a destination and an amount', undefined],
    ['for a chain that is not a USDCx destination', { chainId: 999, amount: 10_000_000n }]
  ])('shows no payout figures %s', (_case, usdcxPayout) => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        usdcxPayout={usdcxPayout}
        {...UP}
      />
    );

    expect(screen.queryByTestId('usdcx-payout-fee')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-payout-net')).not.toBeInTheDocument();
  });
});
```

`src/screens/send-flow/ReviewTransaction.test.tsx`, the first test of `describe('USDCx burn review')` (origin/main :450-454; :462-466 after Tasks 13 and 33) asserts there is no payout figure, which this task adds, so it asserts the figures instead (the reason is the new comment), before:

```tsx
  it('submits the exact base-unit burn and shows no destination payout estimate', async () => {
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxWithdrawalNotice')).toBeInTheDocument();
    expect(screen.queryByText('youReceive')).not.toBeInTheDocument();
```

after:

```tsx
  it('submits the exact base-unit burn and shows Circle fee and the least payout', async () => {
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxWithdrawalNotice')).toBeInTheDocument();
    // The review now shows the payout Circle's fee leaves, where it used to show no payout figure at all.
    expect(screen.getByText('usdcxPayoutFeeUpTo|0.1')).toBeInTheDocument();
    expect(screen.getByText('usdcxPayoutAtLeast|0.900001')).toBeInTheDocument();
```

The end of the describe, after Task 33's last test (:564-567), before:

```tsx
      expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee|0.1|Arc Testnet')
    );
  });
});
```

after:

```tsx
      expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee|0.1|Arc Testnet')
    );
  });

  // Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
  it('shows the Sepolia fee allowance and the payout it leaves', async () => {
    mockSearch = mockSearch.replace('network=arc-testnet', 'network=sepolia').replace('amount=1.000001', 'amount=10');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxCircleFee')).toBeInTheDocument();
    expect(screen.getByText('usdcxPayoutFeeUpTo|1.5')).toBeInTheDocument();
    expect(screen.getByText('youReceive')).toBeInTheDocument();
    expect(screen.getByText('usdcxPayoutAtLeast|8.5')).toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
  });
});
```

`src/screens/send-flow/SendManager.test.tsx`, in the `./SendRoute` mock (origin/main :259; :260 after Task 33), before:

```tsx
      <span data-testid="route-usdcx">{String(props.usdcxAvailable)}</span>
```

after:

```tsx
      <span data-testid="route-usdcx">{String(props.usdcxAvailable)}</span>
      <span data-testid="route-usdcx-payout">
        {props.usdcxPayout ? `${props.usdcxPayout.chainId}:${props.usdcxPayout.amount}` : ''}
      </span>
```

The end of `describe('USDCx withdrawal wiring', ...)`, after Task 33's test (:1818-1821), before:

```tsx
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('true');
  });
});
```

after:

```tsx
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('true');
  });

  it("hands the Route step the USDCx burn's destination chain and its amount in base units", () => {
    // Six decimals, as USDCx has; the shared mock drops them.
    stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.round(parseFloat(s) * 1_000_000)));
    setSendDraft({
      amount: '2.5',
      recipientAddress: '0xrecip',
      tokenId: usdcxToken.id,
      bridgeNetwork: 'sepolia',
      bridgeRoute: 'usdcx'
    });
    mockCardStack = [{ name: SendFlowStep.Route }];
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: usdcxToken.id, metadata: { symbol: 'USDCx', decimals: 6 }, balance: 100, fiatPrice: 0 }]
    });
    renderFlow();
    expect(screen.getByTestId('route-usdcx-payout')).toHaveTextContent(/^11155111:2500000$/);

    pickToken(otherToken);
    expect(screen.getByTestId('route-usdcx-payout')).toBeEmptyDOMElement();
  });
});
```

Mutation notes (each verified on a scratch copy):
- `shows Circle fee and the least payout for a burn to chain %i` (both cases), and both review tests: render `formatUnits(amount, ...)` instead of `payout` in `UsdcxPayoutRows`.
- `leaves out the payout while the fee allowance takes the whole amount`: drop `payout > 0n &&` (the row then reads `usdcxPayoutAtLeast|0`).
- `shows no payout figures for a chain that is not a USDCx destination`: delete `if (allowance === undefined) return null;` (`formatUnits` throws on `undefined`).
- `shows no payout figures before the send has a destination and an amount`: render the `DetailCard` without `usdcxPayout &&`, falling back to a fixed chain and amount.
- Route's three positive cases: drop `usdcxPayout={usdcxPayout}` from the `UsdcxRouteOption` call.
- `hands the Route step the USDCx burn's destination chain and its amount in base units`: drop `usdcxPayout={usdcxPayout}` from `<SendRoute`.
- `submits the exact base-unit burn and shows Circle fee and the least payout` and `shows the Sepolia fee allowance and the payout it leaves`: delete the `UsdcxPayoutRows` render in ReviewTransaction.tsx.

- [ ] **Step 2: Run the tests and see them fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx src/screens/send-flow/SendManager.test.tsx --maxWorkers=2
```

Expected: `Test Suites: 3 failed, 3 total` / `Tests:       6 failed, 199 passed, 205 total`. Route: both `shows Circle fee and the least payout for a burn to chain %i` cases and `leaves out the payout while the fee allowance takes the whole amount` fail with `TestingLibraryElementError: Unable to find an element by: [data-testid="usdcx-payout-fee"]`. Review: `submits the exact base-unit burn and shows Circle fee and the least payout` with `Unable to find an element with the text: usdcxPayoutFeeUpTo|0.1`, `shows the Sepolia fee allowance and the payout it leaves` with `Unable to find an element with the text: usdcxCircleFee`. SendManager: `hands the Route step...` expects `/^11155111:2500000$/` and receives empty. Both `shows no payout figures %s` cases pass before and after.

- [ ] **Step 3: Implement**

Create `src/screens/send-flow/UsdcxPayoutRows.tsx`:

```tsx
import React from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits } from 'viem';

import { DetailRow } from 'components/ui/DetailCard';
import { minimumUsdcxPayout, USDCX_DECIMALS, USDCX_DESTINATIONS } from 'lib/usdcx/constant';

/** A USDCx burn's destination chain and its amount in USDCx base units. */
export interface UsdcxPayoutTarget {
  chainId: number;
  amount: bigint;
}

/**
 * Circle's fee on a USDCx burn's payout and the least the recipient receives. No Circle API quotes the fee of one
 * burn, so both figures come from the destination's fee allowance. The payout row is left out while the allowance
 * takes the whole amount, which the amount step and the review refuse.
 */
export const UsdcxPayoutRows: React.FC<UsdcxPayoutTarget> = ({ chainId, amount }) => {
  const { t } = useTranslation();
  const allowance = USDCX_DESTINATIONS.get(chainId)?.payoutFeeAllowance;
  if (allowance === undefined) return null;
  const payout = minimumUsdcxPayout(chainId, amount);

  return (
    <>
      <DetailRow label={t('usdcxCircleFee')} data-testid="usdcx-payout-fee">
        {t('usdcxPayoutFeeUpTo', { amount: formatUnits(allowance, USDCX_DECIMALS) })}
      </DetailRow>
      {payout > 0n && (
        <DetailRow label={t('youReceive')} data-testid="usdcx-payout-net">
          {t('usdcxPayoutAtLeast', { amount: formatUnits(payout, USDCX_DECIMALS) })}
        </DetailRow>
      )}
    </>
  );
};
```

`src/screens/send-flow/Route.tsx:11` (origin/main :10), before / after:

```tsx
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
```

```tsx
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
import { DetailCard } from 'components/ui/DetailCard';
```

`:19` (origin/main :16), before / after:

```tsx
import { BridgeRoute } from './types';
```

```tsx
import { BridgeRoute } from './types';
import { UsdcxPayoutRows, UsdcxPayoutTarget } from './UsdcxPayoutRows';
```

`:94` (origin/main :91; the line that closes `RouteOptionsProps`), before:

```tsx
> & { accent?: FlowAccent; slowStatus: AgglayerEligibility };
```

after:

```tsx
> & {
  accent?: FlowAccent;
  slowStatus: AgglayerEligibility;
  /** A USDCx burn's destination and amount, once the send has both: the card shows Circle's fee and the payout. */
  usdcxPayout?: UsdcxPayoutTarget;
};
```

`UsdcxRouteOption`'s signature as Task 13 (`p2-fee-labels`) wrote it (:97), before:

```tsx
const UsdcxRouteOption: React.FC<Pick<RouteOptionsProps, 'route' | 'onRouteChange'>> = ({ route, onRouteChange }) => {
```

after:

```tsx
const UsdcxRouteOption: React.FC<Pick<RouteOptionsProps, 'route' | 'onRouteChange' | 'usdcxPayout'>> = ({
  route,
  onRouteChange,
  usdcxPayout
}) => {
```

In `UsdcxRouteOption`, between the card and the notice `<p>` Task 18 (`p2-testids-hooks`) marked (:116-118), before:

```tsx
        aria-label={t('route')}
      />
      <p className="text-caption text-muted" data-testid="usdcx-burn-notice">
```

after:

```tsx
        aria-label={t('route')}
      />
      {usdcxPayout && (
        <DetailCard>
          <UsdcxPayoutRows chainId={usdcxPayout.chainId} amount={usdcxPayout.amount} />
        </DetailCard>
      )}
      <p className="text-caption text-muted" data-testid="usdcx-burn-notice">
```

`RouteOptions`' destructuring (:135-137; origin/main :103-105), before:

```tsx
  slowAvailability,
  accent = 'brand'
}) => {
```

after:

```tsx
  slowAvailability,
  accent = 'brand',
  usdcxPayout
}) => {
```

The `usdcxAvailable` branch Task 13 wrote (:164), before:

```tsx
    return <UsdcxRouteOption route={route} onRouteChange={onRouteChange} />;
```

after:

```tsx
    return <UsdcxRouteOption route={route} onRouteChange={onRouteChange} usdcxPayout={usdcxPayout} />;
```

`src/screens/send-flow/SendManager.tsx`, in the `Route` case of `renderStep` (origin/main :896-897; :911-912 after Task 33), before:

```tsx
              usdcxAvailable={usdcxAvailable}
              faucetId={spendableToken?.id ?? ''}
```

after:

```tsx
              usdcxAvailable={usdcxAvailable}
              usdcxPayout={usdcxPayout}
              faucetId={spendableToken?.id ?? ''}
```

In `renderStep`'s dependency list (origin/main :935-937; :951-953 after Task 33), before:

```tsx
      bridgeRoute,
      usdcxAvailable,
      onRouteChange,
```

after:

```tsx
      bridgeRoute,
      usdcxAvailable,
      usdcxPayout,
      onRouteChange,
```

`src/screens/send-flow/ReviewTransaction.tsx` (origin/main :57; :59 after Task 13), before / after:

```tsx
import { uiTokenFromBalance } from './ui-token';
```

```tsx
import { uiTokenFromBalance } from './ui-token';
import { UsdcxPayoutRows } from './UsdcxPayoutRows';
```

After the burn fee row Task 13 rewrote (:700-701 at the start of this task), before:

```tsx
                  <DetailRow label={t('networkFee')}>{t('usdcxSponsorshipFee', { symbol: nativeSymbol })}</DetailRow>
                </>
```

after:

```tsx
                  <DetailRow label={t('networkFee')}>{t('usdcxSponsorshipFee', { symbol: nativeSymbol })}</DetailRow>
                  {bridgeNetworkObj && amountBaseUnits !== undefined && (
                    <UsdcxPayoutRows chainId={bridgeNetworkObj.chainId} amount={amountBaseUnits} />
                  )}
                </>
```

`public/_locales/en/en.json` (by hand), after Task 33's `usdcxSendMoreThanPayoutFee` (:24), before:

```json
  "usdcxSendMoreThanPayoutFee": "Send more than $amount$ USDCx to $network$: Circle's fee is taken from the payout.",
```

after:

```json
  "usdcxSendMoreThanPayoutFee": "Send more than $amount$ USDCx to $network$: Circle's fee is taken from the payout.",
  "usdcxPayoutFeeUpTo": "Up to $amount$ USDC",
  "usdcxPayoutAtLeast": "At least $amount$ USDC",
```

`public/_locales/en/messages.json` (by hand), after Task 33's `usdcxSendMoreThanPayoutFee` entry (it ends at :107-112, just before `activityFetchingHistoryAndNotes`), before:

```json
      "network": {
        "content": "$2"
      }
    }
  },
  "activityFetchingHistoryAndNotes": {
```

after:

```json
      "network": {
        "content": "$2"
      }
    }
  },
  "usdcxPayoutFeeUpTo": {
    "message": "Up to $amount$ USDC",
    "englishSource": "Up to $amount$ USDC",
    "placeholders": {
      "amount": {
        "content": "$1"
      }
    }
  },
  "usdcxPayoutAtLeast": {
    "message": "At least $amount$ USDC",
    "englishSource": "At least $amount$ USDC",
    "placeholders": {
      "amount": {
        "content": "$1"
      }
    }
  },
  "activityFetchingHistoryAndNotes": {
```

Both JSON files must still parse (same `node -e` check as Task 33).

- [ ] **Step 4: Run the tests, the whole directory, the i18n gates and the new file's coverage**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; yarn jest src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx src/screens/send-flow/SendManager.test.tsx --maxWorkers=2
yarn jest src/screens/send-flow --maxWorkers=2
yarn jest src/lib/i18n/key-coverage.test.ts src/lib/i18n/locale-bundle-parity.test.ts --maxWorkers=2
JEST_COVERAGE_SHARD=1 yarn jest src/screens/send-flow/Route.test.tsx src/screens/send-flow/ReviewTransaction.test.tsx --maxWorkers=2 --coverage --collectCoverageFrom=src/screens/send-flow/UsdcxPayoutRows.tsx --coverageReporters=text --coverageDirectory="$TMPDIR/p2-payout-display-cov"
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c 'screens/send-flow/'
```

Expected: `Test Suites: 3 passed, 3 total` / `Tests:       205 passed, 205 total`; every `src/screens/send-flow` suite passes, 0 failed; `key-coverage.test.ts` passes and `locale-bundle-parity.test.ts` still fails the same 27 cases, no new one; `UsdcxPayoutRows.tsx` shows 100% statements, branches, functions and lines; the type check prints `0`.

- [ ] **Step 5: Format and lint**

```bash
npx prettier --write src/screens/send-flow/UsdcxPayoutRows.tsx src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/SendManager.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx && npx eslint --max-warnings 0 src/screens/send-flow/UsdcxPayoutRows.tsx src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/SendManager.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx
```

Expected: prettier changes nothing, eslint exits 0. Never run prettier on `public/_locales`.

- [ ] **Step 6: Commit**

```bash
git add src/screens/send-flow/UsdcxPayoutRows.tsx src/screens/send-flow/Route.tsx src/screens/send-flow/Route.test.tsx src/screens/send-flow/SendManager.tsx src/screens/send-flow/SendManager.test.tsx src/screens/send-flow/ReviewTransaction.tsx src/screens/send-flow/ReviewTransaction.test.tsx public/_locales/en/en.json public/_locales/en/messages.json
git diff --cached --name-only | wc -l   # 9
git diff --cached -U0 | grep '^+' | LC_ALL=C grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'   # 0
git commit -m "fix(usdcx): show Circle's payout fee and the least payout on the USDCx route and review"
```

---

## Delivery (PR 1a)

Spec section 14, PR 1, product fixes only. Every command runs from `/Users/celrisen/miden/wt-usdcx-e2e` with `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. No live `yarn e2e:real` run belongs to this PR: the live suites are PR 1b.

- [ ] **Step 1: Commits.** Twelve commits in this order, each made by the task named, messages verbatim, no trailers:

| Spec commit | Task | Message |
|---|---|---|
| 1 | 7 | `fix(usdcx): mark a deposit ready only when Circle's attestation matches what the wallet signed` |
| 2 | 8 | `fix(usdcx): time out stale ready deposits and let a late mint still land them` |
| 3 | 9 | `fix(usdcx): let an unknown-outcome burn await the node's verdict` |
| 4 | 12 | `fix(usdcx): adopt a delivered deposit on every consume landing path` |
| 5 | 13 | `fix(usdcx): name the fee asset in USDCx fee labels` |
| 6 | 14 | `fix(usdcx): show each USDCx deposit source's own arrival time` |
| 7a | 15 | `fix(usdcx): keep a stranded executor leg executable` |
| 7b | 16 | `fix(usdcx): make Sepolia an executor bridge-in source` |
| 7c | 17 | `fix(usdcx): retry the destination balance snapshot before a burn` |
| 8 | 18 | `test(usdcx): burn notice test id and test-hook source chain and row fields` |
| 10(g) | 33 | `fix(usdcx): expect a payout of the amount minus the fee and refuse a burn the fee takes whole` |
| 10(g) | 34 | `fix(usdcx): show Circle's payout fee and the least payout on the USDCx route and review` |

```bash
git log --format=%s origin/main..HEAD | grep -v '^docs(spec)'
git log --format=%B origin/main..HEAD | grep -ci -e 'co-authored' -e 'generated with' -e 'claude' -e 'cursor' -e 'codex'
```

Expected: the twelve subjects above (plus the CHANGELOG commit of Step 2 once made), newest first; `0`.

- [ ] **Step 2: CHANGELOG (the fixes).** Confirm the section, then edit #1100's line and add the fix line. This is the text the 32-task plan's Task 32 Steps 5 and 6 carried for the fixes, with one clause for Tasks 33-34 at the end of the fix line; PR 1b's Task 32 then adds only the suites line.

```bash
git fetch --tags
git tag --list 'v*' --sort=-v:refname | grep -v -e '-rc' | head -1
sed -n 3p CHANGELOG.md
```

Expected: `v1.17.1`, then `## 1.17.2 (TBD)`. If a newer `vX.Y.Z` tag exists, put the new line under the highest `(TBD)` section above it instead (add one if none exists); the #1100 line edit stays wherever that line is.

  (a) Edit #1100's CHANGELOG line.

On `CHANGELOG.md:7` (the line that starts `- [FEATURE][all] Bridge USDC to Miden as USDCx`) replace the substring:

```markdown
through Circle xReserve on Arc Testnet and Sepolia, or through CCTP and the Arc executor from Base Sepolia and Arbitrum Sepolia.
```

with:

```markdown
through Circle xReserve on Arc Testnet, or through CCTP and the Arc executor from Sepolia, Base Sepolia and Arbitrum Sepolia.
```

and, on the same line, the substring:

```markdown
Activity offers manual execution when needed and saves its hash before the receipt wait
```

with:

```markdown
Activity offers manual execution when needed, offers it again when a saved execute transaction has not mined after a while, and saves its hash before the receipt wait
```

  (b) Add the fix line. In `CHANGELOG.md` replace lines 13-15:

```markdown
### Fixes

- [FIX][ci] The live USDCx bridge-IN E2E fails at once when `USDCX_LIVE_EVM_PRIVATE_KEY` is not set, where its spec used to skip and the run passed having tested nothing.
```

(origin/main 6856c9f6a: #1402's line opens the section) with:

```markdown
### Fixes

- [FIX][all] A USDCx deposit reads Confirmed only once Circle's attestation names the network, token, Miden account and amount the wallet signed for, on the xReserve and the executor route alike, and an xReserve deposit Circle attested otherwise fails naming what differs; a delivered deposit reaches Received however its consume completes; a burn whose submission outcome is unknown waits for the node's verdict instead of failing; a deposit left at Confirmed for 7 days times out, and a mint that arrives later still completes it; the USDCx fee labels name the fee asset instead of MIDEN; the arrival estimate follows the source chain (~1 min from Arc Testnet, ~20 min from the others); an executor deposit whose saved execute transaction never mines offers Execute again and is not failed while its message can still be executed; Sepolia deposits go through CCTP and the Arc executor, since Circle's xReserve does not serve Miden from Sepolia; a burn retries its destination balance read, so one failed Arc RPC read no longer stops it before it is queued; and a USDCx burn shows Circle's payout fee and the least the recipient receives on Route and Review, must exceed that fee (1.5 USDC on Ethereum), and reads Confirmed once the destination balance rises by the amount minus the fee, so a paid Ethereum burn under ~2 USDCx no longer stays at Burn confirmed.
- [FIX][ci] The live USDCx bridge-IN E2E fails at once when `USDCX_LIVE_EVM_PRIVATE_KEY` is not set, where its spec used to skip and the run passed having tested nothing.
```

Then:

```bash
git diff -U0 -- CHANGELOG.md | grep '^+' | grep -c -e 'FIX\]\[all\] A USDCx deposit reads Confirmed'
BASE_REF=origin/main NO_CHANGELOG_LABEL=false bash scripts/check-changelog.sh; echo "exit $?"
grep -c 'Fund your wallet asks the faucet for the largest amount' CHANGELOG.md
grep -c 'The live USDCx bridge-in E2E builds against a dispatching pull request' CHANGELOG.md
grep -c 'The live USDCx bridge-IN E2E fails at once' CHANGELOG.md
```

Expected: `1`; `exit 0`; `1` (the Fund-your-wallet line untouched); `1` (#1401's line untouched); `1` (#1402's line untouched). Then:

```bash
git add CHANGELOG.md
git status --short
git commit -m "docs(changelog): USDCx fixes"
git show --stat --format=%B HEAD
```

Expected: exactly `CHANGELOG.md` staged; the body is the single line with no trailer.

- [ ] **Step 3: Local gates (only what CI cannot run for us).**

The changed suites and every test file in their directories:

```bash
yarn jest src/lib/miden/transaction src/lib/miden/activity src/lib/miden/db src/lib/usdcx src/app/templates/EvmConnectModal src/app/templates/history src/screens/send-flow --maxWorkers=2
```

Expected: 0 failed suites except `src/lib/i18n/locale-bundle-parity.test.ts`, which fails exactly the untranslated-key cases Tasks 13 and 14 list (27 after Task 14, still 27 after Tasks 33 and 34; CI translates them). The source-scanning guard tests, `linked-pr-injection.test.ts` included (it must still hold #1401's ceiling line) and #1402's workflow guard:

```bash
yarn jest $(grep -rl -e 'readdirSync' -e 'readFileSync(file' src --include='*.test.ts' --include='*.test.tsx') playwright/e2e/harness/linked-pr-injection.test.ts playwright/e2e/harness/usdcx-live-workflow.test.ts --maxWorkers=2
```

Expected: every suite passes except `src/lib/i18n/locale-bundle-parity.test.ts` (the 27 cases above); `key-coverage.test.ts` passes. Then formatting, lint and the harness ratchet on every changed source and test file (never `public/_locales`, never the two vectors files):

```bash
CHANGED=$(git diff --name-only --diff-filter=ACMR origin/main...HEAD -- '*.ts' '*.tsx' '*.mjs' | grep -v '^docs/')
npx prettier --check $CHANGED
npx eslint --max-warnings 0 $CHANGED
yarn lint:e2e
```

Expected: prettier reports `All matched files use Prettier code style!`, eslint prints nothing, and `lint:e2e` reports no file above its baseline. The dash check, with its positive control, over every added line and every commit message:

```bash
printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/'
git diff -U0 origin/main...HEAD | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
git log --format=%B origin/main..HEAD | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
```

Expected: exactly `control hit`. Mutation checks: for every new product test, write down which test the task's mutation note predicts will fail, then back the file up and mutate in one command, run that file's suite, and restore in the same command, for example:

```bash
F=src/lib/miden/activity/bridge-receive.ts; cp "$F" "$F.mutbak" && perl -0pi -e 's/ &&\n    inputs\.cctp\.executeTxHash === undefined\n/\n/' "$F" && { yarn jest src/lib/miden/activity/bridge-receive.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:|●'; }; mv "$F.mutbak" "$F"
```

Expected for that one: `Tests:       1 failed, 72 passed, 73 total` and `● ... times out an executor row a week after its execute hash was saved`. Record predicted against observed for each; a mutation that fails nothing means the test is inert, and it is fixed before review. `git status --short` must show no `.mutbak` file afterwards. Coverage (95%, jest.config.ts:103-110), the changelog check, `lint:i18n` and locale parity run in CI (Step 8).

- [ ] **Step 4: Review.** A standard whole-branch review on the most capable model (D12, no review-council): base = the fork point on origin/main (`git merge-base origin/main HEAD`), focus on the Review Focus list and the attestation match and shared adopter. Fix each actionable finding with its own new commit (never amend), re-run that file's suite and every test file in its directory, then a scoped re-review of each fix. P3 findings are not fixed or filed.

- [ ] **Step 5: Merge origin/main only if needed.** After review, and only if GitHub reports the PR `CONFLICTING` (CHANGELOG.md is union-merged, so a CHANGELOG line landing on main is the usual cause; KB `github-mergeability-ignores-merge-union`):

```bash
git fetch origin && git fetch --tags
git merge origin/main
git diff origin/main...HEAD -- CHANGELOG.md
```

Resolve hunk by hunk, never by taking one side. Then `yarn install --frozen-lockfile`, re-run Step 3's commands, and check that the new fix line still sits under the highest `(TBD)` section above the latest `v*` tag, that #1100's edited line kept its edit, and that no line this branch removed came back (KB `git-union-merge-resurrects-moved-lines`).

- [ ] **Step 6: Push and open the PR.** Branch `wiktor/usdcx-fixes`.

```bash
BODY="$(mktemp -t usdcx-fixes-body)"
"${EDITOR:-vi}" "$BODY"
perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/' "$BODY"; cat "$BODY"
git push -u origin wiktor/usdcx-fixes
gh pr create --repo 0xMiden/wallet --base main --head wiktor/usdcx-fixes --title "USDCx deposits and burns settle only on matching proof" --body-file "$BODY"
gh pr view --repo 0xMiden/wallet --json body --jq .body
```

Read the body back before and after creating it. Body rules: open with one sentence saying what changed and why it matters; then one-line bullets (the attestation match, adoption on every landing path, burns on the verdict path, the ready-row timeout and late mint, fee labels and arrival, the executor leg, the Sepolia source, the snapshot retry, the Ethereum payout floor and fee display); everything else (decisions Q1-Q15 that shaped behavior, test inventory with counts, the rejected alternatives) in one collapsed `<details>` block; above the fold no more than one screen. Describe the current state only, never review rounds. End with: `**Reviewers:** the attestation match in bridge-receive.ts (matchUsdcxDeposit, both routes) and the shared adopter in bridge-in.ts (adoptBridgeDeliveries, called from six landing paths) are the parts worth your time.` No tool attribution anywhere, and search the body for U+2014 and U+2013 before posting.

- [ ] **Step 7: Push only what review changed.** Each later fix is its own commit, pushed unsquashed; never force-push.

- [ ] **Step 8: CI by head SHA.**

```bash
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse HEAD)" --jq '.total_count, (.workflow_runs[] | "\(.name) | \(.status) | \(.conclusion)")'
```

`total_count` must be non-zero (a push can create no runs; KB `github-actions-push-sometimes-creates-no-runs`). Watch coverage (95% on every metric), the changelog check, `lint:e2e`, `lint:i18n`, locale parity once DeepL commits the translations back, and the linked-PR injection guard. Report each failure as it lands and fix it with a new commit.

## Appendix A: Cross-task interface contract (final)

The contract the tasks were drafted against, with every change made at assembly folded in, so each consumer here uses its producer's final signature. Tasks cite it as "contract N.M" or "interfaces section N".

### A.0 Conventions

- Base: origin/main 6856c9f6a (Setup). Files that differ between cfb228a48 and origin/main and that PR 1 touches or calls: `playwright/e2e/helpers/public-faucet.ts`, `scripts/e2e-real.mjs` (:521 text only), `public/_locales/en/en.json` (+3 lines at :430, so `usdcxArrival` is @main :1093; :4, :6, :17 unchanged), `public/_locales/en/messages.json` (`usdcxArrival` @main :4763; :10, :62 unchanged), `CHANGELOG.md` (#1100 line :7, #1402 line :15, #1401 line :17), `playwright/e2e/harness/linked-pr-injection.test.ts`, `.github/workflows/e2e-usdcx-live.yml`.
- A spec commit spanning several tasks is made by the last of them; the earlier ones end at their green run with "Commit deferred to Task N". That last task stages every path of the commit's file set (A.7).
- File ownership: a task edits only its partition's files, except the edits A.7 lists as ratified at assembly.
- New jest tests under `playwright/` and `scripts/` start with the `@jest-environment node` docblock. New `playwright/**` files add no `lint:e2e` violation (no `toBeGreaterThan(0)`, no `waitForTimeout(>2000)`, no `expect` inside if/else).

### A.1 Product receive side (p1) consumed by p2, p3, p5

`src/lib/miden/db/types.ts`:

```ts
export interface IBridgedReceiveExtraInputs {
  /* ...existing fields unchanged... */
  /** usdcx: the xReserve remoteRecipient bytes32 the wallet signed (0x + 64 lowercase hex), written at the deposit's first phase write. */
  usdcxRemoteRecipient?: string;
  /** Unix seconds at which the row first reached `ready`. Written once, never cleared, kept through `failed`; a ready row from before the stamp gets it as it moves on. */
  readyAt?: number;
}
// IUsdcxCctpLeg gains:
//   executeSavedAt?: number;        // Unix seconds the current executeTxHash was saved, from either side
//   stalledExecuteTxHash?: string;  // an execute unmined past USDCX_EXECUTE_STALL_SEC: never adopted again, still asked about
export interface IConsumedNote { id: string; senderAddress: string; faucetId: string; amount?: bigint }
// ITransaction and ConsumeTransaction gain consumedNotes?: IConsumedNote[] (optional, unindexed, no Dexie version bump).
```

`src/lib/miden/transaction/complete.ts`:

```ts
export const updateBridgedReceivePhase: (
  id: string,
  phase: IBridgedReceivePhase,
  extra?: Partial<Pick<IBridgedReceiveExtraInputs,
    'evmTxHash' | 'intentNonce' | 'midenNoteId' | 'outputAmount' | 'outputSymbol' | 'cctp' | 'error' | 'usdcxRemoteRecipient'>>,
  received?: { amount: bigint; faucetId: string; transactionId?: string },
  options?: { onlyIfNoExecuteHash?: boolean }
) => Promise<void>;
```

It stamps `readyAt` as above and `cctp.executeSavedAt` whenever a write sets an execute hash different from the row's; a reopen naming `revertedExecuteTxHash` or `stalledExecuteTxHash` lands only while the row still holds that hash. Phase rules (`canMoveBridgedReceivePhase`) are unchanged.

`src/lib/usdcx/deposit-target.ts` (new; imports the SDK through `accountRefToSdk`, so the Node harness never imports it):

```ts
export function usdcxRemoteRecipientFor(accountRef: string): Hex;
export function usdcxExpectedRemoteTokenFor(faucetRef: string): Hex;
```

`src/lib/usdcx/attestation.ts` (imports only `viem` and `./constant`): `XReserveAttestation`, `FetchXReserveAttestationsOptions`, `fetchXReserveAttestations`, `findAttestationForDomain` kept; `isUsdcxDepositAttested` removed.

```ts
export const XRESERVE_DEPOSIT_INTENT_MAGIC: Hex; // '0x5a2e0acd'
export const XRESERVE_DEPOSIT_INTENT_VERSION: number; // 1
export interface XReserveDepositIntent {
  version: number; amount: bigint; remoteDomain: number; remoteToken: Hex; remoteRecipient: Hex;
  localToken: Hex; localDepositor: Hex; maxFee: bigint; nonce: Hex; hookData: Hex;
}
export function decodeXReserveDepositIntent(payload: Hex): XReserveDepositIntent | undefined;
export interface UsdcxDepositExpectation { remoteRecipient: Hex; remoteToken: Hex; amount: bigint; remoteDomain?: number }
export type UsdcxAttestationMismatchField = 'remoteDomain' | 'remoteToken' | 'recipient' | 'amount';
export type UsdcxAttestationMatch =
  | { kind: 'attested'; attestation: XReserveAttestation; intent: XReserveDepositIntent }
  | { kind: 'mismatch'; field: UsdcxAttestationMismatchField }
  | { kind: 'unreadable' }
  | { kind: 'pending' };
export function matchUsdcxDepositAttestation(list: readonly XReserveAttestation[], expected: UsdcxDepositExpectation): UsdcxAttestationMatch;
```

Byte layout (captured 0x370bf19a, 240 bytes, no hook): magic@0[4] version@4[4] amount@8[32] remoteDomain@40[4] remoteToken@44[32] remoteRecipient@76[32] localToken@108[32] localDepositor@140[32] maxFee@172[32] nonce@204[32] hookLen@236[4] hookData@240[hookLen]. `src/lib/usdcx/attestation.vectors.json` is Circle's body for that deposit, verbatim plus one trailing newline (sha256 `7be79c54...0e0f`), listed in `.prettierignore`; p3's `arc-usdcx.test.ts` imports it read-only.

Row errors `bridge-receive.ts` writes (phase `failed`): `Circle attested this deposit to a different network.` | `... different token.` | `... different Miden account.` | `... different amount.` (remoteDomain, remoteToken, recipient, amount), and `Bridge delivery timed out.` (`BRIDGE_DELIVERY_TIMED_OUT`, exported from bridge-in.ts). The executor route's mismatch, and `unreadable` and `pending` on both routes, write nothing. A `ready` USDCx row that is not `restoredFromBackup` stays in `readUnsettledRows` for the 7-day cutoff only (counted from `readyAt`); an executor row in `delivering` holding an attested message and no saved execute hash is exempt from the cutoff, and one with a saved hash counts its week from `cctp.executeSavedAt`.

`src/lib/miden/activity/bridge-in.ts`:

```ts
export interface AdoptableNote { id: string; senderAddress: string; faucetId: string; amount?: bigint }
export function adoptableNotesOf(tx: Pick<ITransaction, 'consumedNotes' | 'noteId' | 'noteIds' | 'secondaryAccountId' | 'faucetId' | 'amount'>): AdoptableNote[] | undefined;
export async function adoptBridgeDeliveries(consumeId: string, notes: readonly AdoptableNote[]): Promise<void>; // never throws, idempotent per note
export async function adoptLandedConsume(consumeId: string): Promise<void>; // never throws; Completed, non-restored consumes only
```

A note without its amount, faucet or sender goes to the intent registry pass (by id) only. Six call sites: `completeConsumeTransaction` (executed notes), `writeLanding`, the Guardian landed branch, the loop's landed branch, `tryCompleteKilledConsume`, the stuck-consume reaper (the last five through `adoptLandedConsume`). `takeUsdcxBridgeInInfo` keeps its signature and also takes a `failed` USDCx row with `readyAt` and `Bridge delivery timed out.`, ranked after live rows, at any age.

Status semantics p5 relies on: a `provider: 'usdcx'` bridged-send passes `canAwaitVerdict`, so an unknown submit outcome reads 4 (Unconfirmed); a reconciler landing reads 2 with `extraInputs.usdcxBurn` intact, `displayMessage` `Bridged to EVM` and no `feeAmount`, `resultBytes` or `resultReleasedAt`. A consume reads 2 with its result, or 2 on a landed path; a landed consume of a USDCx mint still moves its bridged-receive row to `received`.

### A.2 Product UI and sources (p2) consumed by p1, p3, p5

- Writers: `runUsdcxDeposit` and `runUsdcxExecutorDeposit` (signatures unchanged) pass `usdcxRemoteRecipient: remoteRecipient.toLowerCase()` in their first `updatePhase(trackingTxId, 'submitting', ...)`; the deposit screen derives the recipient at both sites through `usdcxRemoteRecipientFor(midenAccount.publicKey)`.
- `src/lib/usdcx/constant.ts`: Arc Testnet entries byte-identical (`XRESERVE_ADDRESS.get(5042002) = '0x008888878f94C0d87defdf0B07f46B93C1934442'`, `CIRCLE_USDC_ADDRESS.get(5042002) = '0x3600000000000000000000000000000000000000'`, `CIRCLE_DOMAIN.get(5042002) = 26`, `USDCX_REMOTE_DOMAIN = 10007`, `XRESERVE_ATTESTATION_API_TESTNET = 'https://xreserve-api-testnet.circle.com'`, `USDCX_BURN_TAG = 0x4255524e`, `USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME = 5`). Sepolia in `USDCX_SOURCE_CHAINS` is `executorSource(sepolia, ARC_TESTNET_EXECUTOR)` unless `E2E_USDCX_CHAIN === 'sepolia'`; the address maps keep Sepolia. p1 tests use 5042002 for direct rows and 84532 for executor rows, never 11155111. New: `usdcxArrivalKey(sourceChainId: number): 'usdcxArrivalArc' | 'usdcxArrival'`; `EvmBridgeDepositReview` gains `sourceChainId?: number`, `EvmBridgeUsdcxRoute` gains `sourceChainId: number`.
- Test ids: `data-testid="usdcx-burn-notice"` on the notice `<p>` in Route.tsx (inside the new `UsdcxRouteOption`) and ReviewTransaction.tsx, rendering en `usdcxWithdrawalNotice`. Existing ids unchanged: `send-flow`, `send-recipient-input`, `send-network-options`, `send-network-<id>` with `aria-pressed`, `send-recipient-confirm`, `send-amount-input`, `send-amount-confirm`, `bridge-route-usdcx`, `bridge-route-confirm`, `send-review-submit`, `review-error`, `history-status-pill`.
- English copy: `usdcxMidenFees` = `$symbol$ fees`, `usdcxSponsorshipFee` = `Paid in $symbol$, including faucet execution sponsorship` (messages.json declares `placeholders.symbol`), `symbol` = `resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId).symbol`; `usdcxArrival` stays `~20 min`, new `usdcxArrivalArc` = `~1 min`.
- Test hooks (E2E builds): `CreateBridgeReceiveArgs.sourceChainId?: number` (type only); `__TEST_BRIDGE_RECEIVE_STATE__` and `__TEST_LATEST_BRIDGE_RECEIVE__` also return `evmTxHash`, `error`, `midenNoteId`, `sourceChainId`, `usdcxRemoteRecipient`, `readyAt`; global names unchanged.
- Snapshot retry: `readUsdcxDestinationBalance(chainId, recipient, timeoutMs = 15_000)`; `readUsdcxDestinationSnapshot(chainId, recipient, deps?: UsdcxSnapshotDeps)` tries 3 times, 1 s then 2 s apart, inside one 15 s budget, and rethrows the last error; burn.ts:103 reads through it, so a burn whose every attempt fails still throws before any row is queued.
- `playwright/e2e/ios/helpers/xreserve-fork.ts` reads `XRESERVE_ADDRESS.get(sepolia.id)` and `CIRCLE_USDC_ADDRESS.get(sepolia.id)`, throwing if either is missing; `FORK_USDC_ADDRESS` and `FORK_XRESERVE_ADDRESS` keep their values.
- Payout floor and display (Tasks 33-34, spec 10(g)): `minimumUsdcxPayout(chainId, amount): bigint` keeps its signature and is now the amount minus the destination's allowance alone (`minimumUsdcxPayout(5042002, 10_000_000n)` is still 9_900_000); a floor that is not positive is never confirmed by balance. New `usdcxPayoutFeeShortfall(chainId, amount): { amount: string; network: string } | undefined`. For a USDCx burn, Route and Review render `data-testid="usdcx-payout-fee"` and `data-testid="usdcx-payout-net"`; the amount step and Review refuse an amount that does not exceed the allowance with en `usdcxSendMoreThanPayoutFee`.

### A.3 Shared harness (p3) consumed by p4 and p5

All in `playwright/e2e/helpers/`; product imports use relative paths; `arc-usdcx.ts` never imports `usdcx/deposit.ts`, `executor.ts` or `deposit-target.ts`.

- `usdcx-constants.ts`: `BURN_UNITS`, `DEPOSIT_UNITS`, `GAS_RESERVE_UNITS`, `GRANT_MARGIN_UNITS`, `PAYOUT_TIMEOUT_MS`, `WALLET_CONFIRM_TIMEOUT_MS`, `ARC_LOG_CHUNK`, `ARC_DRPC_LOG_CHUNK`, `GATEWAY_MINTER` (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`), `ATTESTATION_USED_TOPIC` (`0xbb312ce0...fd63`), `ARC_DRPC_URL`, `ARC_QUICKNODE_URL`, `ARC_PUBLIC_URL`, `DEFAULT_ARC_RPCS`, `ARC_KEY_LEDGER_DIR`, `ARC_CHAIN_ID`, `ARC_XRESERVE`, `ARC_USDC`, `ARC_ATTESTATION_API`, `ARC_CIRCLE_DOMAIN`, `GUARDIAN_ECDSA_SCHEME`, `interface ArcClock { now(): number; sleep(ms: number): Promise<void> }`, `realArcClock`, and re-exports of `USDCX_REMOTE_DOMAIN`, `USDCX_BURN_TAG`, `USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME`, `minimumUsdcxPayout`, `FEE_RESERVE_MULTIPLE`.
- `arc-usdcx.ts`: `ArcKey`, `newArcKey()`, `ArcKeyLedgerEntry`, `recordArcKey(key, walletAddress, opts?): string`, `arcEndpoints(override?): string[]` (throws `E2E_ARC_RPC_URL is set but empty`), `ArcClock` and `realArcClock` (re-exported), `ArcPublicClientFactory`, `ArcReadDeps { endpoints; publicClient?; clock? }`, `type ArcWriteDeps = ArcReadDeps` (writes sign locally and send raw through the read client), `readArcUsdc(address, deps, blockNumber?)`, `readXReserveDomainState(deps)` (its `depositor` is the address padded to a lowercase bytes32), `scanArcLogs(client, endpoint, query)`, `GatewayPayout`, `PayoutGateFailure`, `PayoutGateError`, `GatewayPayoutArgs`, `waitForGatewayPayout(args, deps)` (`deadlineMs` is an absolute epoch time, `consumeTsMs + PAYOUT_TIMEOUT_MS`), `DepositSubmission`, `submitDepositToMiden(args, deps)`, `DepositedToRemoteEvent`, `confirmDepositToMiden(submission, deps)`, `waitForXReserveAttestation(depositHash, opts)`, `DecodedDepositIntent`, `decodeDepositIntent(payload)`, `assertDepositIntent(attestation, expected): Promise<{ intent: DecodedDepositIntent; signer: Address }>` (async: viem's `recoverAddress` is async, so callers `await` it), `XRESERVE_HARNESS_ABI`, `LATE_PAYOUT_NOTE`, `errorText`.
- `usdcx-guardian.ts`: `GuardianIdentity`, `guardianIdentity(url, fetchImpl?)`, `guardianFailureContext(identity, fetchImpl?)` (never throws), `assertNoGuardianOpInFlight(rows, accountId)`, `burnFailureMessage(row)`.
- `usdcx-miden.ts` over `usdcx-chain-evidence.mjs` (subcommands `supply`, `burn-evidence`, `burn-outputs`, `mint-note-id`, `note`, `nullifier`, `account-hex`, `recent-notes`; the positional form is gone and fails with its usage line): `ChainEvidenceRunner`, `runChainEvidence`, `bareId`, `accountHex`, `supply`, `BurnEvidence`, `burnEvidence` (throws naming the verdict when the burn was never committed or not consumed, so a returned evidence has `nullifierCommitted: true`), `BurnOutputs`, `burnOutputs` (spike-dependent: decode by role), `deriveUsdcxMintNoteId` (validated on two real mints), `MidenNoteRead` (`committed` equals `found`), `note`, `nullifier`, `recentNotes`, `waitForUsdcxMint`, `boundLandedFee({ vaultDelta, knownTerms, baseFee })` (signed debits: a burn passes V1 - V2 and N + s, a consume of M passes V2 - V3 and -M).
- `history.ts`: `JsonValue`; `TransactionRowSnapshot` gains `extraInputs`, `stageTimestamps`, `submitEvidence`, `resultReleasedAt`, and (only from `readTransactionRowsWithBytes`) `outputNoteIds`, `requestBytes`, `resultBytes`; `TransactionRowsQuery`, `readTransactionRowsInPage(query)`, `readTransactionRowsWithBytes(page, type)`; `TxStatus`, `readTransactionRows`, `readTransactionRow`, `openHistoryDetails` unchanged.
- `bridge.ts`: `UsdcxBalanceSnapshotRow`, `UsdcxBurnRow`, `BridgedSendExtraInputsRow`, `BridgedSendRow` (id, status, stage, stageTimestamps, error, rawError, displayMessage, transactionId, outputNoteIds, requestBytes, feeAmount, feeFaucetId, completedAt, resultBytes, resultReleasedAt, submitEvidence, extraInputs), `readBridgedSendRows(page)`, `bridgedSendRowOf`, `readNativeDisplaySymbol(page, nativeTokenId)`, `enText(key, values?)` (throws on a missing key, a value without its placeholder, or a placeholder left unreplaced), `BridgeOutUsdcxOptions { destAddress; amount; nativeTokenId; nativeSymbol; stepTimeoutMs?; screenshotDir }`, `BridgeOutUsdcxResult`, `bridgeOutUsdcx(wallet, opts)`, `CreateUsdcxBridgeReceiveArgs`, `createUsdcxBridgeReceive(wallet, args)`, `BridgeReceivePhase`, `BridgeReceiveStateSnapshot`, `parseBridgeReceiveState`, `bridgeReceiveState(wallet, txId)`, plus `USDCX_DESTINATION_CHIPS`, `NetworkChipState`, `usdcxChipsProblem`, `reviewQueryParam`, `isArcSnapshotFailure`.
- Existing harness symbols used unchanged: `test`, `expect`, fixtures `walletA`, `envConfig`, `steps`, option `injectFeeFaucet`; `ownsProfile`, `trackGuardianCommitments()`, `waitForGuardianSettled(timeoutMs?)`; `createGuardianWallet(url)`, `assertGuardianAuth(pk, expected)`, `currentGuardianEndpoint()`, `navigateHome()`; `getEnvironmentConfig()`; `walletDiscoveredNativeFaucetId`, `walletDiscoveredBaseFee`, `vaultBalanceOfCurrentAccount`, `waitForVaultBalanceOfCurrentAccount`, `fromBaseUnits`; `mintFromPublicFaucet(baseUrl, accountId)`, `publicFaucetApiUrl(network)`; `waitForPublicNoteCommitment`; `swOf`; `midenAccountHexToXReserveRecipient`; `listPlaywrightTests`.

### A.4 Runner (p4) to the specs (p5): the child environment

Test env of a usdcx suite: `E2E_NETWORK` `'testnet'`, `E2E_REAL_USDCX` `'true'`, `MIDEN_CLIENT_BIN` (the installer's last stdout line, or the operator's export), `E2E_ARC_RPC_URL` only when given, `E2E_ARC_PRIVATE_KEY` as `0x` + 64 hex only for `usdcx-in`, `E2E_HEADLESS` `'1'` unless `--headed` (spike v2 confirmed Q8). Unset: `E2E_SEPOLIA_PRIVATE_KEY` in every usdcx child; `E2E_ARC_PRIVATE_KEY` in builds and in every test but `usdcx-in`'s; `E2E_HEADLESS` in a `--headed` test. `scripts/e2e-real.mjs` exports `run(command, args, env, opts?: { unset?: readonly string[] })`, `childEnvironments(opts, suite, cliBin?)`, `ARC_TESTNET_CHAIN_ID`, `ARC_XRESERVE`, `ARC_USDC`, `ARC_CIRCLE_DOMAIN`, `USDCX_REMOTE_DOMAIN`, `USDCX_DECIMALS`, `XRESERVE_API_TESTNET`, `GATEWAY_MINTER`, `DEFAULT_ARC_RPCS`, `USDCX_GRANT_FLOOR_UNITS`, `USDCX_FUNDED_KEY_FLOOR_UNITS`, `arcRpc`, `circleGet`, `arcRpcEndpoints`, `usdcxGrantProblem`; `e2e-real.test.ts` pins each constant to `usdcx-constants.ts` and `src/lib/usdcx/constant.ts`.

### A.5 Specs (p5) to the runner (p4): configs and titles

- `playwright.usdcx.config.ts`: `{ ...base, testDir: './playwright/e2e/tests/usdcx', testIgnore: undefined, timeout: 3_600_000 }`; `playwright.e2e.config.ts` testIgnore gains `'**/usdcx/**'`.
- `usdcx-roundtrip.spec.ts`: describe `USDCx round trip: burn to a fresh Arc key, Circle payout, deposit back` with test `Guardian wallet: public faucet grant, Send burn, payout and its confirmation, deposit back, receipt` (grep `USDCx round trip`); describe `USDCx bridge-in from a funded Arc key` (timeout 1_800_000) with test `Guardian wallet receives a Node-signed xReserve deposit` (grep `funded Arc key`).
- `usdcx-burn.spec.ts`: describe `USDCx burn through the Send UI after a public faucet grant` (timeout 1_500_000) with tests `standard wallet publishes a burn and the faucet consumes it` and `Guardian wallet publishes a burn and the faucet consumes it` (grep `USDCx burn through the Send UI`).
- Each grep compiles case-insensitive and lists only its own tests. Each spec module loads with no env set.

### A.6 Spec-level strings

POSITIVE hook row: `{ accountId: address, amount: String(M), faucetId: native, sourceChainId: 5042002, sourceAddress: key, sourceAmount: '1', sourceSymbol: 'USDC', evmTxHash: depositHash }`. NEGATIVE: the same with `amount: '2000000000'`, `sourceAddress: '0xe88f781e6cc8b7496f259200b57e22cb9457ff99'`, `sourceAmount: '2000'`, `evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d'`; it ends `failed` with `Circle attested this deposit to a different Miden account.` and is never sampled `ready`.

### A.7 Commit file sets

- Commit 1 (Task 7): `.prettierignore`, `src/lib/miden/db/types.ts`, `src/lib/miden/transaction/complete.ts`, `src/lib/miden/transaction/bridged-receive-phase.test.ts`, `src/lib/usdcx/deposit-target.ts`, `src/lib/usdcx/deposit-target.test.ts`, `src/lib/usdcx/attestation.ts`, `src/lib/usdcx/attestation.test.ts`, `src/lib/usdcx/attestation.vectors.json`, `src/lib/miden/activity/bridge-receive.ts`, `src/lib/miden/activity/bridge-receive.test.ts`, `src/lib/miden/activity/bridge-receive.usdcx.test.ts`, and p2's `src/lib/usdcx/deposit.ts`, `src/lib/usdcx/deposit.test.ts`, `src/lib/usdcx/executor.ts`, `src/lib/usdcx/executor.test.ts`, `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.tsx`, `src/app/templates/EvmConnectModal/EvmBridgeDepositScreen.usdcx.test.tsx` (18 paths).
- Commit 3 (Task 9) also stages `src/lib/miden/transaction/transactions.guardian-offscreen.test.ts` and `src/lib/miden/transaction/transactions.bridged-earn-offscreen.test.ts`: they pin the old exclusion, and the commit is red without them (ratified at assembly).
- Commit 4 (Task 12): every p1 file of Tasks 10-12.
- Commit 9 (Task 24): every p3 file plus `playwright/e2e/helpers/drain-progress.test.ts`, whose expectation pins the old projection (ratified at assembly; 14 paths).
- Commit 11 (Task 27): `playwright.usdcx.config.ts`, `playwright.e2e.config.ts`, `playwright/e2e/harness/spec-selection.test.ts`, `playwright/e2e/tests/usdcx/usdcx-roundtrip.spec.ts`, and the three files p5 adds beyond its list, `playwright/e2e/helpers/usdcx-run.ts`, `usdcx-run.test.ts` and `usdcx-legs.ts` (ratified at assembly: the burn spec shares the legs, and a spec cannot import a spec; 7 paths).
- Commit 12 (Task 28): `playwright/e2e/tests/usdcx/usdcx-burn.spec.ts` (moved from `tests/bridge/bridge-out-usdcx.spec.ts`), `playwright/e2e/harness/spec-selection.test.ts`.
- Commit 10 (Task 31): `scripts/e2e-real.mjs`, `scripts/e2e-real.test.ts`, `scripts/e2e-real.fetch-stub.mjs`; it lands after commit 12.
- Commit 13 (Task 32): `playwright/e2e/docs/e2e-architecture.md`, `CHANGELOG.md`.
