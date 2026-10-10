import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { discoverFeeFaucetId } from './fee-faucet';
import { MidenCli } from './miden-cli';
import { mintFromPublicFaucet } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';
import { getEnvironmentConfig } from '../config/environments';
import type { CLIRunner } from '../harness/cli-runner';
import type { CLIInvocation } from '../harness/types';

jest.mock('./fee-faucet', () => ({ discoverFeeFaucetId: jest.fn() }));

jest.mock('./public-faucet', () => ({
  ...jest.requireActual('./public-faucet'),
  mintFromPublicFaucet: jest.fn()
}));
jest.mock('./public-note-commitment', () => ({ waitForPublicNoteCommitment: jest.fn() }));

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

  it('retries a failed query instead of caching the failure', async () => {
    const cli = makeCli('devnet');
    discover.mockRejectedValueOnce(new Error('sync failed')).mockResolvedValue(FEE_FAUCET);
    await expect(cli.ensureNativeFaucetId()).rejects.toThrow('sync failed');
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

describe('public fee funding commitment', () => {
  const mint = jest.mocked(mintFromPublicFaucet);
  const commit = jest.mocked(waitForPublicNoteCommitment);
  const noteId = '0x' + '01'.repeat(32);
  beforeEach(() => {
    mint.mockReset().mockResolvedValue({ txId: 'tx', noteId });
    commit.mockReset();
  });
  function publicCli() {
    const cli = new MidenCli({
      binaryPath: 'miden-client',
      workDir: '',
      env: { ...getEnvironmentConfig(), name: 'devnet', rpcUrl: 'https://rpc.devnet.miden.io', chargesFees: true },
      cliRunner: {} as CLIRunner
    });
    jest.spyOn(cli, 'init').mockResolvedValue(undefined);
    jest.spyOn(cli, 'sync').mockResolvedValue(undefined);
    return cli;
  }
  it('waits for the sole grant receipt before syncing or marking the account funded', async () => {
    const cli = publicCli();
    let publish!: () => void;
    commit.mockReturnValue(
      new Promise<void>(resolve => {
        publish = resolve;
      })
    );
    const funding = cli.fundAccountForFees(FEE_FAUCET);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(commit).toHaveBeenCalledWith('https://rpc.devnet.miden.io', noteId);
    expect(cli.sync).not.toHaveBeenCalled();
    publish();
    await funding;
    await cli.fundAccountForFees(FEE_FAUCET);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(cli.sync).toHaveBeenCalledTimes(1);
  });

  it('requests and commits enough advertised grants when a long run needs a fee reserve', async () => {
    const cli = publicCli();
    await cli.fundAccountForFees(FEE_FAUCET, 3);
    await cli.fundAccountForFees(FEE_FAUCET, 3);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenCalledTimes(3);
    expect(cli.sync).toHaveBeenCalledTimes(1);
  });
  it('propagates a commitment timeout without requesting another grant', async () => {
    const cli = publicCli();
    commit.mockRejectedValue(new Error('note commitment timed out'));
    await expect(cli.fundAccountForFees(FEE_FAUCET)).rejects.toThrow('commitment timed out');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(cli.sync).not.toHaveBeenCalled();
  });

  it('does not request another fee grant batch after the last discarded deploy attempt', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-faucet-retry-'));
    const runner = {
      run: async (command: string): Promise<CLIInvocation> => ({
        command,
        args: command.split(' '),
        cwd: workDir,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        parsed: command.includes('new-account')
          ? { accountId: FEE_FAUCET }
          : command.includes('consume-notes')
            ? { transactionId: 'discarded-transaction' }
            : undefined
      })
    };
    const cli = new MidenCli({
      binaryPath: 'miden-client',
      workDir,
      env: { ...getEnvironmentConfig(), name: 'devnet', rpcUrl: 'https://rpc.devnet.miden.io', chargesFees: true },
      cliRunner: runner as unknown as CLIRunner
    });
    const privateMethods = cli as unknown as {
      sendNativeFundingNote(target: string): Promise<string>;
      awaitCommit(txId: string): Promise<'committed' | 'discarded'>;
    };
    const sendNativeFundingNote = jest
      .spyOn(privateMethods, 'sendNativeFundingNote')
      .mockResolvedValue('public faucet');
    jest.spyOn(privateMethods, 'awaitCommit').mockResolvedValue('discarded');
    jest.spyOn(cli, 'sync').mockResolvedValue(undefined);

    try {
      await expect(cli.createFaucet('TST', 8, 1_000_000_000_000_000n, 1)).rejects.toThrow('after 10 attempts');
      expect(sendNativeFundingNote).toHaveBeenCalledTimes(10);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
