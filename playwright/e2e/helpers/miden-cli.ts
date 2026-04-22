import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { CLIRunner } from '../harness/cli-runner';
import type { CLIInvocation, EnvironmentConfig } from '../harness/types';

const FAUCET_INIT_TOML = `["miden::standards::fungible_faucets::metadata"]
max_supply = "1000000000000"
decimals = "8"
symbol = "TST"
`;

/**
 * Resolve the miden-client binary path.
 * 1. MIDEN_CLIENT_BIN env var
 * 2. `miden-client` in PATH
 * 3. Auto-install from crates.io at the version matching the wallet's SDK
 */
export function resolveCliPath(): string {
  // 1. Explicit override
  if (process.env.MIDEN_CLIENT_BIN) {
    return process.env.MIDEN_CLIENT_BIN;
  }

  // 2. Already in PATH
  try {
    execSync('miden-client --version', { stdio: 'pipe' });
    return 'miden-client';
  } catch {
    // not found
  }

  // 3. Auto-install from crates.io
  let version: string;
  try {
    const sdkPkgPath = path.resolve('node_modules/@miden-sdk/miden-sdk/package.json');
    const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf8'));
    version = sdkPkg.version;
  } catch {
    throw new Error(
      'Cannot determine miden-sdk version from node_modules. Run `yarn install` first.'
    );
  }

  console.log(`Installing miden-client-cli@${version} from crates.io (first run only)...`);
  try {
    execSync(`cargo install miden-client-cli --version ${version}`, {
      stdio: 'inherit',
      timeout: 600_000, // 10 min for compile
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
  private faucetId: string | undefined;
  private binaryPath: string;
  private workDir: string;
  private env: EnvironmentConfig;
  private cliRunner: CLIRunner;

  constructor(opts: {
    binaryPath: string;
    workDir: string;
    env: EnvironmentConfig;
    cliRunner: CLIRunner;
  }) {
    this.binaryPath = opts.binaryPath;
    this.workDir = opts.workDir;
    this.env = opts.env;
    this.cliRunner = opts.cliRunner;
  }

  private async run(args: string, opts?: { timeoutMs?: number }): Promise<CLIInvocation> {
    return this.cliRunner.run(`${this.binaryPath} ${args}`, {
      cwd: this.workDir,
      timeoutMs: opts?.timeoutMs,
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
  async createFaucet(): Promise<string> {
    // Write the init storage data TOML
    const tomlPath = path.join(this.workDir, 'faucet-init.toml');
    fs.writeFileSync(tomlPath, FAUCET_INIT_TOML);

    const createArgs =
      `new-account --account-type fungible-faucet ` +
      `-p basic-fungible-faucet ` +
      `--storage-mode public ` +
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
      const transient =
        /HTTP status code 5\d\d|grpc request failed|grpc-status header missing|connection reset|timed out|Temporary failure/i.test(
          lastErr
        );
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(`[miden-cli] createFaucet attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }

    if (!createResult || createResult.exitCode !== 0) {
      throw new Error(`Failed to create faucet: ${lastErr}`);
    }

    // Parse account ID from stdout
    const accountId = createResult.parsed?.accountId;
    if (!accountId) {
      // Fallback: try to parse from "account -s <ID>" pattern
      const match = createResult.stdout.match(/account\s+-s\s+(\S+)/);
      if (!match) {
        throw new Error(
          `Could not parse faucet account ID from output:\n${createResult.stdout}`
        );
      }
      this.faucetId = match[1];
    } else {
      this.faucetId = accountId;
    }

    // Sync to confirm deployment
    await this.sync();

    return this.faucetId!;
  }

  /**
   * Mint tokens from the deployed faucet to a target account.
   */
  async mint(
    targetAccountId: string,
    amount: number,
    noteType: 'public' | 'private'
  ): Promise<{ txId: string; noteId: string }> {
    if (!this.faucetId) {
      throw new Error('Faucet not deployed. Call createFaucet() first.');
    }

    let mintArgs =
      `mint --target ${targetAccountId} ` +
      `--asset ${amount}::${this.faucetId} ` +
      `--note-type ${noteType} ` +
      `--force`;

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
      const transient =
        /HTTP status code 5\d\d|grpc request failed|grpc-status header missing|connection reset|timed out|Temporary failure/i.test(
          lastErr
        );
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(`[miden-cli] mint attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`);
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
      const transient =
        /HTTP status code 5\d\d|grpc request failed|grpc-status header missing|connection reset|timed out|Temporary failure/i.test(
          lastErr
        );
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(`[miden-cli] sync attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
    throw new Error(`Sync failed: ${lastErr}`);
  }

  /**
   * Get the faucet ID (if deployed).
   */
  getFaucetId(): string | undefined {
    return this.faucetId;
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
