import * as fs from 'fs';
import * as path from 'path';

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
 * Fail fast unless the built extension targets the same network as the harness.
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
