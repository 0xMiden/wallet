import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { prepareCustomRequestBytes } from './custom-request';
import type { WasmLockHold } from './miden-client';

const rootWord = { free: jest.fn() };
const hasProcedure = jest.fn(() => true);
const getAccount = jest.fn(async (): Promise<object | null> => ({ code: () => ({ hasProcedure }) }));
const withFeeAwareAuth = jest.fn(async (..._args: unknown[]): Promise<object> => prepared);
const client = { accounts: { get: getAccount }, withFeeAwareAuth } as unknown as MidenClient;
const hold: WasmLockHold = Object.create(null);
const originalBytes = new Uint8Array([1, 2, 3]);
const preparedBytes = new Uint8Array([4, 5, 6]);
const request = { authArg: jest.fn((): object | undefined => undefined) };
const prepared = {
  authArg: jest.fn((): object | undefined => ({ auth: true })),
  serialize: jest.fn(() => preparedBytes)
};
const salt = { salt: true };
let current = true;
const deserialize = jest.fn((..._args: unknown[]) => request);
const accountRefToSdk = jest.fn((account: string) => ({ toString: () => account.toLowerCase() }));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: (...args: unknown[]) => deserialize(...args) },
  Word: { fromHex: () => rootWord }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({ getProcedureRoot: () => 'public-pinned-root' }));
jest.mock('./helpers', () => ({
  accountRefToSdk: (account: string) => accountRefToSdk(account),
  randomFeeSalt: () => salt
}));
jest.mock('./miden-client', () => ({
  assertWasmHoldCurrent: () => {
    if (!current) throw new Error('operation abandoned');
  }
}));

beforeEach(() => {
  jest.clearAllMocks();
  current = true;
  hasProcedure.mockReturnValue(true);
  getAccount.mockResolvedValue({ code: () => ({ hasProcedure }) });
  request.authArg.mockReturnValue(undefined);
  prepared.authArg.mockReturnValue({ auth: true });
  withFeeAwareAuth.mockImplementation(async () => prepared);
});

it('returns the bytes with the auth that the SDK adds for the executing wallet account', async () => {
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(preparedBytes);
  expect(deserialize).toHaveBeenCalledWith(originalBytes);
  expect(withFeeAwareAuth).toHaveBeenCalledTimes(1);
  expect(withFeeAwareAuth).toHaveBeenCalledWith(request, '0xsender', { feeConversionSalt: salt });
});

it('canonicalizes uppercase hex account references before resolving SDK authentication', async () => {
  await prepareCustomRequestBytes(client, '0XSENDER', originalBytes, hold);
  expect(accountRefToSdk).toHaveBeenCalledWith('0XSENDER');
  expect(withFeeAwareAuth).toHaveBeenCalledWith(request, '0xsender', { feeConversionSalt: salt });
});

it('keeps already authenticated bytes without resolving a new salt', async () => {
  request.authArg.mockReturnValue({ auth: true });
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(originalBytes);
  expect(withFeeAwareAuth).not.toHaveBeenCalled();
});

it('returns original bytes when the executing account needs no enrichment', async () => {
  withFeeAwareAuth.mockImplementationOnce(async () => request);
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(originalBytes);
  expect(prepared.serialize).not.toHaveBeenCalled();
});

it('adds auth to a request that consumes input notes instead of refusing it', async () => {
  const consuming = {
    authArg: jest.fn((): object | undefined => undefined),
    inputNotes: jest.fn(() => ['input note'])
  };
  deserialize.mockImplementationOnce(() => consuming);
  expect(await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).toBe(preparedBytes);
  expect(withFeeAwareAuth).toHaveBeenCalledWith(consuming, '0xsender', { feeConversionSalt: salt });
});

it('stops before deserialization when its lock hold is already evicted', async () => {
  current = false;
  await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toThrow(
    'operation abandoned'
  );
  expect(deserialize).not.toHaveBeenCalled();
});

it('stops before serializing when the fee-aware auth evicts its hold', async () => {
  withFeeAwareAuth.mockImplementationOnce(async () => {
    current = false;
    return prepared;
  });
  await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toThrow(
    'operation abandoned'
  );
  expect(prepared.authArg).not.toHaveBeenCalled();
  expect(prepared.serialize).not.toHaveBeenCalled();
});

it.each(['AUTH_ALREADY_SET', 'CONFLICTING_ADVICE_MAP_ENTRY'])(
  'propagates the SDK refusal %s before returning any replacement bytes',
  async code => {
    withFeeAwareAuth.mockImplementationOnce(async () => {
      throw Object.assign(new Error(`${code}: refused`), { code });
    });
    await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toMatchObject({ code });
    expect(prepared.serialize).not.toHaveBeenCalled();
  }
);

