import { expect, test } from '../fixtures/two-wallets';

/**
 * Covers the v0-UI two-level Pending-tab claim flow's per-faucet GROUP-claim
 * path: PendingTab summary → open an asset row → asset detail view → the
 * "Claim N/M" group button (handleClaimGroup) / per-note Claim buttons. Every
 * other claim spec (mint-and-balance, send-*, multi-claim) drains via the
 * top-level "Claim All" (claimAllNotes), so this two-level DOM drill-down is
 * otherwise unexercised. Chrome-only by design; mobile page objects cover their
 * React Claim All button path separately.
 */
test.describe('Pending tab — per-faucet group claim', () => {
  test.describe.configure({ mode: 'serial' });

  test('claims minted notes via the asset-group detail view', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    test.setTimeout(420_000);
    let addressA: string;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      // The two-wallets fixture provisions both; B is unused here.
      await walletB.createNewWallet();
      addressA = a.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      // Two notes from ONE faucet → a single asset group holding multiple notes,
      // so the group-claim button drains more than one note in a single action.
      await midenCli.mint(faucetId, addressA!, 50_000_000_000, 'public');
      await midenCli.mint(faucetId, addressA!, 30_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_wallet_a',
      async () => {
        const balance = await walletA.waitForBalanceAbove(0, 180_000, timeline);
        expect(balance).toBeGreaterThan(0);
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step(
      'claim_via_asset_group',
      async () => {
        // Drives PendingTab → asset-row → detail → claim-group-button / claim-button.
        await walletA.claimNotesByGroup(240_000);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('verify_notes_consumed', async () => {
      // The group-claim path must consume every pending note (not just surface
      // them) — the pending list drains to empty as the consumes commit.
      await expect
        .poll(async () => (await walletA.quickBalanceSnapshot()).pendingNotes.length, { timeout: 90_000 })
        .toBe(0);
      const snap = await walletA.quickBalanceSnapshot();
      expect(snap.balance, 'consumed balance should reflect the claimed notes').toBeGreaterThan(0);
    });
  });
});
