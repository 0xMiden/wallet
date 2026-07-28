import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local Anvil (Foundry) EVM node for the bridge-IN deposit harness.
 *
 * Both the wallet's EVM reads (balances, receipts — via the E2E_EVM_RPC_URL
 * override baked into config.ts) and the headless WC counterparty's broadcasts
 * point at this node, so the deposit's sign → broadcast → receipt loop is real
 * against a hermetic chain instead of public Sepolia.
 *
 * The iOS Simulator shares the host network stack, so `127.0.0.1:<port>` is
 * reachable from both the Node test process and the app's WebView.
 */

function resolveAnvilBinary(): string {
  if (process.env.ANVIL_PATH && existsSync(process.env.ANVIL_PATH)) return process.env.ANVIL_PATH;
  const foundry = join(homedir(), '.foundry', 'bin', 'anvil');
  if (existsSync(foundry)) return foundry;
  // Fall back to PATH resolution (CI installs foundry onto PATH).
  return 'anvil';
}

export interface AnvilOptions {
  port?: number;
  chainId?: number;
  /** Extra CLI args (e.g. --block-time). */
  args?: string[];
}

export class AnvilInstance {
  readonly rpcUrl: string;
  private constructor(
    private readonly proc: ChildProcess,
    readonly port: number
  ) {
    this.rpcUrl = `http://127.0.0.1:${port}`;
  }

  static async start(opts: AnvilOptions = {}): Promise<AnvilInstance> {
    const port = opts.port ?? 8545;
    const chainId = opts.chainId ?? 11155111;
    const binary = resolveAnvilBinary();
    const proc = spawn(
      binary,
      ['--chain-id', String(chainId), '--port', String(port), '--silent', ...(opts.args ?? [])],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    proc.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    proc.on('error', err => {
      throw new Error(`anvil spawn failed (${binary}): ${err.message}`);
    });

    const instance = new AnvilInstance(proc, port);
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (proc.exitCode !== null) {
        throw new Error(`anvil exited early (code ${proc.exitCode}): ${stderr.slice(0, 500)}`);
      }
      const id = await instance.chainId().catch(() => null);
      if (id === chainId) break;
      if (Date.now() > deadline) {
        instance.stop();
        throw new Error(`anvil did not become ready on :${port} within 20s. stderr: ${stderr.slice(0, 500)}`);
      }
      await new Promise(res => setTimeout(res, 250));
    }
    return instance;
  }

  private async chainId(): Promise<number> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
    });
    const payload = (await res.json()) as { result?: string };
    return payload.result ? parseInt(payload.result, 16) : NaN;
  }

  stop(): void {
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
  }
}
