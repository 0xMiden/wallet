import * as fs from 'fs';
import * as path from 'path';

import type { EnvironmentConfig } from './types';
import type { IdbDumpSource } from '../helpers/idb-dump';

/**
 * Build/harness network agreement guard.
 *
 * The blockchain suite drives a wallet build against a live network: the
 * harness endpoints come from `E2E_NETWORK` (playwright/e2e/config/environments.ts)
 * while the extension's own endpoints come from `MIDEN_NETWORK`, baked in at
 * BUILD time. `yarn test:e2e:blockchain:<network>` keeps the two matched, but
 * nothing stopped a run from loading a `dist/chrome_unpacked` left behind by an
 * earlier build for a DIFFERENT network -- e.g. a testnet bundle driven by the
 * localhost (docker) harness. Every note the CLI mints then lands on one chain
 * while the wallet syncs another, so the suite proves nothing and reports
 * product-shaped failures (missing notes, zero balances) instead.
 *
 * This module reads the network actually baked into the built bundles so the
 * fixture can fail before a browser is even launched.
 *
 * WHY read the bundle rather than `process.env.MIDEN_NETWORK`: the env var
 * describes the build the runner *intended*, not the bytes on disk. A stale or
 * partially rebuilt `dist/` is exactly the failure being guarded against, so
 * the signal has to come from the artifact Chrome is about to load.
 *
 * The signal: `src/lib/miden-chain/networks-config.ts` has
 * `export const DEFAULT_NETWORK = resolveNetworkName(process.env.MIDEN_NETWORK)`,
 * and the bundler inlines the `process.env.MIDEN_NETWORK` define into it, so
 * the emitted (unminified) bundles carry the raw build token verbatim:
 * `DEFAULT_NETWORK = resolveNetworkName("localhost");`. Scanning the emitted JS
 * for that assignment costs ~25ms over the bundle text and needs no cooperation
 * from the running extension.
 *
 * The baked network is the one the wallet runs on only while no endpoint override
 * is stored. A run that stores one (Developer Settings, on a build that reads
 * stored overrides) runs where the override points, which no bundle can show, so
 * such a run checks it at runtime with `assertWalletRunsOnStoredOverride`.
 */

/** Wallet network tokens -- mirrors `MIDEN_NETWORK_NAME` in src/lib/miden-chain/networks-config.ts. */
const WALLET_NETWORKS = ['mainnet', 'testnet', 'devnet', 'localnet'];

/**
 * Mirror of `resolveNetworkName()` in src/lib/miden-chain/networks-config.ts:
 * the wallet build normalizes the raw `MIDEN_NETWORK` token to a network enum
 * value, mapping the harness's `localhost` token onto `localnet` and falling
 * back to `testnet` for anything unrecognized (including an unset token).
 *
 * The harness's own `E2E_NETWORK` names go through the SAME normalization, so
 * the guard compares like with like whichever token each side happens to use.
 */
export function resolveWalletNetwork(raw: string | undefined): string {
  if (raw === 'localhost') return 'localnet';
  return WALLET_NETWORKS.includes(raw ?? '') ? (raw ?? '') : 'testnet';
}

/**
 * `DEFAULT_NETWORK = resolveNetworkName("<MIDEN_NETWORK>")` -- the shape the
 * current source compiles to, carrying the raw build token. The function name
 * is matched loosely because the bundler may alias it (e.g. `resolveNetworkName$1`).
 */
const BAKED_CALL_RE = /\bDEFAULT_NETWORK\s*=\s*[A-Za-z_$][\w$]*\(\s*["']([^"']*)["']\s*\)/g;

/**
 * `DEFAULT_NETWORK = MIDEN_NETWORK_NAME.TESTNET` / `DEFAULT_NETWORK = "testnet"`
 * -- the shapes a constant-folding bundler (or a source that assigns the enum
 * value directly, as this one did before `resolveNetworkName` landed) emits.
 */
