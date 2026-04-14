import { expect, test } from '../fixtures/two-simulators';

test.describe('Faucet Minting and Balance', () => {
  test.describe.configure({ mode: 'serial' });

  test('deploy faucet and mint tokens to both wallets', async ({
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

    await steps.step('init_miden_client', async () => {
      await midenCli.init();
    });

    await steps.step('deploy_faucet', async () => {
      const faucetId = await midenCli.createFaucet();
      expect(faucetId).toBeTruthy();
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Faucet deployed: ${faucetId}`,
        data: { faucetId },
      });
    });

    await steps.step('mint_tokens_to_wallet_a', async () => {
      const { txId, noteId } = await midenCli.mint(addressA!, 100_000_000_000, 'public');
      expect(txId).toBeTruthy();
      expect(noteId).toBeTruthy();
      await midenCli.sync();
    });

    // iOS divergence: Chrome getBalance counts pending notes via
    // chrome.storage.local; mobile has no equivalent, so claim explicitly
    // before checking balance. See CLAUDE.md "E2E iOS Simulator Test
    // Harness" → "Empirical Status".
    await steps.step('claim_wallet_a', async () => {
      await walletA.claimAllNotes(180_000);
    });

    await steps.step('verify_balance_wallet_a', async () => {
      const balance = await walletA.waitForBalanceAbove(0, 120_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [{ target: walletA, label: 'A' }],
    });

    await steps.step('mint_tokens_to_wallet_b', async () => {
      const { txId, noteId } = await midenCli.mint(addressB!, 100_000_000_000, 'public');
      expect(txId).toBeTruthy();
      expect(noteId).toBeTruthy();
      await midenCli.sync();
    });

    await steps.step('claim_wallet_b', async () => {
      await walletB.claimAllNotes(180_000);
    });

    await steps.step('verify_balance_wallet_b', async () => {
      const balance = await walletB.waitForBalanceAbove(0, 120_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [{ target: walletB, label: 'B' }],
    });
  });
});
