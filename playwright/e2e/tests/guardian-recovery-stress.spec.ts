import { expect, test } from '../fixtures/two-wallets';

const A = 'http://localhost:3000';

/**
 * Guardian commitment (the on-chain `GUARDIAN_SLOT_NAMES.PUBLIC_KEY` value)
 * for a given guardian operator, read straight from its own `GET
 * /pubkey?scheme=ecdsa` endpoint -- duplicated from guardian-switch.spec.ts /
 * guardian-recovery.spec.ts / guardian-switch-stress.spec.ts rather than
 * shared (this suite's existing per-file style).
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
 * THE #103 perpetual-loading test.
 *
 * A guardian account created + funded on A is recovered on a fresh, clean
 * wallet profile via the fast bypass (`viaUI: false` -- same path
 * guardian-recovery.spec.ts's real-UI journey drives at its own pace). A
 * seed-only recovery can never recover the device-bound hot key, so the
 * recovered account is flagged `requiresHotKeyRotation` and `HotKeyRotationGate`
 * auto-initiates a `replace-hot-key` rotation, blocking the whole wallet
 * behind a full-screen overlay until `replace_signer` lands on-chain AND the
 * new signer set is re-registered with the guardian (see that component's own
 * doc comment, `src/app/templates/HotKeyRotationGate.tsx`).
 *
 * `armGuardianFault({ path: 'configure', mode: 'delay', delayMs: 60_000 })`
 * holds every call to guardian A's `/configure` endpoint open for 60s --
 * `completeReplaceHotKeyTransaction` (`transaction/complete.ts:236-323`) makes
 * exactly that call (`reRegisterCurrentStateOnGuardian`) to push the
 * post-rotation `[new-hot, cold]` signer set to the guardian, and it's
 * REQUIRED (without it every request signed by the new hot key 401s forever
 * -- see that function's own doc comment). So while the fault is armed, the
 * rotation is provably still in-flight: it cannot reach either `Completed` or
 * `Failed` until the delayed call resolves.
 *
 * `kill()`s the wallet PAGE while the rotation is held open this way, then
 * `reopen()`s and clears the fault. `completeHotKeyRotation()` must then
 * observe the gate reach its cleared (unmounted) state -- not spin forever,
 * and not require a fresh rotation to be kicked off from scratch (the
 * existing `replace-hot-key` row must be adopted, not duplicated -- see
 * `ensureRotationTx`'s `adoptExisting` doc comment).
 *
 * **Expected RED on `main`** (issue #103): `HotKeyRotationGate`'s rotation is
 * expected to get stuck after a page teardown mid-rotation -- the gate never
 * reaches either the cleared state or its own terminal-failure surface, so
 * `completeHotKeyRotation()` times out (Playwright reports this test as a
 * *timeout* failure, not a caught assertion). Per this branch's Product-Fix
 * Protocol, this spec is authored to EXPOSE that failure, not to fix it --
 * the fix (candidate: `HotKeyRotationGate.ensureRotationTx`'s orphaned-row
 * requeue at `HotKeyRotationGate.tsx:71-98`, and/or a startup orphan sweep in
 * `back/transaction-processor.ts`) is a separate, later step once the
 * failure is reproduced and root-caused.
 *
 * Unlike `switch-guardian` (which gets an explicit `'registering-guardian'`
 * stage stamp immediately before its guardian-register call), `replace-hot-key`
 * has no stage stamp of its own for that call -- so this test waits for the
 * closest available proxy, `'confirming'` (the last stage stamped before
 * `completeReplaceHotKeyTransaction` runs), via `waitForStage`'s new
 * `transactionType` parameter. Precise timing isn't actually load-bearing
 * here: `kill()` only tears down the Playwright PAGE, and on the extension
 * platform `HotKeyRotationGate` hands rotation processing entirely to the
 * service worker (`requestSWTransactionProcessing`, since its own `driveLoop`
 * effect is a no-op `if (isExtension())`) -- so the in-flight rotation (and
 * the guardian fault holding it open) is unaffected by exactly when the page
 * closes, only by whether it closes before the rotation reaches a terminal
 * state at all.
 */
