import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/two-wallets';
import type { GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import { vaultReadingOfCurrentAccount } from '../../helpers/balance-truth';
import { nodeAccount } from '../../helpers/node-account';

// An update must keep every account and balance (#2086: 1.17.9 moved the mainnet RPC host, the SDK names its store
// after that host, and every updated wallet opened an empty one). e2e-upgrade.yml runs this file twice on the same
// Chrome profile and the same extension path, so the extension keeps its id and its storage: `before` restores the
// long-lived mainnet Guardian account on the previous release's build, `after` reopens the profile on the build under
// test and restores nothing. The account is private and guarded, as every wallet account is, so the node holds only
// its commitment: the build under test must show the vault phase 1 recorded, while that commitment shows the account
// has not transacted since. The workflow shares the mainnet nightly's concurrency group so the nightly cannot move it.

test.use({ injectFeeFaucet: false });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'this spec restores a long-lived mainnet account');

const PHASE = process.env.E2E_UPGRADE_PHASE;
const SNAPSHOT = process.env.E2E_UPGRADE_SNAPSHOT ?? 'test-results/upgrade/before.json';
const AUTO_CONSUME_KEY = 'auto_consume_setting';

type Snapshot = {
  address: string;
  version: string;
  /** Nonzero vault assets, faucet to base units, as the previous release showed them. */
  vault: Record<string, string>;
  /** The node's commitment of the account when the vault was recorded. */
  commitment: string;
  /** IndexedDB databases of the extension, for a failure to name the store each build opened. */
  databases: string[];
};

/**
 * The build each phase must run, from the workflow, so a phase cannot pass on the wrong one. A release candidate's
 * manifest `version` drops the prerelease suffix and `version_name` keeps it (vite.extension.config.ts).
 */
async function expectVersion(wallet: GuardianAwareWalletPage): Promise<string> {
  const expected = process.env.E2E_UPGRADE_VERSION;
  if (!expected) throw new Error('E2E_UPGRADE_VERSION is unset');
  const version = await wallet.page.evaluate(() => {
    const manifest = chrome.runtime.getManifest();
    return manifest.version_name ?? manifest.version;
  });
  expect(version, 'the extension version this phase runs').toBe(expected);
  return version;
}

/**
 * Auto-consume off, as a user can set it (the setting and its service-worker mirror, settings/helpers.ts). The run then
 * sends nothing: a claim would move the vault between the phases and spend the nightly's account.
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

function sorted(vault: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(vault).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Waits until the wallet shows `expected` (or, without one, the same vault in both places) for its account: in the
 * store, after a balance read that landed, and in a sync its service worker published since `since`. A sync from before
 * `since` is the previous build's, kept in extension storage across the update, so it proves nothing about this one.
 * `check` runs on every attempt and may throw to end the wait; any other failed read only fails that attempt. Returns
 * the vault it matched.
 */
async function expectWalletVault(
  wallet: GuardianAwareWalletPage,
  since: number,
  expected?: Record<string, string>,
  check: () => Promise<void> = async () => {}
): Promise<Record<string, string>> {
  const address = await wallet.getAccountAddress();
  let matched: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        await check();
        const landed = await wallet
          .refreshBalancesLanded(60_000)
          .then(() => 'landed')
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        const reading = await vaultReadingOfCurrentAccount(wallet.page).catch((error: unknown) =>
          error instanceof Error ? error.message : String(error)
        );
        if (typeof reading === 'string') return JSON.stringify({ balanceRead: landed, vaultReading: reading });
        const { store, sync } = reading;
        const synced = sync !== null && sync.syncedAtMs > since ? sync.vault : null;
        const want = expected ?? synced;
        if (landed === 'landed' && synced !== null && want !== null) {
          if (sorted(store) === sorted(want) && sorted(synced) === sorted(want)) {
            matched = want;
            return 'matches';
          }
        }
        return JSON.stringify({ balanceRead: landed, store, sync: synced ?? 'none since this build started', want });
      },
      { timeout: 300_000, intervals: [5_000], message: `${address} balances` }
    )
    .toBe('matches');
  return matched;
}

test.describe('before the update', () => {
  test.skip(PHASE !== 'before', 'E2E_UPGRADE_PHASE=before runs this on the previous release');

  test('restore the long-lived Guardian account on the previous release', async ({ walletA }) => {
    test.setTimeout(1_200_000);
    const since = Date.now();
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
    if (!keyPair) throw new Error('E2E_MAINNET_GUARDIAN_KEY_PAIR is unset');

    // The hot key the nightly holds, so the restore rotates nothing; auto-consume goes off before the first sync.
    await walletA.recoverGuardianFromHotKey(keyPair.trim());
    await turnOffAutoConsume(walletA);
    const version = await expectVersion(walletA);
    const address = await walletA.getAccountAddress();
    const node = await nodeAccount(getEnvironmentConfig().rpcUrl, address);
    expect(node.isPrivate, `${address} is a private, guarded account, as every wallet account is`).toBe(true);

    await walletA.triggerSync(true);
    const vault = await expectWalletVault(walletA, since);
    // An empty vault equals the empty store a broken update opens, so it would prove nothing.
    expect(Object.keys(vault), `${address} holds no asset`).not.toHaveLength(0);
    // Read after the vault, so a transaction landing during the wait cannot leave an older commitment beside it.
    const { commitment } = await nodeAccount(getEnvironmentConfig().rpcUrl, address);
    expect(commitment, `${address} transacted while its vault was read`).toBe(node.commitment);

    const snapshot: Snapshot = { address, version, vault, commitment, databases: await databasesOf(walletA) };
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
});

test.describe('after the update', () => {
  test.skip(PHASE !== 'after', 'E2E_UPGRADE_PHASE=after runs this on the build under test');

  test('the build under test keeps the account and every balance', async ({ walletA }) => {
    test.setTimeout(1_200_000);
    const since = Date.now();
    const before: Snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    // Phase 1's vault is the only reference for a private account, and it holds only while the account has not moved.
    // A read the node fails is no evidence either way; only a commitment it reports as moved ends the run.
    const unmoved = async () => {
      const read = await nodeAccount(getEnvironmentConfig().rpcUrl, before.address).catch(() => null);
      const commitment = read?.commitment ?? before.commitment;
      if (commitment !== before.commitment) {
        throw new Error(
          `${before.address} transacted between the phases (node commitment ${before.commitment} to ${commitment}), ` +
            'so its vault before the update no longer applies'
        );
      }
    };

    await walletA.unlockWallet();
    await expectVersion(walletA);
    expect(await walletA.getAccountAddress(), 'the account after the update').toBe(before.address);
    await unmoved();
    await walletA.triggerSync(true);
    console.log(`databases before: ${before.databases.join(', ')}; after: ${(await databasesOf(walletA)).join(', ')}`);
    await expectWalletVault(walletA, since, before.vault, unmoved);
  });
});
