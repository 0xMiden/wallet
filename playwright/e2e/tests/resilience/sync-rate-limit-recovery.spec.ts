import { test, expect } from '../../fixtures/two-wallets';
import { expectSettlesWithin } from '../../harness/resilience-assertions';
import { pendingNoteTotal, waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * #777 — an idle mobile wallet froze permanently right after a burst of HTTP
 * 429s from the node RPC. The burst shape in the CI evidence (three 429s in a
 * 20ms window) is exactly ONE sync tick: a single `syncState` fires
 * SyncChainMmr + SyncNotes + SyncTransactions back-to-back, so a rate limiter
 * that trips rejects all three together. This spec drives that trigger at the
 * real WASM client and pins the resilience envelope of the sync path:
 *
 *  - 429 leg: sustained 429s (with `retry-after`) on the sync RPCs must make
 *    every sync SETTLE as a bounded failure — never hang — must verifiably
 *    blind the wallet to new on-chain notes (falsifiability: if discovery
 *    still works, the fault never bit), and once the limiter relents the
 *    wallet must catch up on its own.
 *  - hang leg: a sync RPC that ACCEPTS the request and never answers (the
 *    stalled-transport shape behind #718/#777 — on wasm32 the SDK's transport
 *    carries no deadline at all) must still leave every driven operation
 *    bounded and the wallet responsive.
 *
 * Realm note: this suite runs the extension SW sync path (30s sync timeout +
 * circuit breaker). The mobile/desktop INLINE path — where #777 was recorded,
 * and where the fix adds the 120s sync watchdog ceiling with client
 * replacement — is covered by the useSyncTrigger/watchdog unit suites and the
 * on-simulator repro in the PR. After a hung sync, the SDK's internal sync
 * lock stays held by the never-settling call and later syncs coalesce onto it
 * (the SW path has no client-replacement recovery — a pre-existing gap noted
 * in #777), so the hang leg deliberately asserts BOUNDEDNESS, not sync
 * recovery.
 *
 * `path: 'rpc.Api/Sync'` narrows the fault to the three sync RPCs (the 0.16
 * SDK's SyncChainMmr / SyncNotes / SyncTransactions), leaving reads like
 * GetAccount untouched — a rate limiter throttling the chatty sync traffic is
 * the realistic shape, and it keeps the claim step's non-sync RPCs healthy.
 */
const SYNC_RPC_PATH = 'rpc.Api/Sync';
const MINT_1_BASE_UNITS = 100_000_000_000n; // 1000 TST — funded and claimed before the fault
const MINT_2_BASE_UNITS = 50_000_000_000n; //   500 TST — minted on-chain WHILE rate-limited

test.describe('infra resilience — node rate-limiting on the sync path (#777)', () => {
  test.describe.configure({ mode: 'serial' });

  test('sustained sync-RPC 429s bound every sync, blind discovery while armed, and the wallet catches up after', async ({
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
      'under_429s_every_sync_settles_and_discovery_is_verifiably_blind',
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

        // Every forced sync under 429s must SETTLE within a bounded window —
        // the #777 defect shape is a sync that never comes back. Re-arm before
        // each probe: MV3 can restart the SW mid-test, and a restarted SW loses
        // the armed fault config (same race as node-outage-recovery.spec.ts).
        for (let i = 0; i < 4; i++) {
          await walletA.armNetworkFault({
            target: 'node',
            path: SYNC_RPC_PATH,
            mode: 'status429RetryAfter',
            retryAfterSec: 1
          });
          await expectSettlesWithin(() => walletA.triggerSync(true), 60_000, `forced sync #${i + 1} under 429s`);
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
        message:
          '[resilience] sync path survived sustained 429s: bounded failures while limited, full catch-up after',
        data: {
          mint1BaseUnits: MINT_1_BASE_UNITS.toString(),
          mint2BaseUnits: MINT_2_BASE_UNITS.toString()
        }
      });
    });
  });

  test('a sync RPC that never answers leaves the wallet bounded and responsive', async ({ walletA, steps }) => {
    test.setTimeout(300_000);

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      expect(a.address, 'the created wallet must report an account address').toBeTruthy();
    });

    await steps.step(
      'under_a_hung_sync_rpc_everything_stays_bounded',
      async () => {
        await walletA.armNetworkFault({ target: 'node', path: SYNC_RPC_PATH, mode: 'hang' });

        // The SW bounds its sync wait (SYNC_TIMEOUT_MS) — a hung sync RPC must
        // surface as a bounded failure, not an unbounded park. Two probes: the
        // second proves the first's abandoned call didn't wedge the driver.
        await expectSettlesWithin(() => walletA.triggerSync(true), 90_000, 'forced sync #1 under a hung sync RPC');
        await expectSettlesWithin(() => walletA.triggerSync(true), 90_000, 'forced sync #2 under a hung sync RPC');

        // The wallet as a whole must stay responsive — a balance read takes the
        // non-sync RPC path and must settle.
        await expectSettlesWithin(() => walletA.getBalance(TOKEN), 30_000, 'balance read beside a hung sync');
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('faults_cleared', async () => {
      // Boundedness after clearing: the abandoned hung call still holds the
      // SDK's internal sync lock (see the header comment — pre-existing SW-path
      // gap), so full sync recovery is NOT asserted here; the driven operations
      // must simply remain bounded.
      await walletA.clearFaults();
      await expectSettlesWithin(() => walletA.triggerSync(true), 90_000, 'forced sync after clearing the hang');
      await expectSettlesWithin(() => walletA.getBalance(TOKEN), 30_000, 'balance read after clearing the hang');
    });
  });
});
