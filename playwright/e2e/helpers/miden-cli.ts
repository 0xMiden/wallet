import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { CLIRunner } from '../harness/cli-runner';
import type { CLIInvocation, EnvironmentConfig } from '../harness/types';

const DEFAULT_FAUCET_MAX_SUPPLY = 1_000_000_000_000;

const faucetInitToml = (symbol: string, decimals: number, maxSupply: number | bigint = DEFAULT_FAUCET_MAX_SUPPLY) =>
  `[fungible-faucet-metadata]\nmax_supply = ${maxSupply}\ndecimals = ${decimals}\nsymbol = "${symbol}"\n`;

/**
 * Classify a `miden-client` CLI stderr as a transient failure that should be
 * retried (vs. a deterministic error that should fail fast). Matched
 * wrap-tolerantly with `\s+` because miette folds messages at terminal width.
 *
 * Categories:
 *  - RPC/transport to the node: 5xx, gRPC framing, reset/timeout.
 *  - `new nonce N is less than old nonce M`: the node's account state lags the
 *    store's optimistic post-submit state while a deploy/mint is still in
 *    flight, and miden-client's sqlite store hard-fails the whole sync on it
 *    (0xMiden/miden-client#2243). Clears once the tx commits.
 *  - Remote-prover connection failures (`failed to connect to ... prover`,
 *    `transport error`, `no native certs found`): the TLS/gRPC handshake to the
 *    delegated prover endpoint flakes intermittently on the macOS CI runners
 *    (a sibling mint in the same test connects fine), so a connection-level
 *    prover error is transient, not a proving-logic failure.
 */
export function isTransientCliError(stderr: string): boolean {
  return /HTTP status code 5\d\d|grpc request failed|grpc-status header missing|connection reset|timed out|Temporary failure|less\s+than\s+old\s+nonce|failed\s+to\s+connect\s+to(\s+the)?(\s+remote)?\s+prover|transport\s+error|no\s+native\s+certs/i.test(
    stderr
  );
}

/**
 * Resolve the miden-client binary path.
 * 1. MIDEN_CLIENT_BIN env var
 * 2. `miden-client` in PATH
 * 3. Auto-install from crates.io at the pinned `midenClientCliVersion` from
 *    the root package.json (decoupled from the JS SDK version — the
 *    miden-client Rust workspace and `@miden-sdk/*` npm packages release on
 *    independent cadences, so version-matching them was brittle: a JS-only
 *    SDK bump would request a CLI version that doesn't exist on crates.io
 *    and CI would fail before the test even ran).
 */
