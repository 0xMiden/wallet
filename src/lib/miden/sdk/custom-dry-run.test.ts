import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummaryAtTip } from '@openzeppelin/miden-multisig-client';

import { dryRunPreparedCustomRequest } from './custom-dry-run';
import type { WasmLockHold } from './miden-client';
import { WasmClientPoisonedError } from './wasm-client-poison';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ TransactionRequest: { deserialize: () => ({}) } }));
jest.mock('@openzeppelin/miden-multisig-client', () => ({ executeForSummaryAtTip: jest.fn() }));
jest.mock('lib/miden/sdk/miden-client', () => ({ assertWasmHoldCurrent: () => undefined }));
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
  const trap = new WebAssembly.RuntimeError('unreachable');
  jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(trap);
  await expect(dryRun()).rejects.toBe(trap);
  expect(executeRequest).not.toHaveBeenCalled();
});

it('still executes locally for an already-authorized summary', async () => {
  jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error('TRANSACTION_ALREADY_AUTHORIZED'));
  await expect(dryRun()).resolves.toEqual({ executedBytes: 'b64:1' });
  expect(executeRequest).toHaveBeenCalledTimes(1);
});
