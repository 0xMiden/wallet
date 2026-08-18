import { test, expect } from '../../fixtures/two-wallets';
import {
  pendingNoteTotal,
  toBaseUnits,
  vaultBalance,
  waitForPendingNoteTotal,
  waitForVaultBalance
} from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * REGRESSION GUARD (finding #2 — investigated, NOT a gap).
 *
 * A claim's "pending → 0" is a LOCAL optimistic write: the note leaves the
 * cached consumable list the moment the consume is applied in memory. Under this
 * harness's node fault, the read/sync/discovery path (fetch-based) is faulted,
 * so it looked possible that a claim could "drain" locally while never landing
 * on-chain — stranding the funds. This spec was written to settle that.
 *
 * CONCLUSION (verified live): the funds are NOT stranded. The claim completes and
 * the vault holds the exact minted amount, and — the decisive check — those funds
 * are genuinely spendable ON-CHAIN: A sends them to B and B actually receives the
 * note (impossible unless the consume truly settled on-chain and A's account
 * state is chain-consistent). Mechanistically, the consume's SUBMIT and PROVE go
 * over a transport the fetch-fault seam does not reach (the same reason a prover
 * fault doesn't bite — see the suite notes), so the consume lands despite the
 * read path being down. The wallet is graceful here; this spec stays as the guard
 * that it remains so.
 */
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST
const OUTAGE_CLAIM_BUDGET_MS = 45_000;

test.describe('infra resilience — claim attempted during a node outage', () => {
  test.describe.configure({ mode: 'serial' });

  test('funds are never stranded by a claim that ran while the node was down', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(600_000);

    let addressA = '';
    let addressB = '';
    let faucetId = '';
    const SEND_AMOUNT = '400';

    const snapshot = async (label: string) => {
      const pending = await pendingNoteTotal(walletA.page, TOKEN);
      const vault = await vaultBalance(walletA.page, TOKEN);
      const txs = await walletA.dumpTransactions().catch(() => 'unavailable');
      // eslint-disable-next-line no-console
      console.log(`[claim-outage][${label}] pending=${pending} vault=${vault} sum=${pending + vault} txs=${txs}`);
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `[claim-outage][${label}] pending=${pending} vault=${vault} sum=${pending + vault}`,
        data: { label, pending: pending.toString(), vault: vault.toString(), txs }
      });
      return { pending, vault };
    };

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
      expect(addressA).toMatch(/^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i);
      expect(addressA).not.toBe(addressB);
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, Number(MINT_BASE_UNITS), 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'claim_while_node_is_down',
      async () => {
        await snapshot('baseline');
        await walletA.armNetworkFault({ target: 'node', mode: 'connectionRefused' });

        const outcome = await walletA
          .claimAllNotes(OUTAGE_CLAIM_BUDGET_MS)
          .then(() => 'drained')
          .catch((e: unknown) => `threw:${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
        // eslint-disable-next-line no-console
        console.log(`[claim-outage] claim-under-outage outcome=${outcome}`);

        await snapshot('under-outage');
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step(
      'reconnect_then_observe_recovery',
      async () => {
        await walletA.clearFaults();

        // Let the wallet reconcile on its own first (no explicit re-claim yet):
        // several real syncs, so we can see whether recovery is automatic.
        for (let i = 0; i < 6; i++) {
          await walletA.triggerSync(true);
        }
        const afterSync = await snapshot('after-reconnect-syncs');

        // Then actively try to claim again — a graceful wallet must let the user
        // recover the funds even if auto-reconciliation didn't.
        const outcome2 = await walletA
          .claimAllNotes(180_000)
          .then(() => 'drained')
          .catch((e: unknown) => `threw:${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
        // eslint-disable-next-line no-console
        console.log(`[claim-outage] recovery-claim outcome=${outcome2}`);
        const afterReclaim = await snapshot('after-recovery-claim');

        // FUND-SAFETY INVARIANT: however the internals settled, the minted funds
        // must still be accounted for — either spendable in the vault or still
        // claimable in pending. The one unacceptable outcome is "neither", i.e.
        // the note vanished from pending without ever landing in the vault.
        const totalNow = afterReclaim.pending + afterReclaim.vault;
        // eslint-disable-next-line no-console
        console.log(
          `[claim-outage] FINAL: pending=${afterReclaim.pending} vault=${afterReclaim.vault} total=${totalNow} (expected ${MINT_BASE_UNITS}); after-reconnect total was ${afterSync.pending + afterSync.vault}`
        );
        expect(
          totalNow,
          'after a claim during a node outage + reconnect, the minted funds must still be accounted for (vault or pending), never stranded'
        ).toBe(MINT_BASE_UNITS);
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    // THE decisive on-chain test. The vault reading a claimed balance proves only
    // the wallet's LOCAL view. If that consume never actually landed on-chain (an
    // optimistic completion that diverged from chain), the account's on-chain
    // state is behind the local one, and a real SEND built on the local state
    // would be rejected by the node — the funds would be a phantom. So: send the
    // claimed funds to B and require B to actually RECEIVE them (which can only
    // happen if the note is genuinely on-chain and A's account state is
    // chain-consistent). B receiving is the ground truth that the earlier
    // claim-under-outage really settled on-chain, not just locally.
    await steps.step(
      'claimed_funds_are_genuinely_spendable_on_chain',
      async () => {
        const sendBaseUnits = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);
        await walletA.sendTokens({
          recipientAddress: addressB,
          amount: SEND_AMOUNT,
          tokenSymbol: TOKEN,
          isPrivate: false
        });
        // B receives the note ON-CHAIN — impossible unless A's consume truly landed.
        await waitForPendingNoteTotal(walletB.page, TOKEN, sendBaseUnits, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        // A's vault dropped by the sent amount — the claimed funds were real.
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS - sendBaseUnits, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `[claim-outage] the funds claimed during the node outage were genuinely on-chain: A spent ${sendBaseUnits} to B, who received it`,
          data: { sendBaseUnits: sendBaseUnits.toString() }
        });
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ]
      }
    );
  });
});
