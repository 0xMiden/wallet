import { execFile } from 'child_process';
import * as fs from 'fs';

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
