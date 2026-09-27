import { expect, test } from '../fixtures/two-wallets';
import {
  findProveWindow,
  installFrameRecorder,
  measureFrameGap,
  readFrameTimes,
  readyWorkerThreads
} from '../harness/frame-gap-probe';
import { type ProveMarker, readRealmMarkers } from '../harness/prove-telemetry-probe';
import { snapshotTransfer, type TransferSnapshot } from '../helpers/assertions';
import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance, waitForVaultDebit } from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// Minted to wallet A by the CLI below, in base units (= 1,000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
// What the send step types into the amount field, and the same figure in base units.
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);
// #945: a local prove must not freeze the wallet page. A prove window shorter than
// this cannot tell a freeze from a fast prove; a gap longer than MAX is a freeze.
const MIN_PROVE_WINDOW_MS = 2000;
const MAX_FRAME_GAP_MS = 1000;

/**
 * Local-prove guard spec: the one E2E path that exercises in-browser WASM
 * proving (the offscreen-doc path) end-to-end.
 *
 * Toggling delegate proving off (storage key `delegate_proof_setting_key`)
 * is enough to flip the wallet onto the local-prove code path. The service
 * worker build defaults `MIDEN_USE_OFFSCREEN_CLIENT` to `'true'` (see
 * vite.background.config.ts), so the whole send runs as a write inside the
 * offscreen document and no extra build env is needed.
 *
 * Requires `@miden-sdk/miden-sdk` >= 0.16.0-rc.4 (miden-processor 0.29.4).
 * Earlier 0.16 SDKs trap ~2ms into a wasm local prove: `miden-processor`
 * spawned the hasher-chiplet trace builder on a thread wasm32 cannot spawn,
 * and the trapped `wasm-bindgen` future never settled, so the prove neither
 * completed nor errored and held the offscreen WASM mutex until the write
 * deadline reclaimed the realm (miden-vm#3722). 0.29.4 builds the trace
 * serially when the spawn is refused. Delegated proving and the mobile
 * native prover were never affected.
 */
