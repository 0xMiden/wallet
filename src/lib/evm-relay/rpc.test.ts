import { RelayProviderRpcError } from './errors';
import {
  RELAY_READ_METHODS,
  RELAY_RPC_TIMEOUT_MS,
  relayRpcRead,
  type RelayRpcFetch,
  type RelayRpcRequestInit
} from './rpc';

const RPC = 'https://rpc.example';

let sent: { url: string; init: RelayRpcRequestInit }[] = [];

function answering(payload: unknown): RelayRpcFetch {
  return async (url, init) => {
    sent.push({ url, init });
    return { json: async () => payload };
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error
  );
}

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  jest.useRealTimers();
});

describe('relayRpcRead', () => {
  it('posts one JSON-RPC request and gives its result', async () => {
    const result = await relayRpcRead(RPC, 'eth_getBalance', ['0x01', 'latest'], answering({ result: '0x10' }));
    expect(result).toBe('0x10');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(RPC);
    expect(sent[0]?.init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(sent[0]?.init.body ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: ['0x01', 'latest']
    });
  });

  it('sends empty parameters for none', async () => {
    await relayRpcRead(RPC, 'eth_blockNumber', undefined, answering({ result: '0x1' }));
    expect(JSON.parse(sent[0]?.init.body ?? '').params).toEqual([]);
  });

  it('keeps the code, the message and the data of an RPC error', async () => {
    const error = await failure(
      relayRpcRead(RPC, 'eth_call', [], answering({ error: { code: 3, message: 'execution reverted', data: '0x08' } }))
    );
    expect(error).toBeInstanceOf(RelayProviderRpcError);
    expect(error).toMatchObject({ code: 3, message: 'execution reverted', data: '0x08' });
  });

  it.each([
    ['an error without a code or a message', { error: {} }],
    ['an error that is not an object', { error: 'boom' }],
    ['an error with a fractional code', { error: { code: 1.5 } }]
  ])('reads %s as an internal error', async (_name, payload) => {
    const error = await failure(relayRpcRead(RPC, 'eth_call', [], answering(payload)));
    expect(error).toMatchObject({ code: -32603, message: 'RPC error for eth_call' });
  });

  it('gives a null result when the answer has a null error', async () => {
    expect(await relayRpcRead(RPC, 'eth_getTransactionReceipt', [], answering({ error: null, result: null }))).toBe(
      null
    );
  });

  it.each([
    ['a body that is not an object', 'text'],
    ['a null body', null]
  ])('refuses %s', async (_name, payload) => {
    const error = await failure(relayRpcRead(RPC, 'eth_call', [], answering(payload)));
    expect(error).toMatchObject({ code: -32603, message: 'Invalid RPC response for eth_call' });
  });

  it('maps a transport failure to an internal error', async () => {
    const fetchFn: RelayRpcFetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const error = await failure(relayRpcRead(RPC, 'eth_call', [], fetchFn));
    expect(error).toMatchObject({ code: -32603, message: 'The RPC read eth_call failed' });
  });

  it('ends a read that takes too long', async () => {
    jest.useFakeTimers();
    const fetchFn: RelayRpcFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const outcome = failure(relayRpcRead(RPC, 'eth_call', [], fetchFn));
    await jest.advanceTimersByTimeAsync(RELAY_RPC_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: -32603 });
  });

  it('uses the global fetch by default', async () => {
    const original: unknown = Reflect.get(globalThis, 'fetch');
    const stub = jest.fn(async (_url: string, _init: RelayRpcRequestInit) => ({
      json: async () => ({ result: '0x2' })
    }));
    Reflect.set(globalThis, 'fetch', stub);
    try {
      expect(await relayRpcRead(RPC, 'eth_chainId', [])).toBe('0x2');
      expect(stub).toHaveBeenCalledWith(RPC, expect.objectContaining({ method: 'POST' }));
    } finally {
      Reflect.set(globalThis, 'fetch', original);
    }
  });
});

describe('RELAY_READ_METHODS', () => {
  it('holds no method that signs or sends', () => {
    for (const method of RELAY_READ_METHODS) {
      expect(method).not.toMatch(/sign|send|wallet_|accounts/i);
    }
    expect(RELAY_READ_METHODS.has('eth_getTransactionReceipt')).toBe(true);
  });
});
