import { expect, test } from '../fixtures/two-wallets';
import { waitForPendingNoteTotal } from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// Minted to EACH wallet, in base units.
const MINT_BASE_UNITS = 100_000_000_000n;

test.describe('Faucet Minting and Balance', () => {
  test.describe.configure({ mode: 'serial' });

  test('deploy faucet and mint tokens to both wallets', async ({ walletA, walletB, midenCli, steps, timeline }) => {
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

    let faucetId: string;

    await steps.step('deploy_faucet', async () => {
      faucetId = await midenCli.createFaucet();
      expect(faucetId).toBeTruthy();
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Faucet deployed: ${faucetId}`,
        data: { faucetId }
      });
    });

    await steps.step('mint_tokens_to_wallet_a', async () => {
      const { txId, noteId } = await midenCli.mint(faucetId, addressA!, 100_000_000_000, 'public');
      expect(txId).toBeTruthy();
      expect(noteId).toBeTruthy();
      await midenCli.sync();
    });

    await steps.step(
      'verify_balance_wallet_a',
      async () => {
        // The mint creates a NOTE; it is discovered before it is consumed, so its
        // value is UNCONSUMED, not spendable. Assert the exact minted amount is
        // pending — `> 0` on a vault+pending sum stayed true for a wrong amount,
        // a wrong token, or a note that never arrived at all.
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step('mint_tokens_to_wallet_b', async () => {
      const { txId, noteId } = await midenCli.mint(faucetId, addressB!, 100_000_000_000, 'public');
      expect(txId).toBeTruthy();
      expect(noteId).toBeTruthy();
      await midenCli.sync();
    });

    await steps.step(
      'verify_balance_wallet_b',
      async () => {
        // Same exact assertion for B — this is also what proves the mint went to the
        // RIGHT wallet, which a per-wallet `> 0` could not distinguish.
        await waitForPendingNoteTotal(walletB.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }]
      }
    );
  });
});