test.describe('Public Note Send — local proving (offscreen-doc path)', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens publicly to wallet B with local proving forced', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Local proving (offscreen-doc WASM) runs the send proof in-browser — far
    // slower than delegated proving, so the default 5-min per-test budget isn't
    // enough for this path.
    test.setTimeout(600_000);

    let addressA: string;
    let addressB: string;
    let transferBefore: TransferSnapshot;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_wallet_a',
      async () => {
        // The mint creates a NOTE: it is discovered before it is consumed, so its
        // value is UNCONSUMED, not spendable. Assert the exact minted amount of
        // TST is pending — the old `> 0` on a vault+pending sum stayed true for a
        // wrong amount, a wrong token, or a note that never arrived at all.
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Awaiting exactly ${MINT_BASE_UNITS} base units of ${TOKEN} as unconsumed notes on A`,
          data: { symbol: TOKEN, expectedBaseUnits: MINT_BASE_UNITS.toString(), wallet: 'A' }
        });
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
      // Funding wait for the step under test, deliberately a wait and not an
      // expect: the send below can only be asserted exactly once A's SPENDABLE
      // vault has settled at the full claimed amount. Waiting on the vault (not
      // vault+pending) is also what distinguishes a real claim from a note that
      // was discovered but never consumed.
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('force_local_proving_on_wallet_a', async () => {
      // Armed HERE, after funding, so the ONLY locally-proved transaction in this
      // spec is the send under test. Only wallet A gets the override at all: the
      // failure mode being reproduced is the sender's send flow, and B's claim is
      // a separate code path.
      //
      // Arming it before `deploy_and_fund` (where it used to live) also made the
      // funding CLAIM prove locally. That was never asserted — it is prologue — so
      // the spec spent its prologue on the very path it exists to test, and died
      // there without ever reaching the send. Narrowing it was worth doing on its
      // own merits: the prologue now proves via the delegated path and only
      // the send under test runs the local prover.
      await walletA.setDelegateProofEnabled(false);
    });

    await steps.step(
      'send_public_note_a_to_b_local_prove',
      async () => {
        transferBefore = await snapshotTransfer(
          { page: walletA.page, label: 'A' },
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS
        );
        await walletA.prepareSendReview({
          recipientAddress: addressB!,
          amount: SEND_AMOUNT,
          // Devnet's native MIDEN row (0 balance) now renders above the
          // CLI faucet's row — fee-asset discovery works on the 0.15 SDK —
          // so the default first-row click would pick the wrong token.
          tokenSymbol: TOKEN,
          isPrivate: false
        });

        // #945: the wallet tab stamps every frame it paints. It shares a renderer
        // process with the offscreen document, so a prove on that document's thread
        // stops the stamps for the whole prove.
        await installFrameRecorder(walletA.page);
        await expect
          .poll(async () => (await readFrameTimes(walletA.page)).length, {
            message: 'the wallet page is not painting at all (hidden or occluded), so a frame gap would prove nothing',
            timeout: 2_000
          })
          .toBeGreaterThanOrEqual(30);
        const armedAt = await walletA.page.evaluate(() => Date.now());

        await walletA.submitSendReview();
        await walletA.waitForSendSubmissionAccepted();

        // Read as soon as the window closes: the offscreen marker ring keeps 200
        // lines and each sync adds about five, so the end of the test is too late.
        let markers: ProveMarker[] = [];
        await expect
          .poll(
            async () => {
              markers = await readRealmMarkers(walletA.page, 'offscreen');
              return findProveWindow(markers, armedAt) !== undefined;
            },
            { message: 'no local-prove window closed in the offscreen realm', timeout: 300_000, intervals: [1_000] }
          )
          .toBe(true);
        const frames = await readFrameTimes(walletA.page);
        const proveWindow = findProveWindow(markers, armedAt);
        if (!proveWindow) throw new Error('unreachable: the poll above returned only once a window had closed');
        expect(proveWindow.opens, 'exactly one local-prove window opens after arming').toBe(1);
        expect(
          proveWindow.closeTs - proveWindow.openTs,
          `the prove window is shorter than ${MIN_PROVE_WINDOW_MS} ms, too short to tell a freeze from a fast prove`
        ).toBeGreaterThanOrEqual(MIN_PROVE_WINDOW_MS);
        const gap = measureFrameGap(frames, proveWindow.openTs, proveWindow.closeTs);
        expect(
          gap.maxGapMs,
          `the page went ${gap.maxGapMs} ms without a frame during a ${gap.windowMs} ms local prove (${gap.framesInWindow} frames)`
        ).toBeLessThanOrEqual(MAX_FRAME_GAP_MS);

        const expectedThreads = await walletA.page.evaluate(() => Math.min(navigator.hardwareConcurrency, 6));
        expect(
          readyWorkerThreads(markers, armedAt),
          'the prove worker came up cross-origin isolated with the capped pool'
        ).toBe(expectedThreads);
        // Offscreen documents get chrome.runtime but never chrome.storage, so
        // prove-telemetry.ts's persist() finds no storage there and silently
        // skips the write; the settled entry never reaches miden_prove_telemetry.
        // The relayed `[prove-timing] path=` marker is the observable record.
        //
        // Take the FIRST `path=` line after THIS window's close (not any `path=local`
        // line after arming), so a non-local measured prove followed by a later local
        // one still fails here instead of matching the wrong attempt.
        let proveMarkers: ProveMarker[] = [];
        let proveLine: ProveMarker | undefined;
        await expect
          .poll(
            async () => {
              proveMarkers = await readRealmMarkers(walletA.page, 'offscreen');
              proveLine = proveMarkers.find(m => m.ts >= proveWindow.closeTs && m.line.includes('path='));
              return proveLine !== undefined;
            },
            { message: 'no measured prove recorded in the relayed offscreen marker trail', timeout: 30_000 }
          )
          .toBe(true);
        expect(proveLine?.line).toMatch(/^\[prove-timing\] path=local duration_ms=[\d.]+ platform=\w+$/);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_receipt_wallet_b',
      async () => {
        // B never claims in this spec, so the delivered note is PENDING for B, not
        // spendable. `assertTransfer` waits on the RECIPIENT'S VAULT, which would sit
        // at 0 forever here (auto-consume is restricted to the native faucet, so a
        // CLI-faucet TST note is never consumed on its own) — i.e. it would fail on a
        // perfectly healthy run. Assert the unconsumed total instead, exactly as the
        // send-public sibling does.
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Awaiting exactly ${SEND_BASE_UNITS} base units of ${TOKEN} delivered to B`,
          data: { symbol: TOKEN, expectedBaseUnits: SEND_BASE_UNITS.toString(), wallet: 'B' }
        });
        // Longer than every other delivery wait in the suite, and deliberately
        // longer than the offscreen write deadline (240s under the E2E build, see
        // `WRITE_DEADLINE_MS`). Delivery here is gated on a LOCAL WASM prove, which
        // is unbounded by design and costs minutes on the 2-vCPU runner — on 0.16
        // more than it did on 0.15. At the previous 180s this step timed out while
        // that prove was still legitimately running, which is a bare "the note never
        // arrived" with nothing to act on.
        //
        // The ordering is the point, not the number: a budget UNDER the write
        // deadline means the spec always dies first and the deadline can never
        // report, so a genuine wedge is indistinguishable from a slow prove. Above
        // it, a wedge surfaces as `aborted (deadline)` naming the stuck op.
        await waitForPendingNoteTotal(walletB.page, TOKEN, transferBefore!.toPending + SEND_BASE_UNITS, {
          timeoutMs: 300_000,
          decimals: TOKEN_DECIMALS
        });

        // The other half of a transfer: A must actually have been debited. At least
        // the sent amount, not exactly it — a fee may also leave the account.
        // Waited, not read once — see the note in send-public.spec.ts: the recipient's
        // pending total and the sender's vault projection settle independently.
        // Pinned EXACTLY, not just "at least": a Miden fee is charged in the native
        // asset, never in TST, so the transfer is the only thing that can move this
        // balance. The `>=` this used to rely on passed for a send that debited 700
        // TST for a 500 TST transfer. It says nothing about the fee itself -- see
        // fee-accounting.spec.ts for that.
        const debited = await waitForVaultDebit(walletA.page, TOKEN, transferBefore!.fromVault, SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
        expect(debited, 'the transfer debit must be exactly the amount sent').toBe(SEND_BASE_UNITS);
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ],
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );
  });
});
