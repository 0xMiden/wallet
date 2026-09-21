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
function fakeRunner(workDir: string, parseTransfer = true): { runner: CLIRunner; commands: string[] } {
  const commands: string[] = [];
  const runner = {
    run: async (command: string) => {
      commands.push(command);
      if (/\binit\b/.test(command)) {
        const dir = path.join(workDir, '.miden');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'miden-client.toml'), 'rpc = {}\n');
      }
      // `importFunders` parses the account id out of an import's stdout.
      const stdout = /\bimport\b/.test(command) ? 'Successfully imported account 0x3d6f968b3cd35c91' : '';
      return {
        command,
        args: [],
        cwd: '',
        exitCode: 0,
        stdout,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        parsed: parseTransfer ? { transactionId: 'native-transfer-tx', noteId: 'native-transfer-note' } : undefined
      };
    }
  };
  return { runner: runner as unknown as CLIRunner, commands };
}

function cliFor(network: string, funderDir: string, parseTransfer = true): { cli: MidenCli; commands: string[] } {
  process.env.E2E_NETWORK = network;
  process.env.MIDEN_E2E_FUNDER_DIR = funderDir;
  const { runner, commands } = fakeRunner(funderDir, parseTransfer);
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
    expect(commands.some(c => /\binit\b/.test(c))).toBe(true);
    expect(fs.readFileSync(path.join(funderDir, '.miden', 'miden-client.toml'), 'utf8')).toContain(
      'fee_faucet_id = "0x3d6f968b3cd35c91"'
    );
  });

  it('returns the exact native transfer receipt and requested amount from a local genesis funder', async () => {
    const { cli, commands } = cliFor('localhost', funderDir);
    await expect(cli.transferNativeFromFunder(TARGET, 10_000_000n)).resolves.toEqual({
      source: 'genesis funder 0x3d6f968b3cd35c91',
      faucetId: '0x3d6f968b3cd35c91',
      txId: 'native-transfer-tx',
      noteId: 'native-transfer-note'
    });
    const transfers = commands.filter(command => command.includes('transfer'));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toContain('--asset 10000000::0x3d6f968b3cd35c91');
    expect(transfers[0]).toContain(`--target ${TARGET}`);
  });

  it('refuses to claim a native note was sent when the CLI output has no receipt', async () => {
    const { cli } = cliFor('localhost', funderDir, false);
    await expect(cli.transferNativeFromFunder(TARGET, 10_000_000n)).rejects.toThrow(
      'Could not parse native transfer receipt'
    );
  });

  it('does not spend stale local funders on a public chain', async () => {
    const { cli, commands } = cliFor('devnet', funderDir);
    await expect(cli.transferNativeFromFunder(TARGET, 10_000_000n)).rejects.toThrow('local test chain');
    expect(commands).toEqual([]);
  });

  it('rejects a nonpositive transfer amount before any CLI command', async () => {
    const { cli, commands } = cliFor('localhost', funderDir);
    await expect(cli.transferNativeFromFunder(TARGET, 0n)).rejects.toThrow('positive');
    expect(commands).toEqual([]);
  });
});
