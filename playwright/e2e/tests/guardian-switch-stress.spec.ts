import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { toBaseUnits, vaultBalance, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';

// The faucet every test in this file deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// Minted to wallet A in each test's create_on_a_and_fund step, in base units --
// the literal passed to `midenCli.mint(...)` below.
const FUND_BASE_UNITS = 100_000_000_000n;
// The `amount: '1'` handed to `sendTokens` in the round-trip test, in base units.
const SEND_BASE_UNITS = toBaseUnits('1', TOKEN_DECIMALS);

// Switch-stress needs TWO distinct guardian operators: A the wallet's own,
// B the one it switches to. Local containers on localhost; the real operators
// on testnet (OpenZeppelin A -> Koda B). Fault injection keys on these origins
// (harness/guardian-fault.ts), so the spec exercises whichever guardians the
// wallet actually talks to on this network.
const envConfig = getEnvironmentConfig();
const A = envConfig.guardianUrl;
if (!envConfig.guardianUrlB) {
  throw new Error(`E2E_NETWORK=${envConfig.name} has no second guardian (guardianUrlB) configured for switch tests`);
}
const B = envConfig.guardianUrlB;

/**
 * Guardian commitment (the on-chain `GUARDIAN_SLOT_NAMES.PUBLIC_KEY` value)
 * for a given guardian operator, read straight from its own `GET
 * /pubkey?scheme=ecdsa` endpoint -- duplicated from guardian-switch.spec.ts
 * rather than shared (this suite's existing per-file style; see that file's
 * own doc comment for why `assertGuardianAuth`'s `guardianCommitment` is the
 * assertion that actually proves a switch landed).
 */
async function guardianCommitment(endpoint: string): Promise<string> {
  const res = await fetch(`${endpoint}/pubkey?scheme=ecdsa`);
  if (!res.ok) {
    throw new Error(`guardianCommitment: GET ${endpoint}/pubkey?scheme=ecdsa failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { commitment: string };
  return body.commitment;
}

/**
 * Kill mid-switch, then reopen resumes to a consistent state (never stuck).
 *
 * Holds guardian B's `/configure` call open (a 60s Playwright-routed delay --
 * see `harness/guardian-fault.ts`) so the switch is provably still mid-flight
 * -- `completeSwitchGuardianTransaction` (`transaction/complete.ts`) persists
 * `stage: 'registering-guardian'` to the tx row BEFORE issuing that call, so
 * `waitForStage` observing it is proof the register HTTP round-trip is
 * genuinely in progress -- then `kill()`s the wallet (closes the page,
 * nothing else) at that exact moment, reopens, and asserts the wallet ends
 * up in exactly one consistent state: switched to B, never stuck.
 *
 * `switchGuardian(B)` is deliberately invoked WITHOUT awaiting: its own
 * internal completion-wait (`waitForTransactionRowComplete`) would otherwise
 * still be polling when we `kill()`, and killing the page it's polling
 * through makes that promise reject -- expected and swallowed via
 * `.catch(() => {})` below. The reopen step re-derives ground truth
 * independently (fresh page, IndexedDB/on-chain reads), so it never depends
 * on that promise resolving either way.
 *
 * Load-bearing subtlety about what `kill()` does and doesn't prove: per its
 * doc comment (`helpers/wallet-page.ts`), `kill()` closes only the Playwright
 * PAGE -- the extension service worker (which is what's actually awaiting
 * the delayed `/configure` fetch inside `completeSwitchGuardianTransaction`)
 * is left completely untouched, so that in-flight call keeps running in the
 * background regardless of the page's lifecycle and will resolve on its own
 * once the armed delay elapses. That means this scenario primarily proves
 * the FRONTEND never gets stuck/inconsistent across a page teardown mid-
 * switch (a real user closing the wallet tab) -- it does not exercise a true
 * service-worker-death orphan-recovery path (Chrome evicting the MV3 SW
 * itself), since forcing that reliably from Playwright was already ruled out
 * as unreliable (`chrome.runtime.reload()` -- see reopen()'s doc comment).
 * If the wallet DOES also handle a real SW death, that resume machinery
 * already exists as `setupTransactionProcessor`'s startup sweep
 * (`back/transaction-processor.ts`) plus the periodic stuck-tx self-heal
 * alarm -- but this spec's `kill()` cannot force that path to run, so a
 * green result here does not by itself confirm SW-death recovery. Noted
 * explicitly rather than silently claiming broader coverage than the test
 * actually exercises.
 */
test.describe('Guardian switch stress - kill mid-switch resumes', () => {
  test('kill during finalizeGuardianSwitch (registering-guardian), then reopen resumes to a consistent state', async ({
    walletA,
    midenCli,
    steps
  }) => {
    // The armed register delay alone is 60s, plus create/fund/claim and the
    // post-reopen settle poll -- comfortable headroom over the base config's
    // 300s default, matching the sibling guardian-switch specs' budget.
    test.setTimeout(600_000);

    const commitmentB = await guardianCommitment(B);

    let addressA: string;

    await steps.step(
      'create_on_a_and_fund',
      async () => {
        const createdA = await walletA.createGuardianWallet(A);
        addressA = createdA.address;

        await midenCli.init();
        const faucetId = await midenCli.createFaucet();
        await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
        // Discovery BEFORE claim: claimAllNotes stops on two empty pending reads,
        // which is also true before the note has synced — claiming too early
        // returns "drained" having consumed nothing, and the vault pin below then
        // fails on a healthy run. Seen for real in guardian-switch.spec.ts.
        await waitForPendingNoteTotal(walletA.page, TOKEN, FUND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await midenCli.sync();

        await walletA.claimAllNotes(180_000);

        // claimAllNotes only drains the pending-note list; it does not prove the
        // money became SPENDABLE. Pin the exact funded vault balance so a claim
        // that silently no-oped fails here, in setup, instead of surfacing later
        // as an unrelated switch/send failure. Fees are paid in native MIDEN, not
        // TST, so the claimed note lands in the vault in full.
        await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('initiate_switch_then_kill_mid_register', async () => {
      // Hold every call to B's /configure endpoint open for 60s. `pathOf()`
      // matches 'configure' as its own endpoint (unlike propose/sign, which
      // live under /delta/proposal and are faulted via path: 'delta') -- see
      // guardian-fault.ts's doc comment.
      walletA.armGuardianFault({ target: 'B', path: 'configure', mode: 'delay', delayMs: 60_000 });

      // Fire-and-forget: don't await switchGuardian's own UI-drive +
      // completion-wait, so we can kill() out from under it mid-flight.
      void walletA.switchGuardian(B).catch(() => {});

      // Proof the register HTTP call is genuinely in flight (stage is
      // persisted to the tx row before the call is issued -- see this
      // test's own doc comment above).
      await walletA.waitForStage('registering-guardian');

      // Terminate the wallet mid-flight. Deliberately NOT wrapped in a
      // screenshotWallets capture: TestStepRunner takes the screenshot AFTER
      // this function resolves, and the page it would target is the one
      // kill() just closed.
      await walletA.kill();
    });

    await steps.step('reopen_resumes_to_a_consistent_state', async () => {
      await walletA.reopen();
      walletA.clearFaults();

      // The 60s delay armed above is already in flight against the ORIGINAL
      // /configure request the service worker dispatched before kill() --
      // clearFaults() only stops NEW requests from being faulted, it can't
      // rescind an already-scheduled delay. Poll generously so this
      // assertion is meaningful whichever path the wallet actually took:
      // already completed on B by the time we get here, still finishing out
      // the delayed call, or recovered via the SW's own orphan-resume sweep.
      // Whichever it is, the wallet must land in exactly ONE consistent
      // state -- never stuck -- so retry the same real assertions rather
      // than asserting a specific intermediate path.
      const deadline = Date.now() + 150_000;
      for (;;) {
        try {
          await walletA.assertGuardianAuth(addressA, {
            signerCount: 2,
            threshold: 2,
            guardianCommitment: commitmentB
          });
          await expect(walletA.currentGuardianEndpoint()).resolves.toBe(B);
          return;
        } catch (err) {
          if (Date.now() >= deadline) throw err;
          await new Promise(resolve => setTimeout(resolve, 5_000));
        }
      }
    });
  });
});

/**
 * Transient register faults on B -> the wallet's own retry/backoff recovers,
 * switch still completes.
 *
 * Unlike the kill-mid-switch scenario above (which proves the FRONTEND never
 * gets stuck across a page teardown), this one targets a narrower claim:
 * `completeSwitchGuardianTransaction`'s register step
 * (`src/lib/miden/transaction/complete.ts`) calls into the guardian client's
 * register-with-retry path -- candidate `registerOnGuardianWithRetry` /
 * `MAX_GUARDIAN_REGISTER_RETRIES` in `src/lib/miden/guardian/index.ts`
 * (~521-543) -- and that path must itself survive a bounded number of
 * transient register failures via its own backoff, without the caller doing
 * anything special. `armGuardianFault({ mode: 'failFirstN', count: 2 })`
 * fails B's first 2 `/configure` calls (HTTP 500 -- see `guardian-fault.ts`'s
 * `fulfill500` action for `failFirstN`) and lets every call after that
 * through untouched, so the ONLY way `switchGuardian(B)` resolves is if the
 * wallet retried at least twice before giving up. If the wallet's retry
 * budget is smaller than 2 (or has no backoff at all), `switchGuardian` will
 * throw (the transaction lands `Failed`, or `waitForTransactionRowComplete`
 * times out) and this test goes red -- the Product-Fix Protocol then applies
 * against that candidate location, not a new invention.
 *
 * `assertGuardianAuth`'s `guardianCommitment` pin (not just signerCount/
 * threshold) is required for the same reason as the sibling specs in this
 * suite: signerCount/threshold describe the `[hot, cold]` multisig shape,
 * which a guardian switch never touches -- only the separate guardian-
 * commitment slot changes, so that's the field that actually proves the
 * switch (not just the retry) landed on B.
 */
test.describe('Guardian switch stress - register fault retries', () => {
  test('transient register failures on B then backoff recovers, switch completes', async ({
    walletA,
    midenCli,
    steps
  }) => {
    // Two faulted register attempts plus whatever backoff delay the wallet
    // uses between them, on top of create/fund/claim -- comfortable headroom
    // over the base config's 300s default, matching the sibling specs' budget.
    test.setTimeout(600_000);

    const commitmentB = await guardianCommitment(B);

    let addressA: string;

    await steps.step(
      'create_on_a_and_fund',
      async () => {
        const createdA = await walletA.createGuardianWallet(A);
        addressA = createdA.address;

        await midenCli.init();
        const faucetId = await midenCli.createFaucet();
        await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
        // Discovery BEFORE claim: claimAllNotes stops on two empty pending reads,
        // which is also true before the note has synced — claiming too early
        // returns "drained" having consumed nothing, and the vault pin below then
        // fails on a healthy run. Seen for real in guardian-switch.spec.ts.
        await waitForPendingNoteTotal(walletA.page, TOKEN, FUND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await midenCli.sync();

        await walletA.claimAllNotes(180_000);

        // claimAllNotes only drains the pending-note list; it does not prove the
        // money became SPENDABLE. Pin the exact funded vault balance so a claim
        // that silently no-oped fails here, in setup, instead of surfacing later
        // as an unrelated switch/send failure. Fees are paid in native MIDEN, not
        // TST, so the claimed note lands in the vault in full.
        await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'switch_survives_two_register_faults',
      async () => {
        // Arm BEFORE switchGuardian so the very first /configure call (fired
        // from inside completeSwitchGuardianTransaction once the confirmed
        // proposal executes) already lands on the faulted path -- there is no
        // window where an unfaulted register could sneak through first.
        walletA.armGuardianFault({ target: 'B', path: 'configure', mode: 'failFirstN', count: 2 });

        // Must survive exactly 2 register failures via the wallet's own
        // retry/backoff; switchGuardian awaits the transaction to Completed
        // and throws on Failed or timeout (see waitForTransactionRowComplete).
        await walletA.switchGuardian(B);

        walletA.clearFaults();

        await walletA.assertGuardianAuth(addressA!, {
          signerCount: 2,
          threshold: 2,
          guardianCommitment: commitmentB
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});

// NOTE: "old-guardian best-effort push does not block the switch" is intentionally
// NOT an e2e test. The property is guaranteed by executeProposal's swallowing
// try/catch (the #369 investigation), but it cannot be isolated with path-based
// fault injection: a switch FROM guardian A co-signs its own switch proposal via
// A over /delta*, so faulting A's /delta 500s the REQUIRED co-sign and the switch
// legitimately fails -- that is not the best-effort post-submit push. Timing-gating
// the fault to only the post-submit window is flaky. Covered by code analysis plus
// the kill-mid-switch resilience test above.

/**
 * Repeat A -> B -> A round-trip -> no drift, still usable.
 *
 * The happy-path spec (`guardian-switch.spec.ts`) only ever switches once
 * (A -> B). A single switch can't rule out state that only drifts on a
 * SECOND transition -- e.g. a per-account endpoint write that overwrites
 * cleanly the first time but leaves a stale value (or a stale in-memory
 * `MultisigService` pointed at the wrong operator) behind after switching
 * back. Round-tripping back to the ORIGINAL guardian (A) is the one
 * switch-target that lets an assertion catch that: any drift would land on
 * `commitmentA` failing to match after the second switch, since A's real
 * commitment never changes underneath the test.
 *
 * `assertGuardianAuth`'s `guardianCommitment` pin (not just signerCount/
 * threshold) is required for the same reason as every sibling spec in this
 * suite: signerCount/threshold describe the `[hot, cold]` multisig shape,
 * which a guardian switch never touches -- only the separate guardian-
 * commitment slot changes, so that's the field that actually proves each
 * leg of the round-trip landed (not just "didn't hang").
 *
 * The final `sendTokens` re-proves the account is genuinely usable after the
 * round-trip -- exercising `createSendProposal` against A's co-signature one
 * more time -- rather than trusting the auth-shape assertion alone. Sending
 * to a second, independent wallet (mirroring `guardian-switch.spec.ts`)
 * because the wallet deliberately blocks a self-send
 * (`SendManager.tsx`'s `cannotSendToSelf` guard).
 */
test.describe('Guardian switch stress - repeat round-trip', () => {
  test('A to B to A round-trip keeps guardian state consistent, still usable', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    // Two full switches (each with its own canonicalization wait against a
    // local guardian) plus create/fund/claim and a final send -- comfortable
    // headroom over the base config's 300s default, matching the sibling
    // specs' budget.
    test.setTimeout(600_000);

    const commitmentA = await guardianCommitment(A);
    const commitmentB = await guardianCommitment(B);
    expect(commitmentA, 'guardian A and B must be distinct operators for this test to mean anything').not.toBe(
      commitmentB
    );

    let addressA: string;
    let addressB: string;
    let faucetId: string;

    await steps.step('create_on_a_and_fund', async () => {
      const createdA = await walletA.createGuardianWallet(A);
      addressA = createdA.address;
      const createdB = await walletB.createNewWallet();
      addressB = createdB.address;

      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
      // Discovery BEFORE claim — see the note in the first test of this file.
      await waitForPendingNoteTotal(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);

      // Same exact funding pin as the other tests in this file: claimAllNotes
      // draining the pending list is not the same as the money being spendable,
      // and both of these tests go on to spend it.
      await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'round_trip_a_to_b_to_a',
      async () => {
        await walletA.switchGuardian(B);
        await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });

        await walletA.switchGuardian(A);
        await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'usable_after_round_trip',
      async () => {
        // Snapshot A's SPENDABLE balance before the send so the debit below is
        // asserted against what A actually held, not against the funding constant.
        const vaultABefore = await vaultBalance(walletA.page, TOKEN);

        await walletA.sendTokens({ recipientAddress: addressB!, amount: '1', isPrivate: false, tokenSymbol: 'TST' });

        // B never claims, so this public send lands in B as an UNCONSUMED note --
        // exactly 1 TST of it, not "some non-zero number for some token". Only
        // native-faucet notes auto-consume (back/sync-manager.ts), so a TST note
        // stays pending, which is why this is the note total and not the vault.
        await waitForPendingNoteTotal(walletB.page, TOKEN, SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        // The other half of "still usable": A must actually have PAID. A credit
        // to B without a matching debit on A is the bug the old `> 0` on B alone
        // could never see. Exact, because the fee asset is native MIDEN, not TST.
        await waitForVaultBalance(walletA.page, TOKEN, vaultABefore - SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );
  });
});

/**
 * Concurrent send + switch on the SAME account -> serialize cleanly, both
 * settle, account ends internally consistent.
 *
 * Both `sendTokens` and `switchGuardian` on a Guardian account route through
 * `generateTransaction`'s guardian branch (`src/lib/miden/transaction/index.ts`
 * ~144), which wraps the actual work in `withGuardianAccountLock(canonicalWalletAccountId(...))`
 * (~153) -- a per-account promise chain that serializes every guardian
 * transaction so at most one is ever in flight (see `guardian/serialize.ts`'s
 * doc comment: the guardian only co-signs one delta per account at a time,
 * and concurrent same-account deltas stall canonicalization for minutes --
 * OpenZeppelin/guardian#303). Firing both from the SAME account via
 * `Promise.all` is the direct way to exercise that lock rather than trust it
 * by inspection.
 *
 * `sendTokens` resolves as soon as its submit button detaches (the UI's
 * "accepted" signal), well before the underlying tx clears the guardian
 * lock -- unlike `switchGuardian`, which awaits its own transaction row to
 * `Completed` internally. So `Promise.all` settling only proves both UI
 * submissions were accepted, not that both finished processing;
 * `waitForQueueDrained()` is what actually waits for the lock to release
 * both queued rows to a terminal state.
 *
 * This test deliberately does NOT assert which operation "won" the race --
 * either order (send-then-switch or switch-then-send) is a legitimate
 * outcome of a first-come-first-served lock, and the design doc's scope
 * boundary (§2) only requires the wallet-observable outcome to be
 * consistent, not a specific interleaving. So the expected guardian
 * commitment is derived from whatever `currentGuardianEndpoint()` resolves
 * to post-drain (A if the switch lost the race or itself failed, B if it
 * won) -- what corruption under a broken lock would actually look like is
 * `currentGuardianEndpoint()` reporting one guardian while the on-chain
 * commitment (`assertGuardianAuth`'s `guardianCommitment`) reflects the
 * other, which this catches regardless of which guardian ends up active.
 */
test.describe('Guardian switch stress - concurrent send + switch', () => {
  test('concurrent send + switch on the same account serialize cleanly', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    // Two guardian transactions serialized through the same account lock,
    // plus create/fund/claim and the post-drain settle poll -- comfortable
    // headroom over the base config's 300s default, matching the sibling
    // specs' budget.
    test.setTimeout(600_000);

    let addressA: string;
    let addressB: string;

    await steps.step('create_on_a_and_fund', async () => {
      const createdA = await walletA.createGuardianWallet(A);
      addressA = createdA.address;
      const createdB = await walletB.createNewWallet();
      addressB = createdB.address;

      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
      // Discovery BEFORE claim — see the note in the first test of this file.
      await waitForPendingNoteTotal(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);

      // Same exact funding pin as the other tests in this file: claimAllNotes
      // draining the pending list is not the same as the money being spendable,
      // and both of these tests go on to spend it.
      await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'concurrent_send_and_switch_serialize_cleanly',
      async () => {
        // Fire both concurrently against the SAME account. Each `.catch(() =>
        // {})` swallows a legitimate loser-of-the-race rejection (e.g. a send
        // that ends up queued behind the switch and is still processing when
        // this Promise.all would otherwise reject on an unrelated timeout) --
        // the real assertions below independently re-derive ground truth
        // after the queue drains, so they don't depend on either promise
        // resolving a particular way.
        await Promise.all([
          walletA
            .sendTokens({ recipientAddress: addressB!, amount: '1', isPrivate: false, tokenSymbol: 'TST' })
            .catch(() => {}),
          walletA.switchGuardian(B).catch(() => {})
        ]);

        // Both operations' rows may still be Queued/GeneratingTransaction at
        // this point (see the describe-level doc comment on why
        // `sendTokens`'s own resolution doesn't prove that) -- wait for the
        // per-account guardian lock to actually finish serializing them.
        await walletA.waitForQueueDrained();

        const finalEndpoint = await walletA.currentGuardianEndpoint();
        expect([A, B], 'currentGuardianEndpoint must resolve to one of the two known guardians').toContain(
          finalEndpoint
        );

        // Internal-consistency check: whichever guardian the wallet believes
        // it's on must match the guardian ACTUALLY active on chain -- the
        // failure mode a broken lock produces is exactly this kind of split
        // (persisted endpoint says one guardian, on-chain commitment says
        // the other), not necessarily a hang or thrown error.
        const finalCommitment = await guardianCommitment(finalEndpoint);
        await walletA.assertGuardianAuth(addressA!, {
          signerCount: 2,
          threshold: 2,
          guardianCommitment: finalCommitment
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
