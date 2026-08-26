import { test, expect } from '../../fixtures/two-wallets';
import { expectSettlesWithin } from '../../harness/resilience-assertions';
import { pendingNoteTotal, waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * #777 — an idle mobile wallet froze permanently right after a burst of HTTP
 * 429s from the node RPC. The burst shape in the CI evidence (three 429s in a
 * 20ms window) is exactly ONE sync tick: a single `syncState` fires several
 * sync RPCs back-to-back, so a rate limiter that trips rejects them together.
 *
 * READ THIS BEFORE TRUSTING THIS FILE AS #777 PROTECTION — IT IS NOT.
 *
 * Wrong realm. This suite drives the extension SERVICE WORKER sync path, which
 * this fix does not change: the SW already bounded its own sync with
 * `SYNC_TIMEOUT_MS`, and `sync-manager.ts` only had two constants and a pure
 * function moved out of it. The realm #777 was recorded in — the mobile/desktop
 * INLINE loop, where the fix adds the 120s per-hold watchdog ceiling and the
 * exponential breaker — has no Playwright harness. That behaviour is pinned by
 * the `useSyncTrigger`, `sync-lock` and `miden-client.watchdog` unit suites
 * (which DO fail against the unfixed code) plus the on-simulator repro in the
 * PR. Both specs here pass with the fix reverted.
 *
 * No anti-hang assertion is possible here either, so none is claimed. The SW
 * answers `SYNC_REQUEST` without awaiting `doSync` (`back/main.ts`) and
 * broadcasts `SyncCompleted` on every path INCLUDING failure, so nothing a page
 * can observe distinguishes a hung sync from a healthy one. An earlier draft
 * wrapped `triggerSync` in `expectSettlesWithin`; that measured the helper's own
 * internal 3.5s wait and could never fail. `triggerSync` is used as a DRIVER
 * below, never as the subject of a boundedness assertion. The one genuine
 * settle assertion left is on `getBalance`, whose promise really is the
 * in-page operation's.
 *
 * The breaker is not covered either: every probe here uses `triggerSync(true)`,
 * and `doSync` skips the backoff window entirely when forced.
 *
 * What it DOES pin, as a characterisation test of the SW sync path under node
 * faults — worth keeping, just not worth mistaking for the above:
 *  - Sustained 429s on the sync RPCs verifiably blind the wallet to new
 *    on-chain notes, and once the limiter relents it catches up on its own.
 *  - A sync RPC that accepts and never answers likewise blinds discovery, and
 *    a balance read beside it still settles.
 *  Both legs carry the same falsifiability check: each first proves discovery
 *  WORKS on that wallet (mint #1 is discovered, then claimed back to zero), and
 *  only then asserts that mint #2, minted under the armed fault, stays
 *  undiscoverable. The positive control is what makes that second reading a
 *  transition rather than the initial value — without it, a fault that never
 *  reached the sync RPCs would pass silently.
 *
 * `path: 'rpc.Api/Sync'` is a case-sensitive URL SUBSTRING, so it arms every
 * `rpc.Api/Sync*` method the SDK calls — SyncChainMmr, SyncNotes,
 * SyncTransactions, SyncNullifiers, SyncAccountVault and
 * SyncAccountStorageMaps. Reads like GetAccount stay healthy, which is what
 * keeps the claim step working; a rate limiter throttling the chatty sync
 * traffic is the realistic shape.
 */
const SYNC_RPC_PATH = 'rpc.Api/Sync';
const MINT_1_BASE_UNITS = 100_000_000_000n; // 1000 TST — funded and claimed before the fault
const MINT_2_BASE_UNITS = 50_000_000_000n; //   500 TST — minted on-chain WHILE rate-limited

test.describe('infra resilience — the SW sync path under node faults (characterisation, see #777)', () => {
  test.describe.configure({ mode: 'serial' });

  test('sustained sync-RPC 429s blind discovery while armed, and the wallet catches up after', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);

    let addressA = '';
    let faucetId = '';

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      addressA = a.address;
      expect(addressA, 'the created wallet must report an account address').toMatch(
        /^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i
      );
    });

    await steps.step('fund_and_settle_baseline', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, Number(MINT_1_BASE_UNITS), 'public');
      await midenCli.sync();

      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_1_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await walletA.claimAllNotes(180_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_1_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'under_429s_discovery_is_verifiably_blind',
      async () => {
        await walletA.armNetworkFault({
          target: 'node',
          path: SYNC_RPC_PATH,
          mode: 'status429RetryAfter',
          retryAfterSec: 1
        });

        // Mint note #2 on-chain while the wallet's sync RPCs are rate-limited.
        await midenCli.mint(faucetId, addressA, Number(MINT_2_BASE_UNITS), 'public');
        await midenCli.sync();

        // Drive several sync attempts into the armed fault. These are DRIVERS,
        // not assertions — see the header: `triggerSync` cannot observe whether
        // the sync it asked for ever finished. Re-arm before each: MV3 can
        // restart the SW mid-test, and a restarted SW loses the armed fault
        // config (same race as node-outage-recovery.spec.ts).
        for (let i = 0; i < 4; i++) {
          await walletA.armNetworkFault({
            target: 'node',
            path: SYNC_RPC_PATH,
            mode: 'status429RetryAfter',
            retryAfterSec: 1
          });
          await walletA.triggerSync(true);
        }

        // Falsifiability: discovery REQUIRES a successful sync round-trip, so a
        // note minted under the armed fault must be invisible. If it shows up,
        // the 429s never reached the sync RPCs and the settle assertions above
        // proved nothing.
        const pendingUnderLimit = await pendingNoteTotal(walletA.page, TOKEN);
        expect(
          pendingUnderLimit,
          'a note minted while the sync RPCs are 429-limited must NOT be discoverable — if it is, the fault never bit'
        ).toBe(0n);
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('after_the_limiter_relents_the_wallet_catches_up', async () => {
      await walletA.clearFaults();

      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_2_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await walletA.claimAllNotes(180_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_1_BASE_UNITS + MINT_2_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: '[resilience] sync path survived sustained 429s: blind while limited, full catch-up after',
        data: {
          mint1BaseUnits: MINT_1_BASE_UNITS.toString(),
          mint2BaseUnits: MINT_2_BASE_UNITS.toString()
        }
      });
    });
  });

  test('a sync RPC that never answers blinds discovery, and a balance read beside it still settles', async ({
    walletA,
    midenCli,
    steps
  }) => {
    test.setTimeout(600_000);

    let addressA = '';
    let faucetId = '';

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      addressA = a.address;
      expect(addressA, 'the created wallet must report an account address').toBeTruthy();
    });

    // The POSITIVE CONTROL for the blindness assertion below. Without it that
    // assertion reads `0n` off a wallet that has never discovered anything, so
    // it is the initial value and an unarmed fault, an unpropagated mint or a
    // broken `pendingNoteTotal` would all pass it. Proving discovery works here
    // first — and then claiming back down to zero — is what makes the later `0n`
    // a transition rather than a default. Same shape as the 429 leg's baseline.
    await steps.step('fund_and_settle_baseline', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, Number(MINT_1_BASE_UNITS), 'public');
      await midenCli.sync();

      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_1_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await walletA.claimAllNotes(180_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_1_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'under_a_hung_sync_rpc_discovery_is_verifiably_blind',
      async () => {
        await walletA.armNetworkFault({ target: 'node', path: SYNC_RPC_PATH, mode: 'hang' });

        // Mint note #2 on-chain while the sync RPCs accept and never answer.
        await midenCli.mint(faucetId, addressA, Number(MINT_2_BASE_UNITS), 'public');
        await midenCli.sync();

        // Drivers, not assertions (see the header). Two of them: the second
        // proves the first's abandoned call did not wedge the SW's driver.
        await walletA.armNetworkFault({ target: 'node', path: SYNC_RPC_PATH, mode: 'hang' });
        await walletA.triggerSync(true);
        await walletA.triggerSync(true);

        // Falsifiability — the check the hang leg previously had none of, and
        // the reason it could pass with the fault never reaching a single sync
        // RPC. Discovery REQUIRES a completed sync round-trip, so note #2 must
        // be invisible even though note #1 was discovered on this same wallet
        // minutes earlier.
        const pendingUnderHang = await pendingNoteTotal(walletA.page, TOKEN);
        expect(
          pendingUnderHang,
          'a note minted while the sync RPCs hang must NOT be discoverable — if it is, the fault never bit'
        ).toBe(0n);

        // The wallet as a whole must stay responsive. This one IS a real settle
        // assertion: `getBalance` resolves the in-page read's own promise, so a
        // read parked behind the sync would genuinely blow the budget.
        await expectSettlesWithin(() => walletA.getBalance(TOKEN), 30_000, 'balance read beside a hung sync');
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('after_clearing_the_hang_reads_still_settle', async () => {
      // Sync RECOVERY is deliberately not asserted: the abandoned hung call
      // still holds the SDK's module-level sync lock, and later syncs coalesce
      // onto it, so the SW path cannot catch up here. That is a real
      // pre-existing gap — it needs the upstream transport deadline, and the
      // inline path's client replacement is what works around it on mobile.
      await walletA.clearFaults();
      await walletA.triggerSync(true);
      await expectSettlesWithin(() => walletA.getBalance(TOKEN), 30_000, 'balance read after clearing the hang');
    });
  });
});
