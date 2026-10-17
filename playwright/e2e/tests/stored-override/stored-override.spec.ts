import { expect, test } from '../../fixtures/two-wallets';
import { assertWalletRunsOnStoredOverride } from '../../harness/extension-network';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { saveDeveloperEndpoints } from '../../helpers/developer-endpoints';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

// Minted to the wallet by the CLI in each round, in base units (= 1,000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
// The localnet node through another host name. The SDK names its IndexedDB store after the RPC URL, so this is
// MidenClientDB_mcst while the build default, http://localhost:57291, is MidenClientDB_mlcl: a realm still on the
// build's network reads a store that holds none of this wallet's data (#1482).
const OVERRIDE_RPC_URL = 'http://127.0.0.1:57291';

/**
 * A wallet whose network comes from an endpoint override stored through Developer Settings, on a build that reads
 * stored overrides (every other E2E build ignores them). The service worker creates the account, the offscreen
 * document syncs, lists the notes the note list shows and runs the claim, and the page reads the balance, so a mint
 * reaches both only when every realm is on the override's store and node. The restart repeats it from a cold start,
 * where every realm loads the stored override at boot.
 */
test.describe('Stored endpoint override', () => {
  test('a wallet on an endpoint override stored through Developer Settings shows a mint in its note list and balance, before and after a restart', async ({
    walletA,
    midenCli,
    steps,
    envConfig
  }) => {
    // Two mint-and-claim rounds and a cold relaunch do not fit the five-minute default.
    test.setTimeout(600_000);

    let address = '';
    let faucetId = '';

    await steps.step('store_override', async () => {
      await saveDeveloperEndpoints(walletA, {
        rpcUrl: OVERRIDE_RPC_URL,
        feeFaucetId: await midenCli.ensureNativeFaucetId()
      });
    });

    await steps.step('create_wallet', async () => {
      address = (await walletA.createNewWallet()).address;
    });

    await steps.step('wallet_on_override_store', async () => {
      await assertWalletRunsOnStoredOverride(walletA, envConfig);
    });

    await steps.step('mint', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, address, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'note_list_shows_mint',
      async () => {
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('balance_shows_mint', async () => {
      await walletA.claimAllNotes(120_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('restart', async () => {
      await walletA.killBrowser();
      // A relaunch on the same profile, not a page swap: the service worker and the offscreen document start cold.
      expect(await walletA.reopen()).toBe(true);
    });

    await steps.step('mint_after_restart', async () => {
      await midenCli.mint(faucetId, address, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'note_list_shows_mint_after_restart',
      async () => {
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('balance_shows_both_mints', async () => {
      await walletA.claimAllNotes(120_000);
      await waitForVaultBalance(walletA.page, TOKEN, 2n * MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });
  });
});
