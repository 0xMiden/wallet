import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/two-wallets';
import type { GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { vaultReadingOfCurrentAccount } from '../../helpers/balance-truth';
import { chainVault } from '../../helpers/chain-vault';

// An update must keep every account and balance (#2086: 1.17.9 moved the mainnet RPC host, the SDK names its store
// after that host, and every updated wallet opened an empty one). e2e-upgrade.yml runs this file twice on the same
// Chrome profiles and the same extension path, so the extension keeps its id and its storage: `before` restores the
// two long-lived mainnet accounts on the previous release's build, `after` reopens the profiles on the build under test
// and restores nothing. In each phase every account must show, from a sync of that build, exactly what the node holds
// for it. Comparing with the node rather than with the first phase lets the nightly that spends these accounts run at
// the same time.

test.use({ injectFeeFaucet: false });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'this spec restores long-lived mainnet accounts');

const PHASE = process.env.E2E_UPGRADE_PHASE;
const SNAPSHOT = process.env.E2E_UPGRADE_SNAPSHOT ?? 'test-results/upgrade/before.json';
const AUTO_CONSUME_KEY = 'auto_consume_setting';

type WalletRecord = {
  address: string;
  version: string;
  /** Nonzero vault assets, faucet to base units, as the wallet and the node both showed them. */
  vault: Record<string, string>;
  /** IndexedDB databases of the extension, for a failure to name the store each build opened. */
  databases: string[];
};
type Snapshot = { plain: WalletRecord; guardian: WalletRecord };

/** The build each phase must run, from the workflow, so a phase cannot pass on the wrong one. */
async function expectVersion(wallet: GuardianAwareWalletPage): Promise<string> {
  const expected = process.env.E2E_UPGRADE_VERSION;
  if (!expected) throw new Error('E2E_UPGRADE_VERSION is unset');
  const version = await wallet.page.evaluate(() => chrome.runtime.getManifest().version);
  expect(version, 'the extension version this phase runs').toBe(expected);
  return version;
}

/**
 * Auto-consume off, as a user can set it (the setting and its service-worker mirror, settings/helpers.ts). The run then
 * sends nothing: it cannot spend these accounts or race the nightly's claims.
 */
async function turnOffAutoConsume(wallet: GuardianAwareWalletPage): Promise<void> {
  await wallet.page.evaluate(async key => {
    localStorage.setItem(key, JSON.stringify(false));
    await chrome.storage.local.set({ [key]: false });
  }, AUTO_CONSUME_KEY);
}

async function databasesOf(wallet: GuardianAwareWalletPage): Promise<string[]> {
  return [...new Set((await wallet.listIndexedDBStores()).map(row => row.db))].sort();
}

/**
 * Waits until the wallet shows exactly the node's vault for its account: in the store, after a balance read that
 * landed, and in a sync its service worker published since `since`. A sync from before `since` is the previous
 * build's, kept in extension storage across the update, so it proves nothing about this one.
 */
async function expectNodeVault(wallet: GuardianAwareWalletPage, name: string, since: number) {
  const { rpcUrl } = getEnvironmentConfig();
  const address = await wallet.getAccountAddress();
  let matched: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        const landed = await wallet
          .refreshBalancesLanded(60_000)
          .then(() => 'landed')
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        const { store, sync } = await vaultReadingOfCurrentAccount(wallet.page);
        const node = await chainVault(rpcUrl, 'mainnet', address);
        const fresh = sync !== null && sync.syncedAtMs > since ? sync.vault : null;
        const same = (vault: Record<string, string> | null) => JSON.stringify(vault) === JSON.stringify(sorted(node));
        if (landed === 'landed' && same(sorted(store)) && fresh !== null && same(sorted(fresh))) {
          matched = node;
          return 'matches the node';
        }
        return JSON.stringify({ balanceRead: landed, store, sync: fresh ?? 'none since this build started', node });
      },
      { timeout: 300_000, intervals: [5_000], message: `${name} ${address} against the node` }
    )
    .toBe('matches the node');
  return { address, vault: matched };
}

function sorted(vault: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vault).sort(([a], [b]) => a.localeCompare(b)));
}

test.describe('before the update', () => {
  test.skip(PHASE !== 'before', 'E2E_UPGRADE_PHASE=before runs this on the previous release');

  test('restore the long-lived accounts on the previous release', async ({ walletA, walletB }) => {
    test.setTimeout(1_200_000);
    const since = Date.now();
    const seed = process.env.E2E_MAINNET_PLAIN_SEED;
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
    if (!seed || !keyPair) throw new Error('E2E_MAINNET_PLAIN_SEED or E2E_MAINNET_GUARDIAN_KEY_PAIR is unset');

    await walletA.importOnChainWallet(seed.trim().split(/\s+/));
    await walletB.recoverGuardianFromHotKey(keyPair.trim());
    const records: WalletRecord[] = [];
    for (const [name, wallet] of [
      ['plain', walletA],
      ['guardian', walletB]
    ] as const) {
      await turnOffAutoConsume(wallet);
      const version = await expectVersion(wallet);
      await wallet.triggerSync(true);
      const { address, vault } = await expectNodeVault(wallet, name, since);
      // An empty vault equals the empty store a broken update opens, so it would prove nothing.
      expect(Object.keys(vault), `${name} ${address} holds no asset`).not.toHaveLength(0);
      records.push({ address, version, vault, databases: await databasesOf(wallet) });
    }

    const [plain, guardian] = records;
    if (!plain || !guardian) throw new Error('a wallet recorded nothing');
    const snapshot: Snapshot = { plain, guardian };
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
});

test.describe('after the update', () => {
  test.skip(PHASE !== 'after', 'E2E_UPGRADE_PHASE=after runs this on the build under test');

  test('the build under test keeps every account and balance', async ({ walletA, walletB }) => {
    test.setTimeout(1_200_000);
    const since = Date.now();
    const before: Snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    for (const [name, wallet, was] of [
      ['plain', walletA, before.plain],
      ['guardian', walletB, before.guardian]
    ] as const) {
      await wallet.unlockWallet();
      await expectVersion(wallet);
      expect(await wallet.getAccountAddress(), `${name} account after the update`).toBe(was.address);
      await wallet.triggerSync(true);
      console.log(
        `${name} databases before: ${was.databases.join(', ')}; after: ${(await databasesOf(wallet)).join(', ')}`
      );
      await expectNodeVault(wallet, name, since);
    }
  });
});