test.describe('Guardian recovery stress - kill mid-rotation resumes', () => {
  test('kill during device-key rotation, reopen resumes gate to completion (no perpetual loading)', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    // The armed register delay alone is 60s, plus create/fund/claim and the
    // post-reopen rotation wait -- comfortable headroom over the base
    // config's 300s default, matching the sibling guardian-switch-stress
    // specs' budget for a similarly guardian-heavy flow.
    test.setTimeout(600_000);

    const commitmentA = await guardianCommitment(A);

    let addressA: string;
    let seed = '';

    await steps.step(
      'create_and_fund_on_a_capture_seed',
      async () => {
        const created = await walletA.createGuardianWallet(A);
        addressA = created.address;
        seed = created.seedPhrase.join(' ');
        expect(
          created.seedPhrase.length,
          'createGuardianWallet must return a usable 12-word mnemonic -- without it there is nothing to ' +
            'recover walletB from'
        ).toBe(12);

        await midenCli.init();
        const faucetId = await midenCli.createFaucet();
        await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
        await midenCli.sync();
        await walletA.claimAllNotes(180_000);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step('recover_via_bypass_kill_mid_rotation', async () => {
      // Arm BEFORE firing the recovery so the very first /configure call
      // (issued from inside completeReplaceHotKeyTransaction, once the
      // rotation transaction itself commits on-chain) already lands on the
      // faulted path -- there is no window where an unfaulted register could
      // sneak through first.
      walletB.armGuardianFault({ target: 'A', path: 'configure', mode: 'delay', delayMs: 60_000 });

      // Fire-and-forget: viaUI:false (the onboarding bypass) resolves once
      // the wallet reaches its home surface, well before HotKeyRotationGate's
      // own rotation completes -- swallow a rejection here so it can never
      // race the explicit waits below.
      void walletB.recoverGuardianFromSeed(seed, { viaUI: false, guardianUrl: A }).catch(() => {});

      // Proof #1: the recovered account is flagged requiresHotKeyRotation and
      // the gate has mounted.
      await walletB.page.getByTestId('hot-key-rotation-gate').waitFor({ state: 'visible', timeout: 30_000 });

      // Proof #2: the underlying replace-hot-key row has reached 'confirming'
      // -- the closest available proxy for "about to attempt guardian
      // registration" (see this spec's describe-level doc comment, and
      // waitForStage's / StageTrackedTransactionType's own doc comments, for
      // why replace-hot-key has no exact 'registering-guardian' equivalent).
      await walletB.waitForStage('confirming', 120_000, 'replace-hot-key');

      // Terminate the wallet mid-flight. Deliberately NOT wrapped in a
      // screenshotWallets capture: TestStepRunner takes the screenshot AFTER
      // this function resolves, and the page it would target is the one
      // kill() just closed.
      await walletB.kill();
    });

    await steps.step(
      'reopen_gate_resumes_and_completes',
      async () => {
        await walletB.reopen();
        walletB.clearFaults();

        // The 60s delay armed above is already in flight against the
        // ORIGINAL /configure request the service worker dispatched before
        // kill() -- clearFaults() only stops NEW requests from being
        // faulted, it can't rescind an already-scheduled delay (same caveat
        // as guardian-switch-stress.spec.ts's kill-mid-switch test).
        //
        // This is the #103 assertion: completeHotKeyRotation() must observe
        // the gate reach its cleared state (or its own terminal-failure
        // surface, which it throws on) within its own bounded wait -- never
        // spin forever. A genuine perpetual-loading regression surfaces here
        // as a Playwright *timeout* on this call, not a caught assertion.
        await walletB.completeHotKeyRotation();

        const addressB = await walletB.getAccountAddress();
        expect(
          addressB,
          'recovering the SAME seed on a clean profile must derive the SAME account id as A, kill/reopen included'
        ).toBe(addressA!);

        // Rotation replaces the HOT key but keeps the same guardian + cold
        // key + threshold -- so the auth shape (2 signers, update_guardian
        // threshold 2, guardian commitment = A's) must match A's baseline,
        // same as guardian-recovery.spec.ts's non-stress journey.
        await walletB.assertGuardianAuth(addressB, {
          signerCount: 2,
          threshold: 2,
          guardianCommitment: commitmentA
        });
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );
  });
});

/**
 * Transient register faults during a device-key rotation's re-register step
 * -- the wallet's own retry/backoff recovers, the rotation still completes.
 *
 * Mirrors `guardian-switch-stress.spec.ts`'s "register fault retries" test
 * (same `failFirstN` shape, same assertion), but targets the OTHER caller of
 * the shared retry wrapper: `replace-hot-key` (device-key rotation), not
 * `switch-guardian`. A seed-only recovery (this suite's `#103` scenario) can
 * never recover the device-bound hot key, so it always rotates -- and that
 * rotation's completion handler (`completeReplaceHotKeyTransaction`,
 * `src/lib/miden/transaction/complete.ts:236-323`) re-registers the
 * POST-rotation `[new-hot, cold]` signer set on the guardian via
 * `coldService.reRegisterCurrentStateOnGuardian()` (called at line 283,
 * inside a best-effort `try/catch` spanning lines 264-289 -- see that call
 * site's own doc comment: without this push, every request signed by the new
 * hot key 401s "session expired" forever). `reRegisterCurrentStateOnGuardian`
 * (`src/lib/miden/guardian/index.ts:564-575`) is a thin wrapper that syncs
 * the now-rotated on-chain account and hands its serialized state to
 * `registerOnGuardianWithRetry` (line 574) -- the SAME retry helper
 * `finalizeGuardianSwitch` calls for `switch-guardian` (line 521): up to
 * `MAX_GUARDIAN_REGISTER_RETRIES` (5) attempts, a fixed
 * `GUARDIAN_REGISTER_RETRY_DELAY_MS` (2000ms) apart, no exponential backoff
 * (`guardian/index.ts:51-52,528-543`).
 *
 * `armGuardianFault({ path: 'configure', mode: 'failFirstN', count: 2 })`
 * fails the recovered wallet's first 2 `/configure` calls (HTTP 500) and lets
 * every call after that through untouched, so the ONLY way
 * `completeHotKeyRotation()` resolves to the gate's cleared state is if the
 * wallet retried at least twice before giving up -- attempt 3 lands on the
 * now-unfaulted path and the retry loop returns normally, well inside its own
 * 5-attempt budget (worst case here: ~4s of backoff, nowhere near
 * `completeHotKeyRotation`'s 120s completion wait). If the wallet's retry
 * budget were smaller than 2 (or had no backoff at all), the re-register
 * would exhaust its retries and hit the surrounding `try/catch` -- which is
 * itself best-effort (a guardian blip must not fail an on-chain-successful
 * rotation, per that call site's own comment), so the ROTATION would still
 * reach `Completed` while silently leaving the new hot key unauthorized on
 * the guardian. This test cannot distinguish that silent-failure mode from a
 * genuine recovery purely from `completeHotKeyRotation()` resolving; the
 * `assertGuardianAuth` pin on the on-chain `signerCount`/`threshold`/
 * `guardianCommitment` proves the on-chain rotation shape, same as every
 * sibling spec in this suite.
 *
 * **Expectation:** GREEN on `main` -- `reRegisterCurrentStateOnGuardian`
 * shares `registerOnGuardianWithRetry` with the already-covered
 * `switch-guardian` path (nothing about `replace-hot-key` re-registration is
 * a distinct, unretried code path), and 2 induced failures are comfortably
 * inside the 5-attempt budget. Per this branch's Product-Fix Protocol, if
 * this instead goes RED, root-cause from `reRegisterCurrentStateOnGuardian` /
 * `registerOnGuardianWithRetry` (`src/lib/miden/guardian/index.ts`) and
 * `completeReplaceHotKeyTransaction`'s re-register call site
 * (`src/lib/miden/transaction/complete.ts:264-289`) before writing any fix.
 */
test.describe('Guardian recovery stress - rotation register fault retries', () => {
  test('transient register failures during device key rotation, retry recovers, rotation completes', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    // Two faulted register attempts plus their fixed backoff, on top of
    // create/fund/claim and the recovery + rotation wait -- comfortable
    // headroom over the base config's 300s default, matching the sibling
    // guardian-switch-stress / guardian-recovery-stress specs' budget.
    test.setTimeout(600_000);

    const commitmentA = await guardianCommitment(A);

    let addressA: string;
    let seed = '';

    await steps.step(
      'create_and_fund_on_a_capture_seed',
      async () => {
        const created = await walletA.createGuardianWallet(A);
        addressA = created.address;
        seed = created.seedPhrase.join(' ');
        expect(
          created.seedPhrase.length,
          'createGuardianWallet must return a usable 12-word mnemonic -- without it there is nothing to ' +
            'recover walletB from'
        ).toBe(12);

        await midenCli.init();
        const faucetId = await midenCli.createFaucet();
        await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
        await midenCli.sync();
        await walletA.claimAllNotes(180_000);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step(
      'recover_and_rotate_survives_two_register_faults',
      async () => {
        // Arm BEFORE firing the recovery so the very first /configure call
        // (issued from inside completeReplaceHotKeyTransaction's re-register
        // step, once the rotation transaction itself commits on-chain)
        // already lands on the faulted path -- there is no window where an
        // unfaulted register could sneak through first.
        walletB.armGuardianFault({ target: 'A', path: 'configure', mode: 'failFirstN', count: 2 });

        // recoverGuardianFromSeed({viaUI:false}) only drives the fast bypass
        // to the home surface -- it does NOT itself await the rotation (that
        // only happens on the viaUI:true branch), so completeHotKeyRotation()
        // is called explicitly, same split as this file's kill-mid-rotation
        // test above.
        await walletB.recoverGuardianFromSeed(seed, { viaUI: false, guardianUrl: A });

        // Must survive exactly 2 register failures via the wallet's own
        // retry/backoff; throws if the gate instead reaches its
        // terminal-failure surface within its own bounded wait.
        await walletB.completeHotKeyRotation();

        walletB.clearFaults();

        const addressB = await walletB.getAccountAddress();
        expect(
          addressB,
          'recovering the SAME seed on a clean profile must derive the SAME account id as A'
        ).toBe(addressA!);

        // Rotation replaces the HOT key but keeps the same guardian + cold
        // key + threshold -- so the auth shape (2 signers, update_guardian
        // threshold 2, guardian commitment = A's) must match A's baseline,
        // same as the non-stress recovery journey and this file's
        // kill-mid-rotation test.
        await walletB.assertGuardianAuth(addressB, {
          signerCount: 2,
          threshold: 2,
          guardianCommitment: commitmentA
        });
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );
  });
});
