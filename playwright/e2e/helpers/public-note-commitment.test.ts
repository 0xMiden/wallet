/** @jest-environment node */
import { execFile } from 'child_process';

import { isInfrastructureFailure } from './dapp-cells';
import { PublicFaucetError } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const NOTE_ID = '0x' + '01'.repeat(32);
const OTHER_ID = '0x' + '02'.repeat(32);
const execute = jest.mocked(execFile);

function sdkResponds(responses: { id: string; public: boolean }[][]) {
  let calls = 0;
  execute.mockImplementation(((_file: string, args: string[], _options: unknown, callback: Function) => {
    const query = args[2]!.replace(/^import .*;$/m, '');
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    class Rpc {
      async getNotesById() {
        return (responses[Math.min(calls++, responses.length - 1)] ?? []).map(note => ({
          noteId: { toString: () => note.id },
          asInputNote: () => (note.public ? {} : undefined)
        }));
      }
    }
    const output: string[] = [];
    new AsyncFunction('RpcClient', 'Endpoint', 'NoteId', 'process', 'console', query)(
      Rpc,
      class {},
      { fromHex: (id: string) => ({ toString: () => id }) },
      { argv: [undefined, ...args.slice(3)] },
      { log: (value: string) => output.push(value) }
    ).then(
      () => callback(null, output.join('\n')),
      (error: Error) => callback(error, '')
    );
  }) as typeof execFile);
  return () => calls;
}

describe('waitForPublicNoteCommitment', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    execute.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('waits beyond the old funding poll budget for the specific public note', async () => {
    const calls = sdkResponds([...Array.from({ length: 45 }, () => []), [{ id: NOTE_ID, public: true }]]);
    const waiting = waitForPublicNoteCommitment('https://rpc.devnet.miden.io', NOTE_ID);
    await jest.runAllTimersAsync();
    await waiting;
    expect(calls()).toBe(46);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not accept an unrelated committed note or a matching private note', async () => {
    const calls = sdkResponds([
      [{ id: OTHER_ID, public: true }],
      [{ id: NOTE_ID, public: false }],
      [{ id: NOTE_ID, public: true }]
    ]);
    const waiting = waitForPublicNoteCommitment('https://rpc.devnet.miden.io', NOTE_ID);
    await jest.runAllTimersAsync();
    await waiting;
    expect(calls()).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails within the bound when the queued note never commits', async () => {
    const calls = sdkResponds([[]]);
    const waiting = waitForPublicNoteCommitment('https://rpc.devnet.miden.io', NOTE_ID, 5_000);
    const outcome = waiting.catch(error => error);
    await jest.runAllTimersAsync();
    const error = await outcome;
    expect(error).toEqual(new Error('Public faucet note did not commit within 5000ms'));
    expect(error).toBeInstanceOf(PublicFaucetError);
    expect(calls()).toBe(4);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('names the public faucet when the query process itself fails', async () => {
    const cause = new Error('spawn node ENOENT');
    execute.mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Function) =>
      callback(cause, '')) as typeof execFile);
    const error = await waitForPublicNoteCommitment('https://rpc.devnet.miden.io', NOTE_ID).catch(failure => failure);
    expect(error).toBeInstanceOf(PublicFaucetError);
    expect(error).toMatchObject({
      message: `Public faucet note ${NOTE_ID} commitment query failed: Error: spawn node ENOENT`,
      cause
    });
    expect(isInfrastructureFailure(error)).toBe(true);
  });

  it('rejects a missing or malformed receipt before starting the RPC query', async () => {
    await expect(waitForPublicNoteCommitment('https://rpc.devnet.miden.io', '')).rejects.toThrow('invalid note ID');
    expect(execute).not.toHaveBeenCalled();
  });
});
