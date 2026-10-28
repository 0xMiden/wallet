import { registerPlugin } from '@capacitor/core';

import { isAndroid, isIOS } from 'lib/platform';
import { bridgeReceiveIdentity, bridgeReceiveLibraryError } from 'lib/telemetry/bridge-receive-failure';

import { type NativeFeeFields, readNativeFeeFields } from './fees';
import {
  assertNativeSessionChain,
  buildNativeReownProvider,
  ensureNativeSessionChain,
  NativeReown,
  NativeSessionChainNotApprovedError,
  prepareNativeSessionChain,
  type ReownPlugin,
  ReownState
} from './native';
import { readReownNativeFailure, type ReownNativeFailure } from './native-request-failure';
import { NO_EXPLORER_CHAIN, NO_PUBLIC_RPC_CHAIN } from './testing/chains';

const mockStateListeners: Array<(state: ReownState) => void> = [];
const mockRemoveListener = jest.fn(async () => undefined);

// The plugin object is built inside the factory: `registerPlugin` runs when `./native` loads,
// before any constant in this file is initialized.
jest.mock('@capacitor/core', () => ({
  registerPlugin: jest.fn(
    () =>
      new Proxy(
        {
          configure: jest.fn(),
          present: jest.fn(),
          connectUri: jest.fn(),
          getState: jest.fn(),
          getSessions: jest.fn(),
          selectChain: jest.fn(),
          request: jest.fn(),
          sendTransaction: jest.fn(),
          disconnect: jest.fn(),
          launchWallet: jest.fn(),
          cleanup: jest.fn(),
          addListener: jest.fn(async (_eventName: string, listener: (state: ReownState) => void) => {
            mockStateListeners.push(listener);
            return { remove: mockRemoveListener };
          }),
          removeAllListeners: jest.fn()
        },
        {
          ownKeys() {
            throw new Error('The Capacitor proxy must not be enumerated');
          }
        }
      )
  )
}));
jest.mock('lib/platform', () => ({ isAndroid: jest.fn(() => false), isIOS: jest.fn(() => true) }));
jest.mock('./fees', () => ({ readNativeFeeFields: jest.fn() }));

const SEPOLIA = 11155111;
const ARC = 5042002;
const NO_PUBLIC_RPC = NO_PUBLIC_RPC_CHAIN.id;
const NO_EXPLORER = NO_EXPLORER_CHAIN.id;

// Arc Testnet with a public RPC that differs from its `rpcUrl`, and two chains that lack a public RPC or an
// explorer; every other chain is the registry's own.
jest.mock('./config', () => {
  const chains = jest.requireActual<typeof import('./testing/chains')>('./testing/chains');
  return chains.walletConnectConfigMock([
    {
      id: 5042002,
      name: 'Arc Testnet',
      rpcUrl: 'https://rpc.walletconnect.org/v1?chainId=eip155:5042002&projectId=secret',
      publicRpcUrl: 'https://rpc.testnet.arc.network',
      explorer: 'https://testnet.arcscan.app',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }
    },
    chains.NO_PUBLIC_RPC_CHAIN,
    chains.NO_EXPLORER_CHAIN
  ]);
});

const sessionState = (chainIds?: number[]): ReownState => ({
  configured: true,
  connected: true,
  topic: 'topic-1',
  address: '0x00000000000000000000000000000000000000e1',
  accounts: ['0x00000000000000000000000000000000000000e1'],
  chainId: SEPOLIA,
  chainIds
});

const registration = jest.mocked(registerPlugin<ReownPlugin>).mock.results[0];
if (registration?.type !== 'return') throw new Error('Reown was not registered');
const rawNativeReown = jest.mocked(registration.value);
const rawNativeSend = rawNativeReown.sendTransaction;
const rawNativeRequest = rawNativeReown.request;
const emitStateBeforeNativeListenerSettles = (state: ReownState) => {
  const addStateListener = rawNativeReown.addListener as unknown as jest.MockedFunction<
    (eventName: 'stateChanged', listenerFunc: (state: ReownState) => void) => Promise<{ remove: () => Promise<void> }>
  >;
  addStateListener.mockImplementationOnce(async (_event, listener) => {
    listener(state);
    return { remove: mockRemoveListener };
  });
};
const ESTIMATE: NativeFeeFields = { maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x2' };
const provider = buildNativeReownProvider({ chainId: 11155111, address: '0xowner', rpcUrl: 'https://rpc.test' });
const send = (tx: Record<string, string>) =>
  provider.request({ method: 'eth_sendTransaction', params: [{ to: '0xto', data: '0x', ...tx }] });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isAndroid).mockReturnValue(false);
  jest.mocked(isIOS).mockReturnValue(true);
  rawNativeRequest.mockReset().mockResolvedValue({ result: null });
  rawNativeSend.mockReset();
  rawNativeReown.getState.mockReset();
  mockStateListeners.length = 0;
  // The add-and-switch attempt logs a rejection it swallows.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // The session approved Sepolia, the chain every send below ends up on.
  rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));
  rawNativeSend.mockResolvedValue({ hash: '0xhash' });
  jest.mocked(readNativeFeeFields).mockResolvedValue(ESTIMATE);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const expectedSnapshot: ReownNativeFailure = {
  nativeOrigin: 'wallet_error',
  walletResponseCode: 'internal_error',
  requestAge: '120_to_300s',
  published: 'confirmed',
  backgrounded: 'yes'
};
const nativeFailureCode =
  'REOWN_NATIVE_REQUEST_FAILURE:{"nativeOrigin":"wallet_error","walletResponseCode":"internal_error","requestAge":"120_to_300s","published":"confirmed","backgrounded":"yes"}';
const rejectionOf = (pending: Promise<unknown>): Promise<{ error: unknown }> =>
  pending.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => ({ error })
  );

