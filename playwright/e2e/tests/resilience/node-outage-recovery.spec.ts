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
 * North-star resilience invariant: a node outage in the middle of the money path
 * must never (a) hang the wallet on a dead request, (b) show funds it can't
 * actually see, or (c) leave funds unrecoverable — and once connectivity returns
 * the wallet must catch up on its own. (Design spec §"Fund-safety invariant".)
 *
 * FALSIFIABILITY — why this uses note DISCOVERY, not a claim. A claim's
 * "pending → 0" signal is a LOCAL optimistic write (the note leaves the pending
 * list the moment the consume is applied in-memory, before the node accepts the
 * submit), so a claim can appear to "drain" even under a total node outage —
 * verified live: node RPCs log `INJECTED:connectionRefused` yet the pending list
 * still empties. Note DISCOVERY has no such local shortcut: learning that a note
 * newly minted on-chain exists REQUIRES a successful node round-trip. So the
 * load-bearing contrast here is: a note minted while the wallet is offline is
 * NOT discoverable under the outage, and IS discovered (and claimable) once the
 * node returns. The "not discovered under outage" assertion fails if the fault
 * never bit, which is the falsifiability the claim-based probe lacked.
 *
 * The node runs gRPC-web from the SW / SDK worker, faulted at the fetch layer via
 * `armNetworkFault` (seam proven in `_seam.smoke.spec.ts`). This seam reaches
 * node + transport traffic; the delegated PROVER uses a transport it does not
 * reach, so prover-fault specs are out of scope for the fetch seam.
 */
const MINT_1_BASE_UNITS = 100_000_000_000n; // 1000 TST — funded and claimed before the outage
const MINT_2_BASE_UNITS = 50_000_000_000n; //   500 TST — minted on-chain WHILE the wallet is offline

test.describe('infra resilience — node outage during the money path', () => {
  test.describe.configure({ mode: 'serial' });

  test('a node outage hides no funds and the wallet catches up after reconnecting', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);

    let addressA = '';
    let faucetId = '';

    await steps.step('create_wallet', async () => {
      // OFFCHAIN account: this spec faults the NODE, not the guardian, so guardian
      // co-sign proofs would only add orthogonal proving load and flakiness.
      const a = await walletA.createNewWallet();
      addressA = a.address;
      expect(addressA, 'the created wallet must report an account address').toMatch(
        /^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i
      );
    });

    await steps.step('deploy_fund_and_claim_first_note', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, Number(MINT_1_BASE_UNITS), 'public');
      await midenCli.sync();

      // Establish a healthy, settled baseline BEFORE any fault: note #1 discovered
      // and claimed into the vault.
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
      'under_outage_a_new_on_chain_note_is_not_discoverable_and_no_hang',
      async () => {
        // The node is gone for the wallet: every node RPC fails at the transport
        // layer. (The CLI is a separate process, unaffected — it can still mint.)
        await walletA.armNetworkFault({ target: 'node', mode: 'connectionRefused' });

        // (a) No hang: a balance read drives an RPC that now fails; it must SETTLE
        // within a bounded window rather than hang on the dead request.
        await expectSettlesWithin(() => walletA.getBalance(TOKEN), 30_000, 'balance read under node outage');

        // Mint note #2 ON-CHAIN while the wallet is offline.
        await midenCli.mint(faucetId, addressA, Number(MINT_2_BASE_UNITS), 'public');
        await midenCli.sync();

        // (b) The fault genuinely bit: the wallet cannot LEARN of note #2 while the
        // node is unreachable — discovery has no local shortcut. Drive several
        // forced syncs (each attempts a node round-trip that is injected-failed)
        // and prove nothing new appears. This would fail if the fault no-op'd.
        for (let i = 0; i < 4; i++) {
          await walletA.triggerSync(true);
        }
        const pendingUnderOutage = await pendingNoteTotal(walletA.page, TOKEN);
        const vaultUnderOutage = await vaultBalance(walletA.page, TOKEN);
        expect(
          pendingUnderOutage,
          'a note minted while the node is unreachable must NOT be discoverable — if it is, the node fault never bit'
        ).toBe(0n);
        // And the funds already in hand are untouched — no phantom change.
        expect(vaultUnderOutage, 'the settled vault must be unchanged by a node outage').toBe(MINT_1_BASE_UNITS);
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step(
      'after_reconnect_the_wallet_catches_up_and_conserves_all_funds',
      async () => {
        // Connectivity restored.
        await walletA.clearFaults();

        // (c) Catch-up: note #2 is now discovered, claimable, and the vault settles
        // to the EXACT sum of both notes — nothing was lost while offline.
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_2_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await walletA.claimAllNotes(180_000);
        await waitForVaultBalance(walletA.page, TOKEN, MINT_1_BASE_UNITS + MINT_2_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await waitForPendingNoteTotal(walletA.page, TOKEN, 0n, { timeoutMs: 120_000, decimals: TOKEN_DECIMALS });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `[resilience] wallet was blind to an on-chain note during a node outage, then caught up to a vault of exactly ${MINT_1_BASE_UNITS + MINT_2_BASE_UNITS} base units after reconnecting`,
          data: {
            mint1BaseUnits: MINT_1_BASE_UNITS.toString(),
            mint2BaseUnits: MINT_2_BASE_UNITS.toString()
          }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
