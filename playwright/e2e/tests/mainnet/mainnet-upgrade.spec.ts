import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test } from '../../fixtures/two-wallets';
import type { GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { vaultAssetsOfCurrentAccount } from '../../helpers/balance-truth';

// An update must keep every account and balance (#2086: 1.17.9 moved the mainnet RPC host, the SDK names its store
// after that host, and every updated wallet opened an empty one). e2e-upgrade.yml runs this file twice on the same
// Chrome profiles and the same extension path, so the extension keeps its id and its storage: `before` restores the
// two long-lived mainnet accounts on the previous release's build and records what each shows; `after` reopens the
// profiles on the build under test, restores nothing, and must show the same account holding the same balances.

test.use({ injectFeeFaucet: false });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'this spec restores long-lived mainnet accounts');

const PHASE = process.env.E2E_UPGRADE_PHASE;
const SNAPSHOT = process.env.E2E_UPGRADE_SNAPSHOT ?? 'test-results/upgrade/before.json';

type WalletSnapshot = {
  address: string;
  /** Nonzero vault assets of the account, faucet id to base units. */
  assets: Record<string, string>;
  /** IndexedDB databases of the extension, for a failure to name the store each build opened. */
  databases: string[];
};
type Snapshot = { plain: WalletSnapshot; guardian: WalletSnapshot };

async function snapshotOf(wallet: GuardianAwareWalletPage): Promise<WalletSnapshot> {
  await wallet.refreshBalancesLanded(60_000);
  return {
    address: await wallet.getAccountAddress(),
    assets: await vaultAssetsOfCurrentAccount(wallet.page),
    databases: await databasesOf(wallet)
  };
}

async function databasesOf(wallet: GuardianAwareWalletPage): Promise<string[]> {
  return [...new Set((await wallet.listIndexedDBStores()).map(row => row.db))].sort();
}

test.describe('before the update', () => {
  test.skip(PHASE !== 'before', 'E2E_UPGRADE_PHASE=before runs this on the previous release');

  test('restore the long-lived accounts on the previous release', async ({ walletA, walletB }) => {
    test.setTimeout(1_200_000);
    const seed = process.env.E2E_MAINNET_PLAIN_SEED;
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
    if (!seed || !keyPair) throw new Error('E2E_MAINNET_PLAIN_SEED or E2E_MAINNET_GUARDIAN_KEY_PAIR is unset');

    await walletA.importOnChainWallet(seed.trim().split(/\s+/));
    await walletB.recoverGuardianFromHotKey(keyPair.trim());
    await walletA.triggerSync(true);
    await walletB.triggerSync(true);
    // A note left pending here would be consumed on the build under test (auto-consume is on by default) and move
    // the vault between the two runs, so drain them first, as the nightly does. It sends nothing when none is pending.
    await walletA.claimAllNotes(600_000);
    await walletB.claimAllNotes(600_000);

    const snapshot: Snapshot = { plain: await snapshotOf(walletA), guardian: await snapshotOf(walletB) };
    // An empty vault compares equal to the empty store a broken update opens, so it would prove nothing.
    expect(Object.keys(snapshot.plain.assets), `plain ${snapshot.plain.address} holds no asset`).not.toHaveLength(0);
    expect(
      Object.keys(snapshot.guardian.assets),
      `guardian ${snapshot.guardian.address} holds no asset`
    ).not.toHaveLength(0);
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
});

test.describe('after the update', () => {
  test.skip(PHASE !== 'after', 'E2E_UPGRADE_PHASE=after runs this on the build under test');

  test('the build under test keeps every account and balance', async ({ walletA, walletB }) => {
    test.setTimeout(1_200_000);
    const before: Snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const wallets = [
      ['plain', walletA, before.plain],
      ['guardian', walletB, before.guardian]
    ] as const;

    for (const [name, wallet, was] of wallets) {
      await wallet.unlockWallet();
      expect(await wallet.getAccountAddress(), `${name} account after the update`).toBe(was.address);
      await wallet.triggerSync(true);
      const databases = await databasesOf(wallet);
      console.log(`${name} databases before: ${was.databases.join(', ')}; after: ${databases.join(', ')}`);
      // A balance read that never lands (an account missing from the store) leaves the last reading, so the poll
      // ends on the assertion below rather than on the refresh.
      await expect
        .poll(
          async () => {
            await wallet.refreshBalancesLanded(60_000).catch(() => {});
            return vaultAssetsOfCurrentAccount(wallet.page);
          },
          { timeout: 300_000, message: `${name} ${was.address} balances after the update` }
        )
        .toEqual(was.assets);
    }
  });
});
