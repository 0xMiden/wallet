import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { discoverFeeFaucetId } from './fee-faucet';
import { MidenCli } from './miden-cli';
import { getEnvironmentConfig } from '../config/environments';
import type { CLIRunner } from '../harness/cli-runner';

jest.mock('./fee-faucet', () => ({ discoverFeeFaucetId: jest.fn() }));

const discover = jest.mocked(discoverFeeFaucetId);
const FEE_FAUCET = '0x01ee11ac5c6cd8f11cedbc5c448551';

function makeCli(network: 'devnet' | 'localhost'): MidenCli {
  const env = { ...getEnvironmentConfig(), name: network, rpcUrl: 'https://rpc.devnet.miden.io' };
  const cli = new MidenCli({ binaryPath: 'miden-client', workDir: '', env, cliRunner: {} as CLIRunner });
  jest.spyOn(cli, 'init').mockResolvedValue(undefined);
  return cli;
}

describe('MidenCli.ensureNativeFaucetId', () => {
  beforeEach(() => discover.mockReset());

  it('discovers public chain configuration once and caches its identity', async () => {
    const cli = makeCli('devnet');
    discover.mockResolvedValue(FEE_FAUCET);
    await expect(cli.ensureNativeFaucetId()).resolves.toBe(FEE_FAUCET);
    await expect(cli.ensureNativeFaucetId()).resolves.toBe(FEE_FAUCET);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith('https://rpc.devnet.miden.io');
  });

  it('shares concurrent discovery and retries a failed query', async () => {
    const cli = makeCli('devnet');
    discover.mockRejectedValueOnce(new Error('sync failed')).mockResolvedValue(FEE_FAUCET);
    const first = cli.ensureNativeFaucetId();
    const second = cli.ensureNativeFaucetId();
    await expect(first).rejects.toThrow('sync failed');
    await expect(second).rejects.toThrow('sync failed');
    expect(discover).toHaveBeenCalledTimes(1);
    await expect(cli.ensureNativeFaucetId()).resolves.toBe(FEE_FAUCET);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('leaves local genesis discovery to the existing funder import', async () => {
    await expect(makeCli('localhost').ensureNativeFaucetId()).resolves.toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });

  it('ignores local genesis files when discovering a public network', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-public-fee-'));
    const priorFunderDir = process.env.MIDEN_E2E_FUNDER_DIR;
    process.env.MIDEN_E2E_FUNDER_DIR = workDir;
    fs.writeFileSync(path.join(workDir, 'wallet_0.mac'), '');
    fs.writeFileSync(path.join(workDir, 'native_faucet.mac'), '');
    const commands: string[] = [];
    const runner = {
      run: async (command: string) => {
        commands.push(command);
        return {
          command,
          args: [],
          cwd: workDir,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false
        };
      }
    };
    try {
      const cli = new MidenCli({
        binaryPath: 'miden-client',
        workDir,
        env: { ...getEnvironmentConfig(), name: 'devnet', rpcUrl: 'https://rpc.devnet.miden.io' },
        cliRunner: runner as unknown as CLIRunner
      });
      discover.mockResolvedValue(FEE_FAUCET);
      await expect(cli.ensureNativeFaucetId()).resolves.toBe(FEE_FAUCET);
      expect(commands.some(command => command.includes(' import '))).toBe(false);
      expect(discover).toHaveBeenCalledWith('https://rpc.devnet.miden.io');
    } finally {
      if (priorFunderDir === undefined) delete process.env.MIDEN_E2E_FUNDER_DIR;
      else process.env.MIDEN_E2E_FUNDER_DIR = priorFunderDir;
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
