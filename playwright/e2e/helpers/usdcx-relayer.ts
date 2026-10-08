import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The xReserve deposit relayer (0xMiden/miden-usdcx, `xreserve-deposit-relayer`)
 * as a local process, for the live USDCx bridge-in E2E.
 *
 * The relayer reads Circle's attestation feed for the Miden domain and submits one
 * mint note per attested deposit to the USDCx faucet. It holds no mint authority:
 * the faucet checks Circle's signature itself. The harness runs its own relayer so
 * the mint leg does not depend on a hosted one.
 *
 * Install the binary with `scripts/install-usdcx-relayer.sh`, or set
 * `USDCX_RELAYER_BIN` to a downloaded one.
 */

const DEFAULT_CIRCLE_URL = 'https://xreserve-api-testnet.circle.com';
const DEFAULT_MIDEN_RPC_URL = 'https://rpc.testnet.miden.io';
// Circle's remote-domain id for Miden: USDCX_MIDEN_REMOTE_DOMAIN in src/lib/usdcx/constant.ts.
const DEFAULT_REMOTE_DOMAIN = '10007';
const LOG_TAIL_CHARS = 4000;

export interface UsdcxRelayerConfig {
  binary: string;
  circleUrl: string;
  midenRpcUrl: string;
  remoteDomain: string;
  /** The USDCx faucet, as bech32 or 0x hex. */
  faucetAccountId: string;
  /** The funded account that creates the mint notes. Its key must be in `<dataDir>/keystore`. */
  relayerAccountId: string;
  /** The compressed SEC1 public key Circle signs deposit attestations with. */
  attesterPublicKey: string;
  /** Holds the relayer's Miden store and its `keystore/` directory. */
  dataDir: string;
}

export type UsdcxRelayerEnv = { config: UsdcxRelayerConfig; missing: [] } | { config: null; missing: string[] };

const trimmed = (value: string | undefined): string => (value ?? '').trim();

function resolveBinary(env: Record<string, string | undefined>): string {
  const override = trimmed(env.USDCX_RELAYER_BIN);
  if (override) return override;
  return join(trimmed(env.CARGO_HOME) || join(homedir(), '.cargo'), 'bin', 'xreserve-deposit-relayer');
}

/**
 * Read the relayer settings from the environment. `missing` names every required
 * variable that is unset, so a spec can skip with a message that says what to set.
 */
export function readUsdcxRelayerEnv(env: Record<string, string | undefined> = process.env): UsdcxRelayerEnv {
  const required = {
    USDCX_FAUCET_ACCOUNT_ID: trimmed(env.USDCX_FAUCET_ACCOUNT_ID),
    USDCX_RELAYER_ACCOUNT_ID: trimmed(env.USDCX_RELAYER_ACCOUNT_ID),
    USDCX_CIRCLE_ATTESTER_PUBLIC_KEY: trimmed(env.USDCX_CIRCLE_ATTESTER_PUBLIC_KEY),
    USDCX_RELAYER_DATA_DIR: trimmed(env.USDCX_RELAYER_DATA_DIR)
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      binary: resolveBinary(env),
      circleUrl: trimmed(env.USDCX_CIRCLE_URL) || DEFAULT_CIRCLE_URL,
      midenRpcUrl: trimmed(env.USDCX_MIDEN_RPC_URL) || DEFAULT_MIDEN_RPC_URL,
      remoteDomain: trimmed(env.USDCX_REMOTE_DOMAIN) || DEFAULT_REMOTE_DOMAIN,
      faucetAccountId: required.USDCX_FAUCET_ACCOUNT_ID,
      relayerAccountId: required.USDCX_RELAYER_ACCOUNT_ID,
      attesterPublicKey: required.USDCX_CIRCLE_ATTESTER_PUBLIC_KEY,
      dataDir: required.USDCX_RELAYER_DATA_DIR
    },
    missing: []
  };
}

/** The command-line arguments of one relayer run. Pure, so the mapping can be tested without a process. */
export function usdcxRelayerArgs(config: UsdcxRelayerConfig): string[] {
  return [
    '--circle-url',
    config.circleUrl,
    '--page-size',
    '100',
    '--request-timeout',
    '30s',
    '--poll-interval',
    '5s',
    '--remote-domain',
    config.remoteDomain,
    '--miden-node-url',
    config.midenRpcUrl,
    '--miden-data-dir',
    config.dataDir,
    '--expiration-delta',
    '64',
    '--faucet-account-id',
    config.faucetAccountId,
    '--relayer-account-id',
    config.relayerAccountId,
    '--attester-public-key',
    config.attesterPublicKey,
    '--state-file',
    join(config.dataDir, 'progress.json')
  ];
}

export class UsdcxRelayer {
  private proc: ChildProcess | null = null;
  private output = '';

  constructor(private readonly config: UsdcxRelayerConfig) {}

  /** Everything the relayer wrote so far. Attach it to the report when a run fails. */
  get logs(): string {
    return this.output;
  }

  /**
   * Start the relayer and wait `settleMs` for its startup checks. The relayer has no
   * health endpoint; its startup checks (node access, the relayer account, the
   * faucet's attester key, the progress file) end the process when one fails, so a
   * process that is still alive after the wait passed the fast ones. Call
   * `assertRunning` during the test to catch a later exit.
   */
  async start(settleMs = 20_000): Promise<void> {
    if (this.proc) return;
    if (!existsSync(this.config.binary)) {
      throw new Error(
        `xreserve-deposit-relayer is not installed at ${this.config.binary}. ` +
          'Run scripts/install-usdcx-relayer.sh or set USDCX_RELAYER_BIN.'
      );
    }
    if (!existsSync(join(this.config.dataDir, 'keystore'))) {
      throw new Error(`The relayer keystore is missing: ${join(this.config.dataDir, 'keystore')}`);
    }
    const proc = spawn(this.config.binary, usdcxRelayerArgs(this.config), {
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'info' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const collect = (chunk: unknown) => {
      this.output += String(chunk);
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);
    proc.on('error', err => {
      this.output += `\n[usdcx-relayer] spawn failed: ${err.message}\n`;
    });
    this.proc = proc;
    await new Promise(resolve => setTimeout(resolve, settleMs));
    this.assertRunning();
  }

  /** Throw, with the end of the log, when the relayer process is not running. */
  assertRunning(): void {
    const proc = this.proc;
    if (!proc) throw new Error('The USDCx relayer was not started.');
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `The USDCx relayer stopped (exit ${proc.exitCode}, signal ${proc.signalCode}). ` +
          `Last output:\n${this.output.slice(-LOG_TAIL_CHARS)}`
      );
    }
  }

  /** SIGTERM lets the relayer finish its page; SIGKILL follows if it does not stop in time. */
  async stop(graceMs = 30_000): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), graceMs);
    await exited;
    clearTimeout(timer);
  }
}