describe('Android native request failures', () => {
  beforeEach(() => {
    jest.mocked(isAndroid).mockReturnValue(true);
    jest.mocked(isIOS).mockReturnValue(false);
  });

  it('marks the actual Android send rejection without changing its display or cause', async () => {
    const cause = new Error('original local cause');
    const raw = Object.assign(new Error('wallet wording', { cause }), {
      code: 'REOWN_NATIVE_REQUEST_FAILURE:{"nativeOrigin":"wallet_error","walletResponseCode":"internal_error","requestAge":"120_to_300s","published":"confirmed","backgrounded":"yes"}'
    });
    rawNativeSend.mockRejectedValueOnce(raw);
    await expect(NativeReown.sendTransaction({ chainId: 1, to: '0xto' })).rejects.toBe(raw);
    expect(readReownNativeFailure(raw)).toEqual({
      nativeOrigin: 'wallet_error',
      walletResponseCode: 'internal_error',
      requestAge: '120_to_300s',
      published: 'confirmed',
      backgrounded: 'yes'
    });
    expect(raw.cause).toBe(cause);
    expect(raw.message).toBe('wallet wording');
    expect(rawNativeSend).toHaveBeenCalledWith({ chainId: 1, to: '0xto' });
    expect(rawNativeSend.mock.contexts[0]).toBe(rawNativeReown);
  });

  it('marks the actual Android request rejection without changing its display or cause', async () => {
    const cause = new Error('original local cause');
    const raw = Object.assign(new Error('wallet wording', { cause }), { code: nativeFailureCode });
    const options = { topic: 'topic', chainId: 1, method: 'personal_sign', params: ['0xdata', '0xowner'] };
    rawNativeRequest.mockRejectedValueOnce(raw);

    await expect(NativeReown.request(options)).rejects.toBe(raw);

    expect(readReownNativeFailure(raw)).toEqual(expectedSnapshot);
    expect(raw.cause).toBe(cause);
    expect(raw.message).toBe('wallet wording');
    expect(rawNativeRequest.mock.calls[0]?.[0]).toBe(options);
    expect(rawNativeRequest.mock.contexts[0]).toBe(rawNativeReown);
  });

  it('preserves exact request options and successful return values', async () => {
    const requestOptions = { chainId: 1, method: 'personal_sign', params: ['0xdata'] };
    const sendOptions = { chainId: 1, to: '0xto', gas: '0x10', maxFeePerGas: '0x20' };
    const signed = { result: { signature: '0xsigned', code: nativeFailureCode } };
    const sent = { hash: '0xhash' };
    rawNativeRequest.mockResolvedValueOnce(signed);
    rawNativeSend.mockResolvedValueOnce(sent);

    await expect(NativeReown.request(requestOptions)).resolves.toBe(signed);
    await expect(NativeReown.sendTransaction(sendOptions)).resolves.toBe(sent);

    expect(rawNativeRequest.mock.calls[0]?.[0]).toBe(requestOptions);
    expect(rawNativeSend.mock.calls[0]?.[0]).toBe(sendOptions);
    expect(rawNativeRequest.mock.contexts[0]).toBe(rawNativeReown);
    expect(rawNativeSend.mock.contexts[0]).toBe(rawNativeReown);
    expect(readReownNativeFailure(signed.result)).toBeUndefined();
  });

  it('marks plain rejections without changing display fields or enumerating diagnostics', async () => {
    const cause = { code: 4001 };
    const raw = {
      code: nativeFailureCode,
      details: 'local details',
      shortMessage: 'local short',
      message: 'local message',
      cause
    };
    const keys = Object.keys(raw);
    rawNativeRequest.mockRejectedValueOnce(raw);

    await expect(NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] })).rejects.toBe(raw);

    expect(readReownNativeFailure(raw)).toEqual(expectedSnapshot);
    expect(Object.keys(raw)).toEqual(keys);
    expect(raw).toEqual({
      code: nativeFailureCode,
      details: 'local details',
      shortMessage: 'local short',
      message: 'local message',
      cause
    });
  });

  it.each([
    ['plain', 'request', false],
    ['plain', 'sendTransaction', false],
    ['Error', 'request', true],
    ['Error', 'sendTransaction', true]
  ])('marksNonExtensibleRejectionsInPlace: %s %s', async (_kind, method, errorObject) => {
    for (const seal of [Object.freeze, Object.seal, Object.preventExtensions]) {
      let cause: unknown = { code: 4001 };
      for (let index = 0; index < 6; index++) cause = new Error('opaque cause', { cause });
      const original = seal(
        Object.assign(errorObject ? new Error('local message', { cause }) : { message: 'local message', cause }, {
          code: nativeFailureCode,
          name: 'UserRejectedRequestError'
        })
      );
      const before = bridgeReceiveLibraryError(original);
      const rawMethod = method === 'request' ? rawNativeRequest : rawNativeSend;
      rawMethod.mockRejectedValueOnce(original);
      const { error: caught } = await rejectionOf(
        method === 'request'
          ? NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] })
          : NativeReown.sendTransaction({ chainId: 1, to: '0xto' })
      );

      expect(caught).toBe(original);
      expect(readReownNativeFailure(original)).toEqual(expectedSnapshot);
      expect(bridgeReceiveLibraryError(caught)).toBe(before);
      expect(before).toBe('user_rejected');
      expect(Object.getOwnPropertySymbols(original)).toEqual([]);
    }
  });

  it('copies only validated fields and omits wallet codes for non-wallet origins', async () => {
    const raw = {
      code:
        'REOWN_NATIVE_REQUEST_FAILURE:' +
        JSON.stringify({
          nativeOrigin: 'publish_error',
          requestAge: 'unknown',
          published: 'unobserved',
          walletResponseCode: 'user_rejected',
          backgrounded: 'unknown',
          topic: 'private-topic',
          rawCode: 4001
        }),
      nativeOrigin: 'wallet_error',
      data: { backgrounded: 'yes' },
      cause: { code: nativeFailureCode }
    };
    rawNativeRequest.mockRejectedValueOnce(raw);
    await expect(NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] })).rejects.toBe(raw);
    expect(readReownNativeFailure(raw)).toEqual({
      nativeOrigin: 'publish_error',
      requestAge: 'unknown',
      published: 'unobserved'
    });
    expect(readReownNativeFailure(raw.cause)).toBeUndefined();
  });

  it.each([
    { label: 'iOS', android: false, code: nativeFailureCode },
    { label: 'web', android: false, code: nativeFailureCode },
    { label: 'legacy', android: true, code: undefined },
    { label: 'numeric code', android: true, code: 4001 },
    { label: 'invalid prefix', android: true, code: ' ' + nativeFailureCode },
    { label: 'invalid JSON', android: true, code: 'REOWN_NATIVE_REQUEST_FAILURE:{' },
    {
      label: 'invalid origin',
      android: true,
      code: 'REOWN_NATIVE_REQUEST_FAILURE:{"nativeOrigin":"secret","requestAge":"unknown","published":"unobserved"}'
    },
    {
      label: 'missing age',
      android: true,
      code: 'REOWN_NATIVE_REQUEST_FAILURE:{"nativeOrigin":"publish_error","published":"unobserved"}'
    },
    {
      label: 'invalid publication',
      android: true,
      code: 'REOWN_NATIVE_REQUEST_FAILURE:{"nativeOrigin":"publish_error","requestAge":"unknown","published":"yes"}'
    }
  ])('omitsMetadataOutsideActualAndroidPluginFailures: $label', async ({ label, android, code }) => {
    jest.mocked(isAndroid).mockReturnValue(android);
    jest.mocked(isIOS).mockReturnValue(label === 'iOS');
    const original = { code, ...expectedSnapshot, cause: { code: nativeFailureCode } };
    rawNativeRequest.mockRejectedValueOnce(original);
    rawNativeSend.mockRejectedValueOnce(original);
    for (const pending of [
      NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] }),
      NativeReown.sendTransaction({ chainId: 1, to: '0xto' })
    ]) {
      const { error: caught } = await rejectionOf(pending);
      expect(caught).toBe(original);
      expect(readReownNativeFailure(caught)).toBeUndefined();
    }
  });

  it('does not decode inherited codes, nested envelopes or primitive rejections', async () => {
    const inherited: object = Object.create({ code: nativeFailureCode });
    const nested = new Error('outer', { cause: { code: nativeFailureCode } });
    for (const original of [inherited, nested, nativeFailureCode, undefined, null, false, 4001]) {
      rawNativeSend.mockRejectedValueOnce(original);
      const { error: caught } = await rejectionOf(NativeReown.sendTransaction({ chainId: 1, to: '0xto' }));
      expect(caught).toBe(original);
      expect(readReownNativeFailure(caught)).toBeUndefined();
    }
  });

  it('preserves the original rejection when code, display or name access is hostile', async () => {
    const hostileCode = Object.defineProperty({}, 'code', {
      get() {
        throw new Error('hostile code');
      }
    });
    const hostileDisplay = Object.freeze(
      Object.defineProperty({ code: nativeFailureCode }, 'details', {
        get() {
          throw new Error('hostile display');
        }
      })
    );
    const hostileDescriptor = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('hostile descriptor');
        }
      }
    );
    const hostileName = Object.freeze(
      Object.defineProperty({ code: nativeFailureCode, message: 'wallet wording' }, 'name', {
        get() {
          throw new Error('hostile name');
        }
      })
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const original of [hostileCode, hostileDescriptor, revoked.proxy]) {
      rawNativeRequest.mockRejectedValueOnce(original);
      const { error: caught } = await rejectionOf(
        NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] })
      );
      expect(caught).toBe(original);
      expect(readReownNativeFailure(caught)).toBeUndefined();
    }
    // A valid own code is enough; the facade never reads display fields.
    for (const original of [hostileDisplay, hostileName]) {
      rawNativeRequest.mockRejectedValueOnce(original);
      const { error: caught } = await rejectionOf(
        NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] })
      );
      expect(caught).toBe(original);
      expect(readReownNativeFailure(caught)).toEqual(expectedSnapshot);
    }
  });

  it('forwardsAuxiliaryMethodsWithoutDecoding', async () => {
    const original = { code: nativeFailureCode, message: 'auxiliary failure' };
    const options = { projectId: 'project', appName: 'app', appDescription: '', appUrl: '', icons: [], chainIds: [1] };
    const listener = jest.fn();
    const methods: ReadonlyArray<keyof ReownPlugin> = [
      'configure',
      'present',
      'connectUri',
      'getState',
      'getSessions',
      'selectChain',
      'disconnect',
      'launchWallet',
      'cleanup',
      'addListener',
      'removeAllListeners'
    ];
    for (const method of methods) {
      expect(NativeReown[method]).toBe(rawNativeReown[method]);
      jest.mocked(rawNativeReown[method]).mockRejectedValueOnce(original);
    }
    for (const invoke of [
      () => NativeReown.configure(options),
      () => NativeReown.present(),
      () => NativeReown.connectUri(),
      () => NativeReown.getState(),
      () => NativeReown.getSessions(),
      () => NativeReown.selectChain({ chainId: 1 }),
      () => NativeReown.disconnect({ topic: 'topic' }),
      () => NativeReown.launchWallet(),
      () => NativeReown.cleanup({ topic: 'topic' }),
      () => NativeReown.addListener('stateChanged', listener),
      () => NativeReown.removeAllListeners()
    ]) {
      const { error: caught } = await rejectionOf(invoke());
      expect(caught).toBe(original);
      expect(readReownNativeFailure(caught)).toBeUndefined();
    }
    expect(rawNativeReown.configure.mock.calls[0]?.[0]).toBe(options);
    expect(rawNativeReown.addListener).toHaveBeenCalledWith('stateChanged', listener);
    const handle = { remove: mockRemoveListener };
    rawNativeReown.addListener.mockResolvedValueOnce(handle);
    await expect(NativeReown.addListener('stateChanged', listener)).resolves.toBe(handle);
  });
});