export function resolveCliPath(): string {
  // 1. Explicit override
  if (process.env.MIDEN_CLIENT_BIN) {
    return process.env.MIDEN_CLIENT_BIN;
  }

  // 2. Already in PATH — but only if it is the PINNED version.
  //
  // This used to return on any `--version` that exited 0, which meant a
  // developer's own `miden-client` silently won regardless of version. A 0.16
  // CLI against a 0.15 node fails with
  //
  //     cli::client_error ├─▶ accept header validation failed
  //
  // which names neither the version nor the mismatch, and sends you looking at
  // the wallet. Presence is not the same as correctness — the same trap as an
  // AVD that is listed but has no config.ini.
  try {
    const reported = execSync('miden-client --version', { stdio: 'pipe' }).toString().trim();
    const pinned = readPinnedCliVersion();
    if (!pinned || reported.includes(pinned)) {
      return 'miden-client';
    }
    // Under a GIT pin the version field records what the rev builds, and a rev
    // bump can legitimately land before the field catches up. So WARN rather
    // than fail: a hard failure here reds every E2E job over metadata lag, which
    // is worse than the mismatch it reports. This is not hypothetical — the
    // first version of this check did exactly that, because the field read
    // 0.14.8 while the pinned rev builds 0.15.0 (corrected in #675).
    if (hasGitPin()) {
      console.warn(
        `[miden-cli] PATH miden-client is "${reported}" but package.json records ${pinned} for the pinned rev. ` +
          `If chain calls fail with "accept header validation failed", this mismatch is why — point ` +
          `MIDEN_CLIENT_BIN at a binary built from the pinned rev.`
      );
      return 'miden-client';
    }
    throw new Error(
      `miden-client on PATH is "${reported}" but this repo pins ${pinned} ` +
        `(package.json → midenClientCliVersion).\n` +
        `A mismatched CLI fails against the node with an unrelated-looking "accept header validation failed".\n` +
        `Either install the pin (cargo install miden-client-cli --version ${pinned} --locked) or point the ` +
        `harness at a matching binary with MIDEN_CLIENT_BIN=/path/to/miden-client.`
    );
  } catch (err) {
    // A version MISMATCH is a hard stop; only "not installed" falls through to
    // the auto-install below.
    if (err instanceof Error && err.message.includes('but this repo pins')) throw err;
  }

  // (see readPinnedCliVersion below for where the pin comes from)

  // 3. Auto-install at the pin from package.json. Two pin shapes:
  //    - `midenClientCliGit: { url, rev }` — takes precedence; used while the
  //      target miden-client line is unreleased on crates.io (e.g. the 0.15
  //      series ships from the repo's `next` branch only). Pinned to a REV,
  //      not a branch, so installs are reproducible and match the protocol
  //      rev the bundled SDK WASM was built against.
  //    - `midenClientCliVersion: "x.y.z"` — crates.io release.
  let version: string | undefined;
  let gitPin: { url: string; rev: string } | undefined;
  try {
    const pkgPath = path.resolve('package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    gitPin = pkg.midenClientCliGit;
    version = pkg.midenClientCliVersion;
    if (gitPin && (typeof gitPin.url !== 'string' || typeof gitPin.rev !== 'string')) {
      throw new Error('midenClientCliGit must have string `url` and `rev` fields');
    }
    if (!gitPin && (!version || typeof version !== 'string')) {
      throw new Error('midenClientCliVersion missing from package.json');
    }
  } catch (err: any) {
    throw new Error(`Cannot resolve miden-client CLI pin from package.json: ${err.message}`);
  }

  if (gitPin) {
    console.log(`Installing miden-client-cli from ${gitPin.url}@${gitPin.rev.slice(0, 8)} (first run only)...`);
    try {
      // `--locked` consumes the repo's Cargo.lock at that rev — same
      // MAST-root-drift protection as the crates.io path below.
      execSync(`cargo install miden-client-cli --git ${gitPin.url} --rev ${gitPin.rev} --locked`, {
        stdio: 'inherit',
        timeout: 600_000 // 10 min for compile
      });
    } catch (err: any) {
      throw new Error(
        `Failed to install miden-client-cli from ${gitPin.url}@${gitPin.rev}. ` +
          `Ensure the Rust toolchain is installed (https://rustup.rs). Error: ${err.message}`
      );
    }
    return 'miden-client';
  }

  console.log(`Installing miden-client-cli@${version} from crates.io (first run only)...`);
  try {
    // `--locked` consumes the Cargo.lock shipped with the published crate,
    // which pins `miden-assembly` (and every other transitive) to the same
    // versions the SDK released against. Without it, cargo re-resolves
    // each dep to the latest semver-compatible version at install time —
    // and miden-assembly patch releases have moved BasicFungibleFaucet's
    // procedure MAST roots (see miden-vm#3144). That drift causes the
    // wallet (built against miden-assembly 0.22.1 via the bundled SDK)
    // to fall through `BasicFungibleFaucetComponent::from_account` for
    // CLI-deployed faucets, rendering the token as "Unknown" instead of
    // its real symbol — which then breaks any test selector that filters
    // by token symbol.
    execSync(`cargo install miden-client-cli --version ${version} --locked`, {
      stdio: 'inherit',
      timeout: 600_000 // 10 min for compile
    });
  } catch (err: any) {
    throw new Error(
      `Failed to install miden-client-cli@${version} from crates.io. ` +
        `Ensure the Rust toolchain is installed (https://rustup.rs). Error: ${err.message}`
    );
  }

  return 'miden-client';
}

/**
 * High-level wrapper around the miden-client CLI.
 * Each test run gets an isolated .miden directory via --local.
 */
export class MidenCli {
  private faucets = new Map<string, string>(); // symbol -> faucetId
  private lastFaucetId?: string;
  private binaryPath: string;
  private workDir: string;
  private env: EnvironmentConfig;
  private cliRunner: CLIRunner;

  constructor(opts: { binaryPath: string; workDir: string; env: EnvironmentConfig; cliRunner: CLIRunner }) {
    this.binaryPath = opts.binaryPath;
    this.workDir = opts.workDir;
    this.env = opts.env;
    this.cliRunner = opts.cliRunner;
  }

  private async run(args: string, opts?: { timeoutMs?: number }): Promise<CLIInvocation> {
    return this.cliRunner.run(`${this.binaryPath} ${args}`, {
      cwd: this.workDir,
      timeoutMs: opts?.timeoutMs
    });
  }

  /**
   * Initialize the miden-client with --local for isolated state.
   */
  async init(): Promise<void> {
    fs.mkdirSync(this.workDir, { recursive: true });

    let initArgs = `init --local --network ${this.env.networkFlag}`;

    // For localhost, note transport must be passed explicitly
    if (this.env.networkFlag === 'localhost' && this.env.transportUrl) {
      initArgs += ` --note-transport-endpoint ${this.env.transportUrl}`;
    }

    // Remote prover for testnet/devnet
    if (this.env.provingUrl && this.env.delegateProving) {
      initArgs += ` --remote-prover-endpoint ${this.env.provingUrl}`;
    }

    const result = await this.run(initArgs);
    if (result.exitCode !== 0) {
      throw new Error(`miden-client init failed: ${result.stderr}`);
    }

    // Sync to fetch genesis block and chain tip (required before account creation)
    await this.sync();
  }

  /**
   * Deploy a new fungible faucet account.
   * Returns the faucet account ID.
   */
  async createFaucet(
    symbol = 'TST',
    decimals = 8,
    maxSupply: number | bigint = DEFAULT_FAUCET_MAX_SUPPLY
  ): Promise<string> {
    // Write the init storage data TOML
    const tomlPath = path.join(this.workDir, 'faucet-init.toml');
    fs.writeFileSync(tomlPath, faucetInitToml(symbol, decimals, maxSupply));

    const createArgs =
      `new-account --account-type public ` +
      `-p basic-fungible-faucet ` +
      `--init-storage-data-path ${tomlPath} ` +
      `--deploy`;

    const maxAttempts = 5;
    let lastErr = '';
    let createResult: CLIInvocation | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      createResult = await this.run(createArgs, { timeoutMs: 180_000 });
      if (createResult.exitCode === 0) {
        break;
      }
      lastErr = createResult.stderr;
      const transient = isTransientCliError(lastErr);
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(
        `[miden-cli] createFaucet attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`
      );
      await new Promise(r => setTimeout(r, backoffMs));
    }

    if (!createResult || createResult.exitCode !== 0) {
      throw new Error(`Failed to create faucet: ${lastErr}`);
    }

    // Parse account ID from stdout
    const accountId = createResult.parsed?.accountId;
    let id: string;
    if (!accountId) {
      // Fallback: try to parse from "account -s <ID>" pattern
      const match = createResult.stdout.match(/account\s+-s\s+(\S+)/);
      if (!match || !match[1]) {
        throw new Error(`Could not parse faucet account ID from output:\n${createResult.stdout}`);
      }
      id = match[1];
    } else {
      id = accountId;
    }

    this.faucets.set(symbol, id);
    this.lastFaucetId = id;

    // Sync to confirm deployment
    await this.sync();

    return id;
  }

  /**
   * Mint tokens from the deployed faucet to a target account.
   */
  async mint(
    faucetId: string,
    targetAccountId: string,
    amount: number | bigint,
    noteType: 'public' | 'private'
  ): Promise<{ txId: string; noteId: string }> {
    if (!faucetId) {
      throw new Error('mint: faucetId required');
    }

    let mintArgs = `mint --target ${targetAccountId} --asset ${amount}::${faucetId} --note-type ${noteType} --force`;

    if (this.env.delegateProving) {
      mintArgs += ' --delegate-proving';
    }

    const maxAttempts = 5;
    let lastErr = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.run(mintArgs, { timeoutMs: this.env.txTimeoutMs });
      if (result.exitCode === 0) {
        const txId = result.parsed?.transactionId;
        const noteId = result.parsed?.noteId;
        if (!txId || !noteId) {
          throw new Error(`Could not parse mint result from output:\n${result.stdout}`);
        }
        return { txId, noteId };
      }
      lastErr = result.stderr;
      const transient = isTransientCliError(lastErr);
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(
        `[miden-cli] mint attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`
      );
      await new Promise(r => setTimeout(r, backoffMs));
    }
    throw new Error(`Mint failed after retries: ${lastErr}`);
  }

  /**
   * Sync the miden-client state with the network.
   */
  async sync(): Promise<void> {
    const maxAttempts = 5;
    let lastErr = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.run('sync', { timeoutMs: 60_000 });
      if (result.exitCode === 0) return;
      lastErr = result.stderr;
      const transient = isTransientCliError(lastErr);
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(
        `[miden-cli] sync attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`
      );
      await new Promise(r => setTimeout(r, backoffMs));
    }
    throw new Error(`Sync failed: ${lastErr}`);
  }

  /**
   * Get the faucet ID (if deployed).
   */
  getFaucetId(): string | undefined {
    return this.lastFaucetId;
  }

  /**
   * Get the work directory path.
   */
  getWorkDir(): string {
    return this.workDir;
  }

  /**
   * Clean up the isolated miden-client directory.
   */
  async cleanup(): Promise<void> {
    try {
      fs.rmSync(this.workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * The CLI version this repo pins, or undefined if package.json does not declare
 * one (in which case a PATH binary is accepted as-is, the previous behaviour).
 */
function readPinnedCliVersion(): string | undefined {
  try {
    const pkgPath = path.resolve('package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { midenClientCliVersion?: string };
    return typeof pkg.midenClientCliVersion === 'string' ? pkg.midenClientCliVersion : undefined;
  } catch {
    return undefined;
  }
}

/** Is the CLI pinned by git rev? If so, `midenClientCliVersion` does not describe the installed binary. */
function hasGitPin(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      midenClientCliGit?: { url?: string; rev?: string };
    };
    return typeof pkg.midenClientCliGit?.rev === 'string';
  } catch {
    return false;
  }
}
