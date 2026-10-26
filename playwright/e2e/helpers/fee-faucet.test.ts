import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { discoverFeeFaucetId } from './fee-faucet';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const run = jest.mocked(execFile);
const FEE_FAUCET = '0x01ee11ac5c6cd8f11cedbc5c448551';

describe('discoverFeeFaucetId', () => {
  beforeEach(() => run.mockReset());

  it('queries the selected node in an isolated process and removes its temporary store', async () => {
    let storeRoot = '';
    run.mockImplementation((_file, args, options, callback) => {
      storeRoot = String(options?.env?.TMPDIR);
      expect(fs.existsSync(storeRoot)).toBe(true);
      expect(args?.at(-1)).toBe('https://rpc.devnet.miden.io');
      callback?.(null, `${FEE_FAUCET}\n`, '');
      return {} as ReturnType<typeof execFile>;
    });

    await expect(discoverFeeFaucetId('https://rpc.devnet.miden.io')).resolves.toBe(FEE_FAUCET);
    expect(fs.existsSync(storeRoot)).toBe(false);
  });

  it('propagates sync failure and cleans up the store', async () => {
    let storeRoot = '';
    run.mockImplementation((_file, _args, options, callback) => {
      storeRoot = String(options?.env?.TMPDIR);
      callback?.(new Error('node sync failed'), '', '');
      return {} as ReturnType<typeof execFile>;
    });

    await expect(discoverFeeFaucetId('https://rpc.devnet.miden.io')).rejects.toThrow('node sync failed');
    expect(fs.existsSync(storeRoot)).toBe(false);
  });

  it('rejects a query that returned no canonical account ID', async () => {
    run.mockImplementation((_file, _args, _options, callback) => {
      callback?.(null, 'not an account ID', '');
      return {} as ReturnType<typeof execFile>;
    });
    await expect(discoverFeeFaucetId('https://rpc.devnet.miden.io')).rejects.toThrow('fee faucet');
  });
});

/** Stands in for the SDK in the child process and logs each call, so the real query script can run offline. */
const STUB_SDK = `
import { appendFileSync } from 'node:fs';
const log = entry => appendFileSync(process.env.FEE_FAUCET_STUB_LOG, JSON.stringify(entry) + '\\n');
export class MidenClient {
  static async create(options) {
    log({ call: 'create', options });
    return new MidenClient();
  }
  async syncChain() {
    log({ call: 'syncChain' });
    if (process.env.FEE_FAUCET_STUB_FAIL) throw new Error('stub sync failed');
  }
  async feeFaucetId() {
    log({ call: 'feeFaucetId' });
    return { toString: () => '${FEE_FAUCET}' };
  }
  terminate() {
    log({ call: 'terminate' });
  }
}
`;

describe('the discovery query script', () => {
  let sdkRoot = '';
  let callLog = '';
  const calls = () =>
    fs
      .readFileSync(callLog, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));

  beforeEach(() => {
    run.mockImplementation(jest.requireActual<typeof import('child_process')>('child_process').execFile as never);
    sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-fee-sdk-'));
    callLog = path.join(sdkRoot, 'calls.log');
    const pkg = path.join(sdkRoot, 'node_modules', '@miden-sdk', 'miden-sdk');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@miden-sdk/miden-sdk', type: 'module', exports: './index.js' })
    );
    fs.writeFileSync(path.join(pkg, 'index.js'), STUB_SDK);
    process.env.FEE_FAUCET_STUB_LOG = callLog;
  });

  afterEach(() => {
    delete process.env.FEE_FAUCET_STUB_LOG;
    delete process.env.FEE_FAUCET_STUB_FAIL;
    fs.rmSync(sdkRoot, { recursive: true, force: true });
  });

  it('creates an unsynced client for the node, syncs before reading the fee faucet, and terminates it', async () => {
    await expect(discoverFeeFaucetId('http://127.0.0.1:9', sdkRoot)).resolves.toBe(FEE_FAUCET);
    expect(calls()).toEqual([
      { call: 'create', options: { rpcUrl: 'http://127.0.0.1:9', autoSync: false } },
      { call: 'syncChain' },
      { call: 'feeFaucetId' },
      { call: 'terminate' }
    ]);
  });

  it('terminates the client and rejects when the sync fails', async () => {
    process.env.FEE_FAUCET_STUB_FAIL = '1';
    await expect(discoverFeeFaucetId('http://127.0.0.1:9', sdkRoot)).rejects.toThrow('stub sync failed');
    expect(calls().map(entry => entry.call)).toEqual(['create', 'syncChain', 'terminate']);
  });
});