// A caller that set no fee gets fields with headroom; one that set any fee field keeps what it set.
it('sends the fee estimate when the caller set no fee', async () => {
  await send({});

  expect(readNativeFeeFields).toHaveBeenCalledWith(11155111);
  expect(rawNativeSend).toHaveBeenCalledWith(expect.objectContaining(ESTIMATE));
});

it.each([
  ['gasPrice', { gasPrice: '0x9' }],
  ['maxFeePerGas', { maxFeePerGas: '0x50', maxPriorityFeePerGas: '0x3' }],
  ['only maxPriorityFeePerGas', { maxPriorityFeePerGas: '0x3' }]
])('keeps the fee the caller set with %s and reads no estimate', async (_label, fee) => {
  await send(fee);

  expect(readNativeFeeFields).not.toHaveBeenCalled();
  expect(rawNativeSend).toHaveBeenCalledWith(expect.objectContaining(fee));
});

it('routes reads and sends to the selected chain after a claim switches chains', async () => {
  const switched = buildNativeReownProvider({ chainId: 5042002, address: '0xowner', rpcUrl: 'https://arc.test' });
  await switched.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
  expect(await switched.request({ method: 'eth_chainId' })).toBe('0xaa36a7');
  await switched.request({ method: 'eth_sendTransaction', params: [{ to: '0xto' }] });
  expect(rawNativeSend).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111 }));
  expect(readNativeFeeFields).toHaveBeenCalledWith(11155111);
  await expect(
    switched.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xdeadbeef' }] })
  ).rejects.toThrow();
  expect(await switched.request({ method: 'eth_chainId' })).toBe('0xaa36a7');
});

