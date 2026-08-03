import { expect, test } from '../fixtures/two-wallets';

const A = 'http://localhost:3000';
const B = 'http://localhost:3001';

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
 * Kill mid-switch -> reopen resumes to a consistent state (never stuck).
 *
 * Holds guardian B's `/register` call open (a 60s Playwright-routed delay --
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
 * the delayed `/register` fetch inside `completeSwitchGuardianTransaction`)
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
  test('kill during finalizeGuardianSwitch (registering-guardian) -> reopen resumes to a consistent state', async ({
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
        await midenCli.sync();

        await walletA.claimAllNotes(180_000);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('initiate_switch_then_kill_mid_register', async () => {
      // Hold every call to B's /register endpoint open for 60s. `pathOf()`
      // matches 'register' as its own endpoint (unlike propose/sign, which
      // live under /delta/proposal) -- see guardian-fault.ts's doc comment.
      walletA.armGuardianFault({ target: 'B', path: 'register', mode: 'delay', delayMs: 60_000 });

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
      // /register request the service worker dispatched before kill() --
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
 * fails B's first 2 `/register` calls (HTTP 500 -- see `guardian-fault.ts`'s
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
  test('transient register failures on B -> backoff recovers, switch completes', async ({
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
        await midenCli.sync();

        await walletA.claimAllNotes(180_000);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'switch_survives_two_register_faults',
      async () => {
        // Arm BEFORE switchGuardian so the very first /register call (fired
        // from inside completeSwitchGuardianTransaction once the confirmed
        // proposal executes) already lands on the faulted path -- there is no
        // window where an unfaulted register could sneak through first.
        walletA.armGuardianFault({ target: 'B', path: 'register', mode: 'failFirstN', count: 2 });

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

/**
 * Best-effort push fault on the OLD guardian (A) -> switch to B still
 * completes.
 *
 * This is a REGRESSION GUARD, not a discovery test: per the #369
 * investigation, `executeProposal`'s post-submit path does a BEST-EFFORT
 * `getDeltaProposal` + `pushDelta` against the PRE-SWITCH (old) guardian,
 * wrapped in a swallowing try/catch specifically so an unreachable/faulty old
 * guardian can never block the switch -- the new guardian (B) is the one
 * `completeSwitchGuardianTransaction`'s register step actually depends on.
 * Faulting `path: 'delta'` on `target: 'A'` hits exactly that best-effort
 * push: A3's caveat (see guardian-fault.ts / the smoke suite) is that
 * propose/sign/push all live under `/delta*`, so `'delta'` matches all three
 * -- irrelevant here since this scenario never issues a NEW proposal against
 * A after the switch, only the one best-effort push the switch itself makes.
 * `mode: 'status500'` (not `failFirstN`) is deliberate: it fails EVERY
 * matching request for as long as the fault stays armed, so there is no
 * window where an unfaulted push could sneak through and mask a real
 * swallow-failure -- if the wallet's try/catch around this push has a gap
 * (e.g. it awaits before the catch, or rethrows), this permanent-fail policy
 * is what would surface it as a hang or thrown error instead of letting one
 * lucky retry paper over it.
 *
 * Expected GREEN on `main`: the push is already best-effort/swallowed in
 * `executeProposal`. If this goes red, that is a real regression -- the
 * switch wrongly blocks on the old guardian's unrelated push -- and the
 * Product-Fix Protocol applies against that candidate location, not a new
 * invention.
 *
 * `assertGuardianAuth`'s `guardianCommitment` pin (not just signerCount/
 * threshold) is required for the same reason as the sibling specs in this
 * suite: signerCount/threshold describe the `[hot, cold]` multisig shape,
 * which a guardian switch never touches -- only the separate guardian-
 * commitment slot changes, so that's the field that actually proves the
 * switch (not just "didn't hang") landed on B.
 */
test.describe('Guardian switch stress - old-guardian push fault', () => {
  test('old-guardian best-effort push failing must not block the switch', async ({ walletA, midenCli, steps }) => {
    // Create/fund/claim plus the switch itself -- comfortable headroom over
    // the base config's 300s default, matching the sibling specs' budget.
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
        await midenCli.sync();

        await walletA.claimAllNotes(180_000);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'switch_survives_faulted_old_guardian_push',
      async () => {
        // Arm BEFORE switchGuardian so the switch's best-effort push back to
        // A -- issued as part of executeProposal's post-submit path -- is
        // already faulted on its first (and every subsequent) attempt.
        walletA.armGuardianFault({ target: 'A', path: 'delta', mode: 'status500' });

        // Must complete regardless: the push to the OLD guardian is
        // best-effort and swallowed, so the switch's own success criterion
        // (register on B, transaction reaches Completed) is unaffected.
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
  test('A -> B -> A round-trip keeps guardian state consistent, still usable', async ({
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
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);
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
        await walletA.sendTokens({ recipientAddress: addressB!, amount: '1', isPrivate: false, tokenSymbol: 'TST' });
        const balanceB = await walletB.waitForBalanceAbove(0, 120_000);
        expect(balanceB).toBeGreaterThan(0);
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
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);
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