const BAKED_LITERAL_RE =
  /\bDEFAULT_NETWORK\s*=\s*(?:[A-Za-z_$][\w$]*\.(MAINNET|TESTNET|DEVNET|LOCALNET)\b|["'](mainnet|testnet|devnet|localnet)["'])/g;

/** The emitted JS of the extension: entry bundles at the root plus shared chunks. */
function bundleFiles(extensionPath: string): string[] {
  const files: string[] = [];
  for (const dir of ['.', 'chunks']) {
    const abs = path.join(extensionPath, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs)) {
      if (entry.endsWith('.js')) files.push(dir === '.' ? entry : path.join(dir, entry));
    }
  }
  return files;
}

export interface BakedNetworkReading {
  /** Wallet network the bundle resolves to, e.g. `localnet`. */
  network: string;
  /** The token as it appears in the bundle, e.g. `localhost` -- what MIDEN_NETWORK was set to. */
  raw: string;
  /** Bundle file the reading came from, relative to the extension dir. */
  source: string;
}

/**
 * Every DISTINCT network baked into the built extension, with the first file
 * each was read from. Normally one entry; more than one means the bundles
 * disagree with each other (a partial rebuild -- e.g. `build:bg` re-run for a
 * different network on top of an existing `dist/`), which is just as broken as
 * disagreeing with the harness.
 */
export function readBakedNetworks(extensionPath: string): BakedNetworkReading[] {
  const readings = new Map<string, BakedNetworkReading>();
  const add = (raw: string, source: string) => {
    const network = resolveWalletNetwork(raw);
    if (!readings.has(network)) readings.set(network, { network, raw, source });
  };

  for (const rel of bundleFiles(extensionPath)) {
    const code = fs.readFileSync(path.join(extensionPath, rel), 'utf8');
    for (const match of code.matchAll(BAKED_CALL_RE)) {
      if (match[1] !== undefined) add(match[1], rel);
    }
    for (const match of code.matchAll(BAKED_LITERAL_RE)) {
      const literal = match[1] ?? match[2];
      if (literal !== undefined) add(literal.toLowerCase(), rel);
    }
  }
  return [...readings.values()];
}

/** Assert-once memo: this runs on every wallet launch, twice per test (A + B). */
const verified = new Set<string>();

/**
 * Fail fast unless the built extension's default network is the harness's.
 *
 * @param extensionPath unpacked extension directory about to be loaded
 * @param harnessNetwork the harness environment name (`E2E_NETWORK`)
 */
export function assertExtensionNetworkMatches(extensionPath: string, harnessNetwork: string): void {
  const memoKey = `${extensionPath} ${harnessNetwork}`;
  if (verified.has(memoKey)) return;

  const expected = resolveWalletNetwork(harnessNetwork);
  const readings = readBakedNetworks(extensionPath);
  const rebuild = `E2E_NETWORK=${harnessNetwork} yarn test:e2e:blockchain:build`;
  const first = readings[0];

  if (!first) {
    throw new Error(
      `Could not read the network baked into the extension at ${extensionPath}. ` +
        `The guard looks for the DEFAULT_NETWORK assignment in the emitted bundles ` +
        `(see playwright/e2e/harness/extension-network.ts); a minified build (MODE_ENV=production) ` +
        `hides it, and a bundler-output change can move it. ` +
        `Rebuild with "${rebuild}" -- if that still fails, the guard needs updating.`
    );
  }

  const mismatched = readings.filter(r => r.network !== expected);
  if (mismatched.length > 0) {
    const found = readings.map(r => `"${r.network}" (MIDEN_NETWORK=${r.raw}, ${r.source})`).join(', ');
    throw new Error(
      `Extension/harness network mismatch: the build at ${extensionPath} targets ${found}, ` +
        `but this run drives it against the "${harnessNetwork}" harness ` +
        `(E2E_NETWORK=${harnessNetwork} -> wallet network "${expected}"). ` +
        `The wallet would talk to a different chain than the miden-client CLI, so nothing under test ` +
        `would be real. Rebuild the extension for this network: "${rebuild}".`
    );
  }

  verified.add(memoKey);
  console.log(`[e2e] extension network "${expected}" matches harness "${harnessNetwork}" (read from ${first.source})`);
}

/**
 * The IndexedDB store the SDK opens for each URL of the localnet node, `MidenClientDB_<network id>`: miden-client's
 * `Endpoint::to_network_id` names `http://localhost:57291` `mlcl` and every endpoint it does not name `mcst`. These are
 * the only URLs the stored-override guard reads, so it refuses any other rather than guess its store.
 */
export const LOCALNET_SDK_STORES: ReadonlyMap<string, string> = new Map([
  ['http://localhost:57291', 'MidenClientDB_mlcl'],
  ['http://127.0.0.1:57291', 'MidenClientDB_mcst']
]);

function localnetSdkStore(rpcUrl: string): string {
  const store = LOCALNET_SDK_STORES.get(rpcUrl);
  if (store === undefined) {
    throw new Error(
      `No SDK store is known for ${rpcUrl}: LOCALNET_SDK_STORES names only ` +
        `${[...LOCALNET_SDK_STORES.keys()].join(' and ')}.`
    );
  }
  return store;
}

/** `ENDPOINT_OVERRIDE_STORAGE_KEY` in src/lib/miden-chain/effective-endpoints.ts. */
const ENDPOINT_OVERRIDE_STORAGE_KEY = 'endpoint_overrides';
/** The SDK's table of the accounts a store holds, one row each. */
const SDK_ACCOUNT_TABLE = 'latestAccountHeaders';

/** What the runtime check reads from a wallet: its extension storage and its IndexedDB. */
export type StoredOverrideProbe = IdbDumpSource & { dumpChromeStorage(): Promise<Record<string, unknown>> };

function readStoredOverride(value: unknown): { rpcUrl: string; networkName: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rpcUrl: unknown = Reflect.get(value, 'rpcUrl');
  const networkName: unknown = Reflect.get(value, 'networkName');
  return typeof rpcUrl === 'string' && typeof networkName === 'string' ? { rpcUrl, networkName } : undefined;
}

/**
 * Fail unless the wallet runs on the endpoint override stored in its extension storage, once its first account exists.
 *
 * A build made with `MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES=true` (every E2E build but
 * `test:e2e:stored-override:build`) ignores a stored override, so a spec that stores one would pass on the build
 * default and prove nothing. So: the override is the one the spec stored (`expectedRpcUrl`) and names the harness's
 * network; its RPC URL opens another store than the harness's own URL, the build default's (else a realm left on the
 * build default reads the same data and nothing can tell them apart); and the account the service worker created is in
 * the override's store.
 */
export async function assertWalletRunsOnStoredOverride(
  wallet: StoredOverrideProbe,
  harness: Pick<EnvironmentConfig, 'name' | 'rpcUrl'>,
  expectedRpcUrl: string
): Promise<void> {
  const override = readStoredOverride((await wallet.dumpChromeStorage())[ENDPOINT_OVERRIDE_STORAGE_KEY]);
  if (!override) {
    throw new Error(`No endpoint override is stored under "${ENDPOINT_OVERRIDE_STORAGE_KEY}"`);
  }
  if (override.rpcUrl !== expectedRpcUrl) {
    throw new Error(
      `The stored endpoint override's RPC URL is ${override.rpcUrl}, but this spec stored ${expectedRpcUrl}.`
    );
  }

  const expected = resolveWalletNetwork(harness.name);
  if (override.networkName !== expected) {
    throw new Error(
      `The stored endpoint override names network "${override.networkName}", but this run drives the ` +
        `"${harness.name}" harness (wallet network "${expected}").`
    );
  }

  const overrideStore = localnetSdkStore(override.rpcUrl);
  const defaultStore = localnetSdkStore(harness.rpcUrl);
  if (overrideStore === defaultStore) {
    throw new Error(
      `The stored override's RPC URL ${override.rpcUrl} opens ${overrideStore}, the same store as the build default ` +
        `${harness.rpcUrl}, so a realm left on the build default could not be told apart. Reach the node through ` +
        `another host name.`
    );
  }

  const withAccounts = new Set(
    (await wallet.listIndexedDBStores()).filter(entry => entry.store === SDK_ACCOUNT_TABLE).map(entry => entry.db)
  );
  const accountsIn = async (db: string) =>
    withAccounts.has(db) ? (await wallet.dumpIndexedDBStore(db, SDK_ACCOUNT_TABLE, 10)).count : 0;
  if ((await accountsIn(overrideStore)) > 0) return;

  const onDefault = await accountsIn(defaultStore);
  throw new Error(
    `The service worker created no account in ${overrideStore}, the store of the stored override ` +
      `(${override.rpcUrl})${onDefault > 0 ? `, and ${onDefault} in ${defaultStore}, the build default's` : ''}. ` +
      `A build made with MIDEN_E2E_DISABLE_ENDPOINT_OVERRIDES=true ignores a stored override: rebuild with ` +
      `"yarn test:e2e:stored-override:build".`
  );
}
