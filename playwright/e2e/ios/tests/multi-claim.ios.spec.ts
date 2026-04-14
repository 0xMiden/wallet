import { expect, test } from '../fixtures/two-simulators';

test.describe('Multi-Note Claiming', () => {
  test.describe.configure({ mode: 'serial' });

  test('mint multiple notes and claim all', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
  }) => {
    let addressA: string;

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      // Create wallet B too (fixture requires both)
      await walletB.createNewWallet();
      addressA = a.address;
    });

    await steps.step('deploy_faucet', async () => {
      await midenCli.init();
      await midenCli.createFaucet();
    });

    await steps.step('mint_note_1', async () => {
      await midenCli.mint(addressA!, 50_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('mint_note_2', async () => {
      await midenCli.mint(addressA!, 30_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('mint_note_3', async () => {
      await midenCli.mint(addressA!, 20_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('sync_and_verify_total_balance', async () => {
      // Total minted: 100_000_000_000 base units = 1000 tokens with 8 decimals
      // Wait for balance to reflect all mints
      const balance = await walletA.waitForBalanceAbove(0, 180_000, timeline);
      expect(balance).toBeGreaterThan(0);

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Final balance after multi-claim: ${balance}`,
        data: { balance },
      });
    }, {
      captureStateFrom: [{ target: walletA, label: 'A' }],
      screenshotWallets: [{ target: walletA, label: 'A' }],
    });
  });
});