describe('assertNativeSessionChain', () => {
  it('throws a NativeSessionChainNotApprovedError when the session did not approve the chain', () => {
    const thrown = (() => {
      try {
        assertNativeSessionChain(sessionState([SEPOLIA]), ARC, 'Arc Testnet');
        return undefined;
      } catch (err) {
        return err;
      }
    })();

    expect(thrown).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(thrown).toMatchObject({ chainId: ARC, networkName: 'Arc Testnet' });
    expect(readReownNativeFailure(thrown)).toBeUndefined();
  });

  it('passes when the session approved the chain', () => {
    expect(() => assertNativeSessionChain(sessionState([SEPOLIA, ARC]), ARC, 'Arc Testnet')).not.toThrow();
  });

  it('passes when an older native build reports no chainIds', () => {
    expect(() => assertNativeSessionChain(sessionState(undefined), ARC, 'Arc Testnet')).not.toThrow();
  });

  it.each([
    ['is not connected', { ...sessionState(undefined), connected: false, topic: undefined }],
    ['is connected with no topic', { ...sessionState(undefined), topic: undefined }]
  ])('refuses a state that %s, with or without chainIds', (_label, state) => {
    expect(() => assertNativeSessionChain(state, ARC, 'Arc Testnet')).toThrow(NativeSessionChainNotApprovedError);
    expect(() => assertNativeSessionChain({ ...state, chainIds: [ARC] }, ARC, 'Arc Testnet')).toThrow(
      NativeSessionChainNotApprovedError
    );
  });
});

describe('ensureNativeSessionChain', () => {
  beforeEach(() => {
    rawNativeRequest.mockReset();
    rawNativeReown.getState.mockReset();
  });

  it('adds and switches to a missing chain on an approved chain, then reads the state again', async () => {
    rawNativeRequest.mockResolvedValue({ result: null });
    const reread = sessionState([SEPOLIA, ARC]);
    rawNativeReown.getState.mockResolvedValue(reread);

    const next = await ensureNativeSessionChain(sessionState([SEPOLIA]), ARC);

    expect(rawNativeRequest).toHaveBeenCalledTimes(2);
    expect(rawNativeRequest).toHaveBeenNthCalledWith(1, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x4cef52',
          chainName: 'Arc Testnet',
          rpcUrls: ['https://rpc.testnet.arc.network'],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          blockExplorerUrls: ['https://testnet.arcscan.app']
        }
      ]
    });
    expect(rawNativeRequest).toHaveBeenNthCalledWith(2, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x4cef52' }]
    });
    expect(NativeReown.getState).toHaveBeenCalledTimes(1);
    expect(next).toBe(reread);
  });

  it('sends nothing when the session already approved the chain', async () => {
    const state = sessionState([SEPOLIA, ARC]);

    await expect(ensureNativeSessionChain(state, ARC)).resolves.toBe(state);

    expect(rawNativeRequest).not.toHaveBeenCalled();
    expect(NativeReown.getState).not.toHaveBeenCalled();
  });

  it('sends nothing when an older native build reports no chainIds', async () => {
    const state = sessionState(undefined);

    await expect(ensureNativeSessionChain(state, ARC)).resolves.toBe(state);

    expect(rawNativeRequest).not.toHaveBeenCalled();
  });

  it('swallows a rejected add, sends no switch, and leaves the guard to refuse the chain', async () => {
    rawNativeRequest.mockRejectedValue(new Error('Invalid permissions for call.'));
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));

    await expect(prepareNativeSessionChain(ARC)).rejects.toThrow(NativeSessionChainNotApprovedError);

    expect(rawNativeRequest).toHaveBeenCalledTimes(1);
    expect(rawNativeRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'wallet_addEthereumChain' }));
  });

  it.each(['wallet_addEthereumChain', 'wallet_switchEthereumChain'])(
    'carriesTheSwallowedNativeRejectionSnapshotOnTheRefusal: %s',
    async method => {
      jest.mocked(isAndroid).mockReturnValue(true);
      const rejection = Object.assign(new Error('User rejected'), { code: nativeFailureCode });
      if (method === 'wallet_addEthereumChain') rawNativeRequest.mockRejectedValueOnce(rejection);
      else rawNativeRequest.mockResolvedValueOnce({ result: null }).mockRejectedValueOnce(rejection);
      rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));

      const { error: refusal } = await rejectionOf(prepareNativeSessionChain(ARC));

      expect(rawNativeRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method }));
      expect(refusal).toBeInstanceOf(NativeSessionChainNotApprovedError);
      expect(readReownNativeFailure(refusal)).toEqual(expectedSnapshot);
      expect(refusal).not.toHaveProperty('cause');
      expect(String(refusal)).not.toContain('User rejected');
    }
  );

  it('leaves the refusal unmarked when the swallowed rejection carries no native snapshot', async () => {
    jest.mocked(isAndroid).mockReturnValue(true);
    rawNativeRequest.mockRejectedValueOnce(new Error('Invalid permissions for call.'));
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));

    const { error: refusal } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(refusal).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(readReownNativeFailure(refusal)).toBeUndefined();
  });

  // A wallet that does not know the chain rejects an add request with an empty RPC URL.
  it('refuses a missing chain with no public RPC without asking the wallet to add it', async () => {
    rawNativeRequest.mockRejectedValue(new Error('rpcUrls must contain a valid URL'));
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));

    await expect(prepareNativeSessionChain(NO_PUBLIC_RPC)).rejects.toMatchObject({
      name: 'NativeSessionChainNotApprovedError',
      chainId: NO_PUBLIC_RPC,
      networkName: 'No Public RPC'
    });

    expect(rawNativeRequest).not.toHaveBeenCalled();
  });

  it('asks the wallet to add a missing chain with no explorer without an explorer URL', async () => {
    rawNativeRequest.mockResolvedValue({ result: null });
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA, NO_EXPLORER]));

    await ensureNativeSessionChain(sessionState([SEPOLIA]), NO_EXPLORER);

    expect(rawNativeRequest).toHaveBeenNthCalledWith(1, {
      topic: 'topic-1',
      chainId: SEPOLIA,
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0xf1b32',
          chainName: 'No Explorer',
          rpcUrls: ['https://rpc.example'],
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }
        }
      ]
    });
  });
});

