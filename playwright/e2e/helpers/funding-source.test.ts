/**
 * Which source `MidenCli` draws the native fee asset from, per chain.
 *
 * Genesis funder wallets are `wallet_N.mac` files written by a LOCALNET genesis, and
 * they carry no network tag. So a devnet run on a machine that had previously run
 * localnet found those files, spent them as though they were devnet accounts, and
 * failed every fund with `cli::client_error -> transaction execution failed` --
 * the accounts simply do not exist on devnet. A chain that publishes its own faucet
 * is the authority on its native asset; funders are only for a chain we genesised.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MidenCli } from './miden-cli';
import { mintFromPublicFaucet } from './public-faucet';
import { getEnvironmentConfig } from '../config/environments';
import type { CLIRunner } from '../harness/cli-runner';

jest.mock('./public-faucet', () => ({
  ...jest.requireActual('./public-faucet'),
  mintFromPublicFaucet: jest.fn().mockResolvedValue(undefined)
}));

const TARGET = '0xa5c2900b1895271109557de2d9ce04';

/** Records every CLI command and answers the few the funding path actually issues. */
function fakeRunner(): { runner: CLIRunner; commands: string[] } {
  const commands: string[] = [];
  const runner = {
    run: async (command: string) => {
      commands.push(command);
      // `importFunders` parses the account id out of an import's stdout.
      const stdout = /\bimport\b/.test(command) ? 'Successfully imported account 0x3d6f968b3cd35c91' : '';
      return { command, args: [], cwd: '', exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false };
    }
  };
  return { runner: runner as unknown as CLIRunner, commands };
}

function cliFor(network: string, funderDir: string): { cli: MidenCli; commands: string[] } {
  process.env.E2E_NETWORK = network;
  process.env.MIDEN_E2E_FUNDER_DIR = funderDir;
  const { runner, commands } = fakeRunner();
  const cli = new MidenCli({
    binaryPath: 'miden-client',
    workDir: funderDir,
    env: getEnvironmentConfig(),
    cliRunner: runner
  });
  return { cli, commands };
}

describe('MidenCli fee funding source', () => {
  let funderDir: string;
  const savedNetwork = process.env.E2E_NETWORK;
  const savedFunderDir = process.env.MIDEN_E2E_FUNDER_DIR;

  beforeEach(() => {
    // Genesis funders present on disk -- the exact state a machine is left in after a
    // localnet run, and the state that produced the devnet failure.
    funderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-funders-'));
    fs.writeFileSync(path.join(funderDir, 'native_faucet.mac'), '');
    fs.writeFileSync(path.join(funderDir, 'wallet_1.mac'), '');
    fs.writeFileSync(path.join(funderDir, 'wallet_2.mac'), '');
    (mintFromPublicFaucet as jest.Mock).mockClear();
  });

  afterEach(() => {
    fs.rmSync(funderDir, { recursive: true, force: true });
    process.env.E2E_NETWORK = savedNetwork;
    process.env.MIDEN_E2E_FUNDER_DIR = savedFunderDir;
  });

  it('funds from the public faucet on devnet, ignoring stale localnet funder wallets', async () => {
    const { cli, commands } = cliFor('devnet', funderDir);

    await cli.fundAccountForFees(TARGET);

    expect(mintFromPublicFaucet).toHaveBeenCalledTimes(1);
    expect(mintFromPublicFaucet).toHaveBeenCalledWith(expect.stringContaining('devnet'), TARGET);
    // The regression: spending a localnet funder on devnet.
    expect(commands.filter(c => c.includes('transfer'))).toEqual([]);
  });

  it('still funds from genesis funders on a chain with no public faucet', async () => {
    const { cli, commands } = cliFor('localhost', funderDir);

    await cli.fundAccountForFees(TARGET);

    expect(mintFromPublicFaucet).not.toHaveBeenCalled();
    const transfers = commands.filter(c => c.includes('transfer'));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toContain(`--target ${TARGET}`);
  });
});
