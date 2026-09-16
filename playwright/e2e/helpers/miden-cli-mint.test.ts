/**
 * `MidenCli.mint` syncs before every attempt.
 *
 * The CLI executes a mint at its store's sync height, and the transaction loads the native fee faucet as a
 * foreign account at that block. A miden-node 0.16 store could not rebuild that account's vault twenty to thirty
 * blocks behind the tip, so a mint issued about a minute after the last sync failed with `failed to reconstruct
 * vault ... root not found`, and every retry at the same height failed the same way.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MidenCli } from './miden-cli';
import { getEnvironmentConfig } from '../config/environments';
import type { CLIRunner } from '../harness/cli-runner';
import type { CLIInvocation } from '../harness/types';

jest.mock('./public-faucet', () => ({
  ...jest.requireActual('./public-faucet'),
  mintFromPublicFaucet: jest.fn().mockResolvedValue(undefined)
}));

const TARGET = '0xa5c2900b1895271109557de2d9ce04';
const FAUCET = '0x3d6f968b3cd35c91';
const NODE_VAULT_ERROR =
  'cli::client_error\n  × client error\n  ├─▶ transaction execution failed\n' +
  '  |-> grpc request failed for get_account: Miden node returned an internal error\n' +
  '  `-> data corrupted: failed to reconstruct vault for account 0x18101fa522c174b165efd4f70a0385 at block ' +
  '186358: root not found';

function invocation(command: string, result: Partial<CLIInvocation> = {}): CLIInvocation {
  return {
    command,
    args: [],
    cwd: '',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    ...result
  };
}

/** Records every CLI command; each `mint` answers with the next scripted result. */
function scriptedCli(workDir: string, mintResults: Partial<CLIInvocation>[]): { cli: MidenCli; commands: string[] } {
  const commands: string[] = [];
  let mints = 0;
  const runner = {
    run: async (command: string) => {
      commands.push(command);
      return / mint /.test(command) ? invocation(command, mintResults[mints++]) : invocation(command);
    }
  };
  const cli = new MidenCli({
    binaryPath: 'miden-client',
    workDir,
    env: getEnvironmentConfig(),
    cliRunner: runner as unknown as CLIRunner
  });
  return { cli, commands };
}

describe('MidenCli.mint', () => {
  const savedNetwork = process.env.E2E_NETWORK;
  const savedFunderDir = process.env.MIDEN_E2E_FUNDER_DIR;
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-mint-'));
    process.env.E2E_NETWORK = 'testnet';
    process.env.MIDEN_E2E_FUNDER_DIR = workDir;
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    process.env.E2E_NETWORK = savedNetwork;
    process.env.MIDEN_E2E_FUNDER_DIR = savedFunderDir;
  });

  it('syncs immediately before every attempt, so a retry never reuses a stale reference block', async () => {
    const { cli, commands } = scriptedCli(workDir, [
      { exitCode: 1, stderr: NODE_VAULT_ERROR },
      { parsed: { transactionId: 'mint-tx', noteId: 'mint-note' } }
    ]);
    // Funding the target syncs as well; do it first so only the mint's own commands are left to check.
    await cli.fundAccountForFees(TARGET);
    commands.length = 0;

    await expect(cli.mint(FAUCET, TARGET, 100n, 'public')).resolves.toEqual({ txId: 'mint-tx', noteId: 'mint-note' });

    expect(commands.map(command => command.split(' ')[1])).toEqual(['sync', 'mint', 'sync', 'mint']);
  });
});
