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

import { MidenCli, transactionStatusIn } from './miden-cli';
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

/** A `miden-client tx` table as the CLI prints it (comfy-table UTF8_FULL), one row per transaction. */
function txTable(rows: [id: string, status: string][]): string {
  const header = '│ ID ┆ Status ┆ Account ID ┆ Script Root ┆ Input Notes Count ┆ Output Notes Count │';
  const body = rows.map(([id, status]) => `│ ${id} ┆ ${status} ┆ 0xa5c2900b1895271109557de2d9ce04 ┆ - ┆ 0 ┆ 1 │`);
  return ['┌──┐', header, '╞══╡', ...body, '└──┘'].join('\n');
}

/**
 * Records every CLI command; each `mint` answers with the next scripted result, and `tx` lists every
 * minted transaction under the status `statusOf` gives it (committed unless told otherwise).
 */
function scriptedCli(
  workDir: string,
  mintResults: Partial<CLIInvocation>[],
  statusOf: (txId: string) => string = () => 'Committed (Block: 7)'
): { cli: MidenCli; commands: string[] } {
  const commands: string[] = [];
  const minted: string[] = [];
  let mints = 0;
  const runner = {
    run: async (command: string) => {
      commands.push(command);
      if (/ mint /.test(command)) {
        const result = mintResults[mints++];
        if (result?.parsed?.transactionId) minted.push(result.parsed.transactionId);
        return invocation(command, result);
      }
      if (/ tx$/.test(command)) {
        return invocation(command, { stdout: txTable(minted.map(id => [id, statusOf(id)])) });
      }
      return invocation(command);
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

    expect(commands.map(command => command.split(' ')[1])).toEqual(['sync', 'mint', 'sync', 'mint', 'sync', 'tx']);
  });

  // The node can accept a mint and then drop it: a 0.17 transaction expires 20 blocks after its
  // reference block, and on a 500 ms chain a slow proof arrives with a second to spare.
  it('mints again when the node accepted a mint and then discarded it', async () => {
    const { cli, commands } = scriptedCli(
      workDir,
      [
        { parsed: { transactionId: '0xdropped', noteId: 'lost-note' } },
        { parsed: { transactionId: '0xlanded', noteId: 'mint-note' } }
      ],
      txId => (txId === '0xdropped' ? 'Discarded (Expired)' : 'Committed (Block: 12)')
    );
    await cli.fundAccountForFees(TARGET);
    commands.length = 0;

    await expect(cli.mint(FAUCET, TARGET, 100n, 'public')).resolves.toEqual({ txId: '0xlanded', noteId: 'mint-note' });

    expect(commands.map(command => command.split(' ')[1])).toEqual([
      'sync',
      'mint',
      'sync',
      'tx',
      'sync',
      'mint',
      'sync',
      'tx'
    ]);
  });
});

describe('transactionStatusIn', () => {
  const table = txTable([
    ['0xAAA', 'Pending'],
    ['0xbbb', 'Committed (Block: 1822)'],
    ['0xccc', 'Discarded (Expired)']
  ]);

  it('reads each status from the row whose id cell is the transaction', () => {
    expect(transactionStatusIn(table, '0xaaa')).toBe('pending');
    expect(transactionStatusIn(table, '0xbbb')).toBe('committed');
    expect(transactionStatusIn(table, '0xccc')).toBe('discarded');
  });

  it('matches the whole id cell, not a prefix of another id', () => {
    expect(transactionStatusIn(table, '0xbb')).toBeUndefined();
    expect(transactionStatusIn('', '0xbbb')).toBeUndefined();
  });
});
