import { expect, test } from '../fixtures/two-wallets';

/**
 * Local-prove repro spec.
 *
 * Reproduces the "stuck on syncing account" hang reported when delegate
 * proving is OFF on Chrome MV3:
 *
 *   [prove-timing] [generateTransaction:send:UUID] entered
 *   [prove-timing] [generateTransaction:send:UUID] about to acquire withWasmClientLock for syncState
 *   <~22s later>
 *   [SyncManager] syncState failed (1/3): Error: Sync timeout
 *
 * Delegated proving works fine — so the contention is specific to the
 * offscreen-doc / speculation paths added in PR #230.
 *
 * Toggling delegate proving off (storage key `delegate_proof_setting_key`)
 * is enough to flip the wallet onto the local-prove code path. Build flags
 * `MIDEN_USE_OFFSCREEN_PROVING` and `MIDEN_USE_SPECULATIVE_PROVING` default
 * to `'true'` on the Chrome extension build (see vite.background.config.ts
 * and vite.extension.config.ts) so no extra build env is needed.
 */
test.describe('Public Note Send — local proving (offscreen-doc path)', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens publicly to wallet B with local proving forced', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
  }) => {
    let addressA: string;
    let addressB: string;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('force_local_proving_on_wallet_a', async () => {
      // Only the sending side needs the override; the receiver claims
      // (a separate code path), and the failure mode being reproduced is
      // on the sender's send flow.
      await walletA.setDelegateProofEnabled(false);
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      await midenCli.createFaucet();
      await midenCli.mint(addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('sync_wallet_a', async () => {
      const balance = await walletA.waitForBalanceAbove(0, 120_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
    });

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
    });

    await steps.step('send_public_note_a_to_b_local_prove', async () => {
      await walletA.sendTokens({
        recipientAddress: addressB!,
        amount: '500',
        isPrivate: false,
      });
    }, {
      screenshotWallets: [{ target: walletA.page, label: 'A' }],
    });

    await steps.step('verify_receipt_wallet_b', async () => {
      const balance = await walletB.waitForBalanceAbove(0, 180_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [
        { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
        { target: walletB.page, label: 'B', extensionId: walletB.extensionId },
      ],
      screenshotWallets: [
        { target: walletA.page, label: 'A' },
        { target: walletB.page, label: 'B' },
      ],
    });
  });
});
