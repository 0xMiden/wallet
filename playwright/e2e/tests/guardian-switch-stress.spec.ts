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
