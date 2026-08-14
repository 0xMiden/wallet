import { test, expect } from '../../fixtures/two-wallets';
import { expectSettlesWithin } from '../../harness/resilience-assertions';
import {
  pendingNoteTotal,
  vaultBalance,
  waitForPendingNoteTotal,
  waitForVaultBalance
} from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * North-star resilience invariant: a SUSTAINED node outage in the middle of the
 * money path must never
 *   (a) lose funds,
 *   (b) falsely report the funds as moved, or
 *   (c) wedge the wallet so it can't recover —
 * and once connectivity returns the wallet must settle to the correct balance
 * on its own.
 *
 * This is the fund-safety assertion the whole suite is built to protect (design
 * spec §"Fund-safety invariant"). The outage here is a total `status500` (the
 * node answers every RPC with a 500): the wallet must handle that gracefully —
 * bounded reads, no phantom fund-move, clean recovery. (A blackholing `hang`
 * outage, which is what actually stresses the one-shot-read timeouts from gap 9,
 * is the subject of a dedicated spec — this one deliberately uses the fast-fail
 * 500 so its recovery assertion is about connectivity returning, not timeouts.)
 *
 * The node is faulted at the fetch layer (its gRPC-web runs in the SW / SDK
 * worker — `context.route` can't reach it), armed via `armNetworkFault`. See
 * `_seam.smoke.spec.ts` for the proof that this arming actually reaches node
 * traffic.
 */
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST

test.describe('infra resilience — node outage during the money path', () => {
  test.describe.configure({ mode: 'serial' });

  test('a sustained node outage never loses funds and the wallet fully recovers', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    // Guardian onboarding + fund + claim, plus a deliberate outage window.
    test.setTimeout(600_000);

    let addressA = '';
    let faucetId = '';

    await steps.step('create_wallet', async () => {
      // An OFFCHAIN account is the right axis here: this spec faults the NODE, not
      // the guardian, so the guardian co-sign proofs would only add orthogonal
      // proving load and flakiness. The claim → node-outage → recovery invariant
      // is identical on either account type.
      const a = await walletA.createNewWallet();
      addressA = a.address;
      expect(addressA, 'the created wallet must report an account address').toMatch(
        /^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i
      );
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, Number(MINT_BASE_UNITS), 'public');
      await midenCli.sync();
    });

    await steps.step(
      'funds_discovered_before_outage',
      async () => {
        // The note must have arrived and be sitting UNCONSUMED before we cut the
        // node — otherwise the recovery step below can't distinguish "the outage
        // was survived" from "the note simply hadn't landed yet".
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step(
      'node_outage_is_survived_without_hang_or_phantom_move',
      async () => {
        // Total node outage: every node RPC answers 500.
        await walletA.armNetworkFault({ target: 'node', mode: 'status500' });

        // (a) Bounded, no wedge: a balance read drives fetchBalances (an RPC) that
        // now 500s; it must SETTLE within a bounded window (surface the failure and
        // move on) rather than leave the caller stuck on a dead request.
        await expectSettlesWithin(() => walletA.getBalance(TOKEN), 30_000, 'balance read under node outage');

        // The wallet keeps trying to sync while the node is down; it must survive
        // that (no crash / wedged SW), so a forced sync round still returns.
        await expectSettlesWithin(() => walletA.triggerSync(true), 30_000, 'forced sync under node outage');

        // (b) No phantom move: while the node is unreachable the wallet must NOT
        // pretend the pending note was consumed. The funds stay exactly where
        // they were — discovered-but-unclaimed — never silently credited to the
        // vault or dropped from pending.
        const pendingDuringOutage = await pendingNoteTotal(walletA.page, TOKEN);
        const vaultDuringOutage = await vaultBalance(walletA.page, TOKEN);
        expect(pendingDuringOutage, 'pending note total must be unchanged by a node outage').toBe(MINT_BASE_UNITS);
        expect(vaultDuringOutage, 'no funds may appear in the vault while the node is unreachable').toBe(0n);
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step(
      'wallet_fully_recovers_after_connectivity_returns',
      async () => {
        // Connectivity restored.
        await walletA.clearFaults();

        // (c) Full recovery: the same claim that would have run without any fault
        // now succeeds, and the vault settles to the EXACT minted amount with
        // nothing left stranded in pending. Funds are intact and spendable.
        await walletA.claimAllNotes(180_000);
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await waitForPendingNoteTotal(walletA.page, TOKEN, 0n, { timeoutMs: 120_000, decimals: TOKEN_DECIMALS });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `[resilience] wallet survived a sustained node outage and recovered a vault of exactly ${MINT_BASE_UNITS} base units`,
          data: { mintBaseUnits: MINT_BASE_UNITS.toString() }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
