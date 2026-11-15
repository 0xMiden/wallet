import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummaryAtTip } from '@openzeppelin/miden-multisig-client';

import { prepareCustomRequestBytes } from 'lib/miden/sdk/custom-request';
import { assertWasmHoldCurrent } from 'lib/miden/sdk/miden-client';
import type { MidenClientInterface } from 'lib/miden/sdk/miden-client-interface';

import { dryRunPreparedCustomRequest } from './custom-dry-run';
import { dryRunRequest } from './dry-run-request';
import type { WasmLockHold } from './miden-client';
import { WasmClientPoisonedError } from './wasm-client-poison';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ TransactionRequest: { deserialize: () => ({}) } }));
jest.mock('@openzeppelin/miden-multisig-client', () => ({ executeForSummaryAtTip: jest.fn() }));
jest.mock('lib/miden/sdk/miden-client', () => ({ assertWasmHoldCurrent: jest.fn() }));
jest.mock('lib/miden/sdk/custom-request', () => ({ prepareCustomRequestBytes: jest.fn() }));
jest.mock('lib/shared/helpers', () => ({ u8ToB64: (bytes: Uint8Array) => `b64:${bytes.join(',')}` }));

const executeRequest = jest.fn(async (..._args: unknown[]) => ({ result: { serialize: () => new Uint8Array([1]) } }));
const client = { transactions: { executeRequest } } as unknown as MidenClient;
const hold: WasmLockHold = Object.create(null);
const dryRun = () => dryRunPreparedCustomRequest(client, '0xaccount', new Uint8Array([7]), hold);

beforeEach(() => {
  jest.clearAllMocks();
});

it('rethrows the kill a summary failure wraps, without the local fallback', async () => {
  const poison = new WasmClientPoisonedError('watchdog');
  jest
    .mocked(executeForSummaryAtTip)
    .mockRejectedValueOnce(new Error('failed to generate signature', { cause: poison }));
  await expect(dryRun()).rejects.toBe(poison);
  expect(executeRequest).not.toHaveBeenCalled();
});

it('rethrows a wrapped kill whose text names no fallback as the kill', async () => {
  const poison = new WasmClientPoisonedError('watchdog');
  jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error('dry run stopped', { cause: poison }));
  await expect(dryRun()).rejects.toBe(poison);
});

it('rethrows a trap from the summary execution as that same object, without the local fallback', async () => {
  const trap = new WebAssembly.RuntimeError('failed to generate signature');
  jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(trap);
  await expect(dryRun()).rejects.toBe(trap);
  expect(executeRequest).not.toHaveBeenCalled();
});

it('still executes locally for an already-authorized summary', async () => {
  jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error('TRANSACTION_ALREADY_AUTHORIZED'));
  await expect(dryRun()).resolves.toEqual({ executedBytes: 'b64:1' });
  expect(executeRequest).toHaveBeenCalledTimes(1);
});

it('dryRunRequest prepares the request and runs the custom dry run on the prepared bytes', async () => {
  const prepared = new Uint8Array([9]);
  jest.mocked(prepareCustomRequestBytes).mockResolvedValueOnce(prepared);
  jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error('TRANSACTION_ALREADY_AUTHORIZED'));
  const wrapped = { client } as unknown as MidenClientInterface;
  const requestBytes = new Uint8Array([7]);

  await expect(dryRunRequest(wrapped, '0xaccount', requestBytes, hold)).resolves.toEqual({ executedBytes: 'b64:1' });
  expect(prepareCustomRequestBytes).toHaveBeenCalledWith(client, '0xaccount', requestBytes, hold);
  expect(jest.mocked(assertWasmHoldCurrent).mock.calls.map(call => call[1])).toEqual([
    'before the dry run',
    'after the dry run request preparation',
    'before the local execution fallback',
    'before the result serialize'
  ]);
});
