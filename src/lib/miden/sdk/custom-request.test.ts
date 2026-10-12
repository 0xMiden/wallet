import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { prepareCustomRequestBytes } from './custom-request';
import type { WasmLockHold } from './miden-client';

const client: MidenClient = Object.create(null);
const hold: WasmLockHold = Object.create(null);
const originalBytes = new Uint8Array([1, 2, 3]);
const preparedBytes = new Uint8Array([4, 5, 6]);
const request = { authArg: jest.fn((): object | undefined => undefined) };
const prepared = { serialize: jest.fn(() => preparedBytes) };
const builder = {};
let current = true;
const deserialize = jest.fn((..._args: unknown[]) => request);
const feeAwareRequestBuilder = jest.fn(async (..._args: unknown[]) => builder);
const accountRefToSdk = jest.fn((account: string) => ({ toString: () => account.toLowerCase() }));
const enrichOwnOutputRequest = jest.fn((..._args: unknown[]): object => prepared);

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: (...args: unknown[]) => deserialize(...args) }
}));
jest.mock('./helpers', () => ({
  accountRefToSdk: (account: string) => accountRefToSdk(account),
  feeAwareRequestBuilder: (...args: unknown[]) => feeAwareRequestBuilder(...args),
  randomFeeSalt: () => ({ salt: true })
}));
jest.mock('./own-output-request', () => ({
  enrichOwnOutputRequest: (...args: unknown[]) => enrichOwnOutputRequest(...args)
}));
jest.mock('./miden-client', () => ({
  assertWasmHoldCurrent: () => {
    if (!current) throw new Error('operation abandoned');
  }
}));

beforeEach(() => {
  jest.clearAllMocks();
  current = true;
  request.authArg.mockReturnValue(undefined);
  feeAwareRequestBuilder.mockImplementation(async () => builder);
  enrichOwnOutputRequest.mockReturnValue(prepared);
});

it('returns the enriched bytes resolved for the executing wallet account', async () => {
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(preparedBytes);
  expect(feeAwareRequestBuilder).toHaveBeenCalledWith(client, '0xsender', { salt: true });
  expect(enrichOwnOutputRequest).toHaveBeenCalledWith(request, builder, originalBytes);
});

it('canonicalizes uppercase hex account references before resolving SDK authentication', async () => {
  await prepareCustomRequestBytes(client, '0XSENDER', originalBytes, hold);
  expect(accountRefToSdk).toHaveBeenCalledWith('0XSENDER');
  expect(feeAwareRequestBuilder).toHaveBeenCalledWith(client, '0xsender', { salt: true });
});

it('keeps already authenticated bytes without resolving a new salt', async () => {
  request.authArg.mockReturnValue({ auth: true });
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(originalBytes);
  expect(feeAwareRequestBuilder).not.toHaveBeenCalled();
});

it('returns original bytes when the executing account needs no enrichment', async () => {
  enrichOwnOutputRequest.mockReturnValue(request);
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(originalBytes);
});

it('stops before deserialization when its lock hold is already evicted', async () => {
  current = false;
  await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toThrow(
    'operation abandoned'
  );
  expect(deserialize).not.toHaveBeenCalled();
});

it('stops before rebuilding when the fee-aware builder evicts its hold', async () => {
  feeAwareRequestBuilder.mockImplementationOnce(async () => {
    current = false;
    return builder;
  });
  await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toThrow(
    'operation abandoned'
  );
  expect(enrichOwnOutputRequest).not.toHaveBeenCalled();
  expect(prepared.serialize).not.toHaveBeenCalled();
});

it('propagates unsupported request refusal before returning any replacement bytes', async () => {
  enrichOwnOutputRequest.mockImplementationOnce(() => {
    throw new Error('only own output notes');
  });
  await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toThrow(
    'only own output notes'
  );
  expect(prepared.serialize).not.toHaveBeenCalled();
});