describe('waiting for the session to approve an added chain', () => {
  const updateSession = (state: ReownState) => mockStateListeners.forEach(listener => listener(state));

  // Records the outcome without leaving a rejection unhandled while the test moves the clock.
  const watch = (pending: Promise<void>) => {
    const watched: { settled: boolean; error?: unknown } = { settled: false };
    pending.then(
      () => {
        watched.settled = true;
      },
      (error: unknown) => {
        watched.settled = true;
        watched.error = error;
      }
    );
    return watched;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    rawNativeRequest.mockReset().mockResolvedValue({ result: null });
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA]));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves when the session update arrives after the switch answered', async () => {
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(1000);
    updateSession(sessionState([SEPOLIA, ARC]));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resolves when a state re-read approves the chain and no update event arrives', async () => {
    jest
      .mocked(rawNativeReown.getState)
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValue(sessionState([SEPOLIA, ARC]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    expect(watched.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses the chain after 5 s when the session never approves it', async () => {
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(4999);
    expect(watched.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses the chain when the session is deleted during the wait', async () => {
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(1000);
    const deleted: ReownState = { configured: true, connected: false, accounts: [] };
    rawNativeReown.getState.mockResolvedValue(deleted);
    updateSession(deleted);
    await jest.advanceTimersByTimeAsync(4000);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
  });

  it('does not let the initial state read replace a deletion that arrived while it was in flight', async () => {
    let releaseStale: (state: ReownState) => void = () => undefined;
    const stale = new Promise<ReownState>(resolve => {
      releaseStale = resolve;
    });
    const deleted: ReownState = { configured: true, connected: false, accounts: [] };
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(deleted)
      .mockImplementationOnce(() => stale);
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession(deleted);
    releaseStale(sessionState([SEPOLIA, ARC]));
    await jest.advanceTimersByTimeAsync(0);

    expect(rawNativeRequest).not.toHaveBeenCalled();
    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
  });

  it('does not let a reread after a rejected switch replace a deletion that arrived while it was in flight', async () => {
    let releaseStale: (state: ReownState) => void = () => undefined;
    const stale = new Promise<ReownState>(resolve => {
      releaseStale = resolve;
    });
    const deleted: ReownState = { configured: true, connected: false, accounts: [] };
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(deleted)
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockImplementationOnce(() => stale);
    jest.mocked(rawNativeReown.request).mockRejectedValueOnce(new Error('User rejected'));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession(deleted);
    releaseStale(sessionState([SEPOLIA, ARC]));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
  });

  it('does not let a state read that started before a deletion replace that deletion', async () => {
    let releaseStale: (state: ReownState) => void = () => undefined;
    const stale = new Promise<ReownState>(resolve => {
      releaseStale = resolve;
    });
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockImplementationOnce(() => stale);
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    const deleted: ReownState = { configured: true, connected: false, accounts: [] };
    updateSession(deleted);
    releaseStale(sessionState([SEPOLIA, ARC]));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
  });

  it('does not wait out the deadline when the session approved the chain before the wait starts', async () => {
    let releaseSwitch: (value: { result: null }) => void = () => undefined;
    const switching = new Promise<{ result: null }>(resolve => {
      releaseSwitch = resolve;
    });
    jest
      .mocked(rawNativeReown.request)
      .mockResolvedValueOnce({ result: null })
      .mockImplementationOnce(() => switching);
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession(sessionState([SEPOLIA, ARC]));
    releaseSwitch({ result: null });
    await jest.advanceTimersByTimeAsync(0);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not let a reread restore an approval that a deletion superseded before the wait', async () => {
    let releaseSwitch: (value: { result: null }) => void = () => undefined;
    const switching = new Promise<{ result: null }>(resolve => {
      releaseSwitch = resolve;
    });
    jest
      .mocked(rawNativeReown.request)
      .mockResolvedValueOnce({ result: null })
      .mockImplementationOnce(() => switching);
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA, ARC]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession(sessionState([SEPOLIA, ARC]));
    updateSession({ configured: true, connected: false, accounts: [] });
    releaseSwitch({ result: null });
    await jest.advanceTimersByTimeAsync(0);

    expect(watched.settled).toBe(false);

    updateSession(sessionState([SEPOLIA, ARC]));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('accepts a state read that starts after a deletion and then approves the chain', async () => {
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA, ARC]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession({ configured: true, connected: false, accounts: [] });
    await jest.advanceTimersByTimeAsync(500);

    expect(watched).toEqual({ settled: true, error: undefined });
  });

  it('refuses the chain at once when the wallet rejected the switch', async () => {
    jest
      .mocked(rawNativeReown.request)
      .mockResolvedValueOnce({ result: null })
      .mockRejectedValueOnce(new Error('User rejected'));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(rawNativeRequest).toHaveBeenCalledTimes(2);
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps an approval that arrived while the switch was pending when the rejection reread lacks the chain', async () => {
    let rejectSwitch: (error: Error) => void = () => undefined;
    const switching = new Promise<never>((_resolve, reject) => {
      rejectSwitch = reject;
    });
    jest
      .mocked(rawNativeReown.request)
      .mockResolvedValueOnce({ result: null })
      .mockImplementationOnce(() => switching);
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession(sessionState([SEPOLIA, ARC]));
    rejectSwitch(new Error('User rejected'));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched).toEqual({ settled: true, error: undefined });
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    { eventTiming: 'during the add', method: 'wallet_addEthereumChain', reread: 'approved' },
    { eventTiming: 'during the switch', method: 'wallet_switchEthereumChain', reread: 'approved' },
    { eventTiming: 'during the switch', method: 'wallet_switchEthereumChain', reread: 'legacy' },
    { eventTiming: 'during the initial read', method: 'wallet_switchEthereumChain', reread: 'approved' },
    { eventTiming: 'during the initial read', method: 'wallet_switchEthereumChain', reread: 'legacy' }
  ])(
    'refuses when a rejected $method follows an unapproved event $eventTiming and rereads $reread state',
    async ({ eventTiming, method, reread }) => {
      let rejectRequest: (error: Error) => void = () => undefined;
      const failedRequest = new Promise<never>((_resolve, reject) => {
        rejectRequest = reject;
      });
      let releaseInitialRead: (state: ReownState) => void = () => undefined;
      const initialRead = new Promise<ReownState>(resolve => {
        releaseInitialRead = resolve;
      });
      let releaseStaleRead: (state: ReownState) => void = () => undefined;
      const staleRead = new Promise<ReownState>(resolve => {
        releaseStaleRead = resolve;
      });
      const request = jest.mocked(rawNativeReown.request);
      if (method === 'wallet_addEthereumChain') {
        request.mockImplementationOnce(() => failedRequest);
      } else {
        request.mockResolvedValueOnce({ result: null }).mockImplementationOnce(() => failedRequest);
      }
      const getState = jest.mocked(rawNativeReown.getState).mockReset();
      if (eventTiming === 'during the initial read') {
        getState.mockImplementationOnce(() => initialRead).mockImplementationOnce(() => staleRead);
      } else {
        getState.mockResolvedValueOnce(sessionState([SEPOLIA])).mockImplementationOnce(() => staleRead);
      }
      const watched = watch(prepareNativeSessionChain(ARC));

      await jest.advanceTimersByTimeAsync(0);
      if (eventTiming === 'during the initial read') {
        updateSession(sessionState([SEPOLIA]));
        releaseInitialRead(sessionState([SEPOLIA, ARC]));
        await jest.advanceTimersByTimeAsync(0);
      } else {
        updateSession(sessionState([SEPOLIA]));
      }
      rejectRequest(new Error('User rejected'));
      await jest.advanceTimersByTimeAsync(0);
      releaseStaleRead(reread === 'approved' ? sessionState([SEPOLIA, ARC]) : sessionState(undefined));
      await jest.advanceTimersByTimeAsync(0);

      expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
      expect(mockRemoveListener).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it.each(['wallet_addEthereumChain', 'wallet_switchEthereumChain'])(
    'does not let an approval emitted before the initial read settle the wait after %s succeeds',
    async method => {
      const approved = sessionState([SEPOLIA, ARC]);
      emitStateBeforeNativeListenerSettles(approved);
      if (method === 'wallet_switchEthereumChain') {
        jest.mocked(rawNativeReown.request).mockResolvedValueOnce({ result: null });
      }
      const watched = watch(prepareNativeSessionChain(ARC));

      await jest.advanceTimersByTimeAsync(0);

      expect(watched.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(5000);

      expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
      expect(mockRemoveListener).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('names a deletion that arrived while the add was pending when the rejection reread throws', async () => {
    let rejectAdd: (error: Error) => void = () => undefined;
    const adding = new Promise<never>((_resolve, reject) => {
      rejectAdd = reject;
    });
    jest.mocked(rawNativeReown.request).mockImplementationOnce(() => adding);
    const reread = new Error('reread down');
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockRejectedValueOnce(reread);
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession({ configured: true, connected: false, accounts: [] });
    rejectAdd(new Error('User rejected'));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(watched.error).not.toBe(reread);
    expect(rawNativeRequest).toHaveBeenCalledTimes(1);
    const report = bridgeReceiveIdentity({ route: 'usdcx', step: 'precheck_session_chain', cause: watched.error });
    expect(report).toBe(
      'via usdcx; failed at precheck_session_chain; precheck session_missing; attempt rejected_unread; evm error none'
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('names a deletion that arrived while the add was pending when the rejection reread returns the old session', async () => {
    let rejectAdd: (error: Error) => void = () => undefined;
    const adding = new Promise<never>((_resolve, reject) => {
      rejectAdd = reject;
    });
    jest.mocked(rawNativeReown.request).mockImplementationOnce(() => adding);
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockResolvedValue(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]))
      .mockResolvedValueOnce(sessionState([SEPOLIA]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession({ configured: true, connected: false, accounts: [] });
    rejectAdd(new Error('User rejected'));
    await jest.advanceTimersByTimeAsync(0);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(rawNativeRequest).toHaveBeenCalledTimes(1);
    const report = bridgeReceiveIdentity({ route: 'usdcx', step: 'precheck_session_chain', cause: watched.error });
    expect(report).toBe(
      'via usdcx; failed at precheck_session_chain; precheck session_missing; attempt rejected; evm error none'
    );
  });

  it('names a deletion that arrived while the switch was pending when the wait reread throws', async () => {
    let releaseSwitch: (value: { result: null }) => void = () => undefined;
    const switching = new Promise<{ result: null }>(resolve => {
      releaseSwitch = resolve;
    });
    jest
      .mocked(rawNativeReown.request)
      .mockResolvedValueOnce({ result: null })
      .mockImplementationOnce(() => switching);
    jest
      .mocked(rawNativeReown.getState)
      .mockReset()
      .mockRejectedValue(new Error('reread down'))
      .mockResolvedValueOnce(sessionState([SEPOLIA]));
    const watched = watch(prepareNativeSessionChain(ARC));

    await jest.advanceTimersByTimeAsync(0);
    updateSession({ configured: true, connected: false, accounts: [] });
    releaseSwitch({ result: null });
    await jest.advanceTimersByTimeAsync(5000);

    expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(jest.getTimerCount()).toBe(0);
    const report = bridgeReceiveIdentity({ route: 'usdcx', step: 'precheck_session_chain', cause: watched.error });
    expect(report).toBe(
      'via usdcx; failed at precheck_session_chain; precheck session_missing; attempt unconfirmed; evm error none'
    );
  });
});

describe('native session precheck reasons', () => {
  const chainId = String(ARC);
  const chainHex = '0x4cef52';
  const topic = 'topic-secret';
  const amount = '1.25';
  const rpcUrl = 'https://rpc.example/secret';
  const address = `0x${'ab'.repeat(20)}`;
  const secrets = [
    chainId,
    chainHex,
    '4cef52',
    'eip155',
    'Arc Testnet',
    'WalletConnect',
    '0x',
    topic,
    'topic-1',
    amount,
    rpcUrl,
    address
  ];

  const expectReason = (cause: unknown, failure: string, attempt: string, evm: string) => {
    const report = bridgeReceiveIdentity({ route: 'usdcx', step: 'precheck_session_chain', cause });
    expect(report).toBe(
      `via usdcx; failed at precheck_session_chain; precheck ${failure}; attempt ${attempt}; evm error ${evm}`
    );
    for (const secret of secrets) expect(report).not.toContain(secret);
  };

  const watch = (pending: Promise<void>) => {
    const watched: { settled: boolean; error?: unknown } = { settled: false };
    pending.then(
      () => {
        watched.settled = true;
      },
      (error: unknown) => {
        watched.settled = true;
        watched.error = error;
      }
    );
    return watched;
  };

  const updateSession = (state: ReownState) => mockStateListeners.forEach(listener => listener(state));

  it('names a state read that threw, and keeps the plugin error', async () => {
    const leaked = `plugin down ${topic} ${address} amount ${amount} ${rpcUrl} eip155:${chainId} ${chainHex}`;
    const cause = new Error(leaked);
    rawNativeReown.getState.mockRejectedValueOnce(cause);

    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBe(cause);
    expect(cause.message).toBe(leaked);
    expect(rawNativeRequest).not.toHaveBeenCalled();
    expectReason(error, 'state_unread', 'not_attempted', 'other');
  });

  it('keeps an initial state read failure when a session event arrives during that read', async () => {
    jest.useFakeTimers();
    const cause = new Error(`state read failed ${topic}`);
    rawNativeReown.getState.mockImplementationOnce(async () => {
      updateSession(sessionState([SEPOLIA]));
      throw cause;
    });

    try {
      const watched = watch(prepareNativeSessionChain(ARC));
      await jest.advanceTimersByTimeAsync(5000);

      expect(watched.error).toBe(cause);
      expect(rawNativeRequest).not.toHaveBeenCalled();
      expectReason(watched.error, 'state_unread', 'not_attempted', 'other');
    } finally {
      jest.useRealTimers();
    }
  });

  it('names a state read that threw a function, and rethrows that function', async () => {
    const cause = () => undefined;
    rawNativeReown.getState.mockRejectedValueOnce(cause);

    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBe(cause);
    expect(rawNativeRequest).not.toHaveBeenCalled();
    expectReason(error, 'state_unread', 'not_attempted', 'none');
  });

  it('rethrows a primitive state-read failure unchanged and leaves the precheck unnamed', async () => {
    const cause = `plugin down ${topic} ${address}`;
    rawNativeReown.getState.mockRejectedValueOnce(cause);

    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBe(cause);
    expect(rawNativeRequest).not.toHaveBeenCalled();
    const report = bridgeReceiveIdentity({ route: 'usdcx', step: 'precheck_session_chain', cause: error });
    expect(report).toBe('via usdcx; failed at precheck_session_chain; evm error other');
    for (const secret of secrets) expect(report).not.toContain(secret);
  });

  it('names a missing session when no add or switch was sent', async () => {
    rawNativeReown.getState.mockResolvedValueOnce({
      configured: true,
      connected: false,
      accounts: [address],
      address,
      topic
    });

    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect((error as Error).message).toContain('Arc Testnet');
    expect((error as Error).message).toContain(chainId);
    expect(rawNativeRequest).not.toHaveBeenCalled();
    expectReason(error, 'session_missing', 'not_attempted', 'none');
  });

  it('names an unapproved chain that cannot be proposed', async () => {
    rawNativeReown.getState.mockResolvedValueOnce(sessionState([SEPOLIA]));

    const missingRpc = await rejectionOf(prepareNativeSessionChain(NO_PUBLIC_RPC));

    expect(missingRpc.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect((missingRpc.error as Error).message).toContain('No Public RPC');
    expect((missingRpc.error as Error).message).toContain(String(NO_PUBLIC_RPC));
    expect(rawNativeRequest).not.toHaveBeenCalled();
    const missingRpcReport = bridgeReceiveIdentity({
      route: 'usdcx',
      step: 'precheck_session_chain',
      cause: missingRpc.error
    });
    expect(missingRpcReport).toBe(
      'via usdcx; failed at precheck_session_chain; precheck chain_unapproved; attempt unsupported; evm error none'
    );
    for (const secret of ['990001', 'No Public RPC', 'eip155', 'WalletConnect', rpcUrl, topic, amount, address]) {
      expect(missingRpcReport).not.toContain(secret);
    }

    rawNativeRequest.mockClear();
    rawNativeReown.getState.mockResolvedValueOnce(sessionState([]));
    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(rawNativeRequest).not.toHaveBeenCalled();
    expectReason(error, 'chain_unapproved', 'unsupported', 'none');
  });

  it('names a refused add and keeps the native rejection snapshot off the report text', async () => {
    jest.mocked(isAndroid).mockReturnValue(true);
    const rejection = Object.assign(new Error(`User rejected ${amount} ${rpcUrl} ${topic}`), {
      code: nativeFailureCode
    });
    rawNativeRequest.mockRejectedValueOnce(rejection);

    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(error).not.toHaveProperty('cause');
    expect((error as Error).message).toContain(chainId);
    expect(String(error)).not.toContain('User rejected');
    expect(readReownNativeFailure(error)).toEqual(expectedSnapshot);
    expect(rawNativeRequest).toHaveBeenCalledTimes(1);
    expectReason(error, 'chain_unapproved', 'rejected', 'none');
  });

  it('names a refused add whose session state could not be read again', async () => {
    const reread = new Error(`reread down ${topic} ${address} amount ${amount} ${rpcUrl} ${chainHex}`);
    rawNativeRequest.mockRejectedValueOnce(new Error(`User rejected ${amount}`));
    rawNativeReown.getState.mockResolvedValueOnce(sessionState([SEPOLIA])).mockRejectedValueOnce(reread);

    const { error } = await rejectionOf(prepareNativeSessionChain(ARC));

    expect(error).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(error).not.toBe(reread);
    expect(error).not.toHaveProperty('cause');
    expect((error as Error).message).toContain('Arc Testnet');
    expect(rawNativeRequest).toHaveBeenCalledTimes(1);
    expectReason(error, 'chain_unapproved', 'rejected_unread', 'none');
  });

  it('names a switch that returned while the session still had not approved the chain', async () => {
    jest.useFakeTimers();
    try {
      const watched = watch(prepareNativeSessionChain(ARC));

      await jest.advanceTimersByTimeAsync(4999);
      expect(watched.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
      expect(rawNativeRequest).toHaveBeenCalledTimes(2);
      expect((watched.error as Error).message).toContain(chainId);
      expectReason(watched.error, 'chain_unapproved', 'unconfirmed', 'none');
    } finally {
      jest.useRealTimers();
    }
  });

  it('names a session that disappeared while waiting for the chain', async () => {
    jest.useFakeTimers();
    try {
      const watched = watch(prepareNativeSessionChain(ARC));

      await jest.advanceTimersByTimeAsync(1000);
      const deleted: ReownState = { configured: true, connected: false, accounts: [address], address, topic };
      rawNativeReown.getState.mockResolvedValue(deleted);
      updateSession(deleted);
      await jest.advanceTimersByTimeAsync(4000);

      expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
      expect((watched.error as Error).message).toContain('eip155');
      expectReason(watched.error, 'session_missing', 'unconfirmed', 'none');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a pre-read approval when the switch state cannot be read again', async () => {
    jest.useFakeTimers();
    try {
      emitStateBeforeNativeListenerSettles(sessionState([SEPOLIA, ARC]));
      rawNativeReown.getState.mockReset();
      rawNativeReown.getState.mockRejectedValue(
        new Error(`read failed ${rpcUrl} ${chainHex} amount ${amount} ${topic} ${address}`)
      );
      rawNativeReown.getState.mockResolvedValueOnce(sessionState([SEPOLIA]));
      const watched = watch(prepareNativeSessionChain(ARC));

      await jest.advanceTimersByTimeAsync(4999);
      expect(watched.settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      expect(watched.error).toBeInstanceOf(NativeSessionChainNotApprovedError);
      expect(rawNativeRequest).toHaveBeenCalledTimes(2);
      expect((watched.error as Error).message).toContain(chainId);
      expectReason(watched.error, 'chain_unapproved', 'unconfirmed_unread', 'none');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('buildNativeReownProvider', () => {
  beforeEach(() => {
    rawNativeRequest.mockReset();
    rawNativeReown.getState.mockReset();
    rawNativeSend.mockReset();
  });

  it.each(['personal_sign', 'eth_sendTransaction'])(
    'marks the actual provider %s rejection through the real facade',
    async method => {
      jest.mocked(isAndroid).mockReturnValue(true);
      rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));
      const cause = { code: 4001 };
      const original = Object.assign(new Error('wallet wording', { cause }), { code: nativeFailureCode });
      rawNativeRequest.mockRejectedValueOnce(original);
      rawNativeSend.mockRejectedValueOnce(original);
      const params = method === 'personal_sign' ? ['0xdata', '0xowner'] : [{ to: '0xto' }];

      const { error: caught } = await rejectionOf(provider.request({ method, params }));

      expect(caught).toBe(original);
      expect(original.cause).toBe(cause);
      expect(readReownNativeFailure(caught)).toEqual(expectedSnapshot);
      expect(rawNativeRequest).toHaveBeenCalledTimes(method === 'personal_sign' ? 1 : 0);
      expect(rawNativeSend).toHaveBeenCalledTimes(method === 'eth_sendTransaction' ? 1 : 0);
      expect(rawNativeRequest.mock.calls[0]?.[0]).toEqual(
        method === 'personal_sign' ? { chainId: SEPOLIA, method, params } : undefined
      );
      const sendOptions = expect.objectContaining({ chainId: SEPOLIA, to: '0xto' });
      expect(rawNativeSend.mock.calls[0]?.[0]).toEqual(method === 'eth_sendTransaction' ? sendOptions : undefined);
    }
  );

  it('unwraps a successful provider signing request through the real facade', async () => {
    jest.mocked(isAndroid).mockReturnValue(true);
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));
    rawNativeRequest.mockResolvedValueOnce({ result: '"0xsigned"' });
    await expect(provider.request({ method: 'personal_sign', params: ['0xdata'] })).resolves.toBe('0xsigned');
  });

  it.each(['preparation', 'fee', 'RPC', 'transaction field'])(
    'omitsMetadataOutsideActualAndroidPluginFailures: provider %s',
    async stage => {
      jest.mocked(isAndroid).mockReturnValue(true);
      const original = Object.assign(new Error('local failure'), { code: nativeFailureCode });
      rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));
      const previousFetch = global.fetch;
      let pending: Promise<unknown>;
      if (stage === 'preparation') {
        rawNativeReown.getState.mockRejectedValueOnce(original);
        pending = provider.request({ method: 'personal_sign', params: [] });
      } else if (stage === 'fee') {
        jest.mocked(readNativeFeeFields).mockRejectedValueOnce(original);
        pending = send({});
      } else if (stage === 'transaction field') {
        const tx = Object.defineProperty({}, 'to', {
          get() {
            throw original;
          }
        });
        pending = provider.request({ method: 'eth_sendTransaction', params: [tx] });
      } else {
        global.fetch = jest.fn().mockRejectedValueOnce(original);
        pending = provider.request({ method: 'eth_getBalance', params: ['0xowner', 'latest'] });
      }
      try {
        const { error: caught } = await rejectionOf(pending);
        expect(caught).toBe(original);
        expect(readReownNativeFailure(caught)).toBeUndefined();
        expect(rawNativeRequest).not.toHaveBeenCalled();
        expect(rawNativeSend).not.toHaveBeenCalled();
      } finally {
        global.fetch = previousFetch;
      }
    }
  );

  it('refuses eth_sendTransaction on a chain the session did not approve, before any wallet prompt', async () => {
    jest.mocked(isAndroid).mockReturnValue(true);
    const original = Object.assign(new Error('User rejected'), { code: nativeFailureCode });
    rawNativeRequest.mockRejectedValue(original);
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));
    const provider = buildNativeReownProvider({
      chainId: ARC,
      address: '0x00000000000000000000000000000000000000e1',
      rpcUrl: 'https://rpc.test'
    });

    const { error: caught } = await rejectionOf(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: '0x00000000000000000000000000000000000000b2' }]
      })
    );

    expect(caught).toBeInstanceOf(NativeSessionChainNotApprovedError);
    expect(caught).not.toBe(original);
    expect(caught).not.toHaveProperty('cause');
    expect(readReownNativeFailure(caught)).toEqual(expectedSnapshot);
    expect(readReownNativeFailure(original)).toEqual(expectedSnapshot);

    expect(rawNativeSend).not.toHaveBeenCalled();
  });

  it('sends eth_sendTransaction on a chain the session approved', async () => {
    rawNativeReown.getState.mockResolvedValue(sessionState([SEPOLIA]));
    rawNativeSend.mockResolvedValue({ hash: '0xhash' });
    const provider = buildNativeReownProvider({
      chainId: SEPOLIA,
      address: '0x00000000000000000000000000000000000000e1',
      rpcUrl: 'https://rpc.test'
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: '0x00000000000000000000000000000000000000b2' }]
      })
    ).resolves.toBe('0xhash');

    expect(rawNativeRequest).not.toHaveBeenCalled();
    expect(rawNativeSend).toHaveBeenCalledWith(expect.objectContaining({ chainId: SEPOLIA }));
  });
});

describe('iOS native per-call failures', () => {
  it.each(['unconfigured', 'argument_validation', 'request_construction_error', 'request_call_error'])(
    'marks the original rejection for %s with only unknown observations',
    async nativeOrigin => {
      const cause = new Error('private cause 0x1234567890');
      const original = Object.assign(new Error('original display', { cause }), {
        code: `REOWN_IOS_REQUEST_FAILURE:${nativeOrigin}`
      });
      rawNativeSend.mockRejectedValueOnce(original);
      const { error } = await rejectionOf(NativeReown.sendTransaction({ chainId: 1, to: '0xto' }));
      expect(error).toBe(original);
      expect(original.message).toBe('original display');
      expect(original.cause).toBe(cause);
      expect(readReownNativeFailure(error)).toEqual({ nativeOrigin, requestAge: 'unknown', published: 'unobserved' });
    }
  );

  it('marks request and send independently and rejects untrusted response origins', async () => {
    const first = Object.assign(new Error('first'), { code: 'REOWN_IOS_REQUEST_FAILURE:argument_validation' });
    const second = Object.assign(new Error('second'), { code: 'REOWN_IOS_REQUEST_FAILURE:request_call_error' });
    const forged = Object.assign(new Error('forged'), { code: 'REOWN_IOS_REQUEST_FAILURE:wallet_error' });
    rawNativeRequest.mockRejectedValueOnce(first).mockRejectedValueOnce(forged);
    rawNativeSend.mockRejectedValueOnce(second);
    const [a, b, c] = await Promise.all([
      rejectionOf(NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] })),
      rejectionOf(NativeReown.sendTransaction({ chainId: 1, to: '0xto' })),
      rejectionOf(NativeReown.request({ chainId: 1, method: 'personal_sign', params: [] }))
    ]);
    expect(readReownNativeFailure(a.error)).toEqual({
      nativeOrigin: 'argument_validation',
      requestAge: 'unknown',
      published: 'unobserved'
    });
    expect(readReownNativeFailure(b.error)).toEqual({
      nativeOrigin: 'request_call_error',
      requestAge: 'unknown',
      published: 'unobserved'
    });
    expect(readReownNativeFailure(c.error)).toBeUndefined();
  });
});
