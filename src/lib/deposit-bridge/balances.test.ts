import { encodeFunctionData, parseAbi } from 'viem';

import { BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS } from 'lib/epoch/bridgeable-token';

import { readMockUsdcBalance } from './balances';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const BALANCE = 42n;
const ENCODED_BALANCE = `0x${BALANCE.toString(16).padStart(64, '0')}`;
const BALANCE_OF_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);
const ORIGINAL_FETCH = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

describe('readMockUsdcBalance', () => {
  afterEach(() => {
    if (ORIGINAL_FETCH) {
      Object.defineProperty(globalThis, 'fetch', ORIGINAL_FETCH);
    } else {
      Reflect.deleteProperty(globalThis, 'fetch');
    }
  });

  it('reads the USDC balance with one standard ERC-20 balanceOf call', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      json: async () => ({ jsonrpc: '2.0', id: 1, result: ENCODED_BALANCE })
    }));
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    await expect(readMockUsdcBalance(ACCOUNT)).resolves.toBe(BALANCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON-RPC request body');
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== 'object') throw new Error('Expected a JSON-RPC request object');
    const params: unknown = Reflect.get(payload, 'params');
    if (!Array.isArray(params) || !params[0] || typeof params[0] !== 'object') {
      throw new Error('Expected eth_call parameters');
    }

    expect(Reflect.get(payload, 'method')).toBe('eth_call');
    expect(Reflect.get(params[0], 'to')).toBe(BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS);
    expect(Reflect.get(params[0], 'data')).toBe(
      encodeFunctionData({ abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [ACCOUNT] })
    );
  });
});