it('propagates a WASM trap from the fee-aware auth', async () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  withFeeAwareAuth.mockImplementationOnce(async () => {
    throw trap;
  });
  await expect(prepareCustomRequestBytes(client, '0xsender', originalBytes, hold)).rejects.toBe(trap);
});

it('records supplied authentication without rebuilding the dApp request', async () => {
  request.authArg.mockReturnValue({ auth: true });
  const observations: unknown[] = [];
  await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, (value: unknown) => {
    observations.push(value);
  });
  expect(observations).toEqual([
    {
      authPreparation: 'provided',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'current_guardian'
    }
  ]);
});

it('records the original authentication state when preparation fails', async () => {
  withFeeAwareAuth.mockImplementationOnce(async () => {
    throw new Error('unsupported request');
  });
  const observations: unknown[] = [];
  await expect(
    prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, (value: unknown) => {
      observations.push(value);
    })
  ).rejects.toThrow('unsupported request');
  expect(observations).toEqual([
    {
      authPreparation: 'unchanged',
      authLayout: 'absent',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'current_guardian'
    },
    {
      authPreparation: 'failed',
      authLayout: 'absent',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'current_guardian'
    }
  ]);
});

it('does not let a diagnostics observer abort request preparation', async () => {
  await expect(
    prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, () => {
      throw new Error('diagnostics failed');
    })
  ).resolves.toBe(preparedBytes);
});

it('records wallet enrichment only after replacement bytes serialize', async () => {
  const observations: unknown[] = [];
  await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, value => observations.push(value));
  expect(observations).toEqual([
    {
      authPreparation: 'unchanged',
      authLayout: 'absent',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'current_guardian'
    },
    {
      authPreparation: 'wallet_enriched',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'current_guardian'
    }
  ]);
});

it('records a failed preparation even when deserialization fails', async () => {
  deserialize.mockImplementationOnce(() => {
    throw new Error('invalid bytes');
  });
  const observations: unknown[] = [];
  await expect(
    prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, value => observations.push(value))
  ).rejects.toThrow('invalid bytes');
  expect(observations).toEqual([
    {
      authPreparation: 'failed',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'unavailable'
    }
  ]);
});

it.each([
  [true, 'current_guardian'],
  [false, 'unrecognized']
])('records locally recognized account code when the current auth root is present: %s', async (matches, code) => {
  hasProcedure.mockReturnValue(matches);
  request.authArg.mockReturnValue({ auth: true });
  const observations: unknown[] = [];
  const result = await prepareCustomRequestBytes(client, '0XSENDER', originalBytes, hold, value =>
    observations.push(value)
  );
  expect(result).toBe(originalBytes);
  expect(observations).toEqual([
    {
      authPreparation: 'provided',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: code
    }
  ]);
  expect(getAccount).toHaveBeenCalledWith('0xsender');
});

it('does not read account code for unobserved preview preparation', async () => {
  request.authArg.mockReturnValue({ auth: true });
  await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold);
  expect(getAccount).not.toHaveBeenCalled();
});

it('records unavailable account code when the local account is missing', async () => {
  getAccount.mockResolvedValueOnce(null);
  request.authArg.mockReturnValue({ auth: true });
  const observations: unknown[] = [];
  await prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, value => observations.push(value));
  expect(observations).toEqual([
    {
      authPreparation: 'provided',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'unavailable'
    }
  ]);
});

it('contains local account lookup failure without leaking the error or failing preparation', async () => {
  getAccount.mockRejectedValueOnce(new Error('sensitive account data'));
  request.authArg.mockReturnValue({ auth: true });
  const observations: unknown[] = [];
  await expect(
    prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, value => observations.push(value))
  ).resolves.toBe(originalBytes);
  expect(observations).toEqual([
    {
      authPreparation: 'provided',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'unavailable'
    }
  ]);
});

it('contains an account code accessor failure and preserves authored request bytes', async () => {
  getAccount.mockResolvedValueOnce({
    code: () => {
      throw new Error('sensitive stored account');
    }
  });
  request.authArg.mockReturnValue({ auth: true });
  const observations: unknown[] = [];
  await expect(
    prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, value => observations.push(value))
  ).resolves.toBe(originalBytes);
  expect(observations).toEqual([
    {
      authPreparation: 'provided',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'unavailable'
    }
  ]);
});

it('checks its lock after the diagnostic account read before returning authored bytes', async () => {
  getAccount.mockImplementationOnce(async () => {
    current = false;
    return { code: () => ({ hasProcedure }) };
  });
  request.authArg.mockReturnValue({ auth: true });
  const observations: unknown[] = [];
  await expect(
    prepareCustomRequestBytes(client, '0xsender', originalBytes, hold, value => observations.push(value))
  ).rejects.toThrow('operation abandoned');
  expect(observations).toEqual([
    {
      authPreparation: 'failed',
      authLayout: 'unavailable',
      commitmentMatch: 'unavailable',
      accountAuthCode: 'current_guardian'
    }
  ]);
});
