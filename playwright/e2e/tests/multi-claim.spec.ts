import { test } from '../fixtures/two-wallets';
import { fromBaseUnits, pendingNoteTotal, vaultBalance, waitForPendingNoteTotal } from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// The three mints below, in base units. Assert the SUM: a per-note `> 0` check
// passes as soon as ONE of them lands, which is exactly the multi-note bug this
// spec exists to catch.
const MINT_1_BASE_UNITS = 50_000_000_000n;
const MINT_2_BASE_UNITS = 30_000_000_000n;
const MINT_3_BASE_UNITS = 20_000_000_000n;
const TOTAL_MINTED_BASE_UNITS = MINT_1_BASE_UNITS + MINT_2_BASE_UNITS + MINT_3_BASE_UNITS; // 100_000_000_000n

test.describe('Multi-Note Claiming', () => {
  test.describe.configure({ mode: 'serial' });

  test('mint multiple notes and claim all', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    let addressA: string;

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      // Create wallet B too (fixture requires both)
      await walletB.createNewWallet();
      addressA = a.address;
    });

    let faucetId: string;

    await steps.step('deploy_faucet', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
    });

    await steps.step('mint_note_1', async () => {
      await midenCli.mint(faucetId, addressA!, 50_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('mint_note_2', async () => {
      await midenCli.mint(faucetId, addressA!, 30_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('mint_note_3', async () => {
      await midenCli.mint(faucetId, addressA!, 20_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_and_verify_total_balance',
      async () => {
        // Each mint creates a NOTE, and this spec never claims — so the three
        // amounts are UNCONSUMED, not spendable. Assert the exact sum
        // (100_000_000_000 base units = 1000 TST at 8 decimals): the old
        // `waitForBalanceAbove(0)` on a vault+pending sum stayed green if only one
        // of the three notes was discovered, if the amounts were wrong, or if the
        // tokens came from a different faucet.
        await waitForPendingNoteTotal(walletA.page, TOKEN, TOTAL_MINTED_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        const pending = await pendingNoteTotal(walletA.page, TOKEN);
        const vault = await vaultBalance(walletA.page, TOKEN);

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Final ${TOKEN} totals after 3 mints: unconsumed ${fromBaseUnits(pending, TOKEN_DECIMALS)}, ` +
            `vault ${fromBaseUnits(vault, TOKEN_DECIMALS)}`,
          data: { pendingBaseUnits: pending.toString(), vaultBaseUnits: vault.toString() }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
