/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { encodeFunctionData, encodeFunctionResult, erc20Abi, type Hex } from 'viem';

import { CALIBUR_ADDRESS, IMPLEMENTATION_CODE, NATIVE, TEST_RPC_URL, USDC, oneChainConfig } from './harness';
import { CALIBUR_ABI, RELAY_NONCE_KEY } from '../../../src/lib/evm-relay/batch';
import {
  ChainIntegrityError,
  RpcUnavailableError,
  broadcastTransaction,
  createRpcReader,
  maxFeeOf,
  readFees,
  readReceipts,
  type CachedCode,
  type Fetcher,
  type RelayCall
} from '../src/chain';
import { parseRelayConfig, type ChainConfig } from '../src/config';
import { ApiError } from '../src/errors';
import { isRecord } from '../src/http';
import type { Env } from '../src/types';

const ADDRESS: Hex = `0x${'12'.repeat(20)}`;
const SALT: Hex = `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`;
const DELEGATION: Hex = `0xef0100${CALIBUR_ADDRESS.slice(2)}`;
const ENV: Env = Object.assign({ GAS_MODE: 'sponsor' }, { RPC_URL_8453: TEST_RPC_URL });

interface RpcRequest {
  method: string;
  params: unknown[];
}

interface Domain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Hex;
  salt: Hex;
}

interface RpcError {
  code: number;
  message: string;
}

const RELAYER: Hex = `0x${'4e'.repeat(20)}`;
const RAW: Hex = `0x02${'ab'.repeat(40)}`;

type Failure = 'reject' | 'status' | 'item';
const FAILURES: Failure[] = ['reject', 'status', 'item'];

const DOMAIN: Domain = { name: 'Calibur', version: '1.0.0', chainId: 8453n, verifyingContract: ADDRESS, salt: SALT };
const TOKENS: Hex[] = [USDC, NATIVE];

function chainOf(): ChainConfig {
  const chain = parseRelayConfig(oneChainConfig(), 'sponsor', [8453]).chains.get(8453);
  if (chain === undefined) throw new Error('The test chain did not parse');
  return chain;
}

/** A fake RPC node. It records each HTTP request as its list of JSON-RPC calls. */
class FakeNode {
  readonly batches: RpcRequest[][] = [];
  readonly urls: string[] = [];
  accountCode: Hex = DELEGATION;
  implementationCode: Hex = IMPLEMENTATION_CODE;
  domain: Domain = DOMAIN;
  failWith: Failure | null = null;
  estimateError: RpcError | null = null;
  /** The error of every `eth_call`, when it is not null. */
  callError: RpcError | null = null;
  /** The raw `getSeq` result, in place of the encoded sequence 9, when it is not null. */
  sequenceResult: Hex | null = null;
  sendError: RpcError | null = null;
  /** The error of the estimate of the quote batch (from ADDRESS to ADDRESS), when it is not null. */
  selfEstimateError: RpcError | null = null;
  /** The `decimals()` answer of a token: a number, or an error. */
  decimals: number | RpcError = 6;
  /** The `eth_getTransactionReceipt` result of each hash. A missing hash answers null. */
  readonly receipts = new Map<string, unknown>();

  readonly fetcher: Fetcher = async (url, init) => {
    this.urls.push(url);
    const parsed: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (!Array.isArray(parsed)) throw new Error('The request is not a batch');
    const calls = parsed.map(toRequest);
    this.batches.push(calls);
    switch (this.failWith) {
      case 'reject':
        throw new Error(`connect failed: ${url}`);
      case 'status':
        return new Response('busy', { status: 503 });
      default:
        return Response.json(
          calls.map((call, id) =>
            this.failWith === 'item' ? { jsonrpc: '2.0', id, error: { code: -32000 } } : this.answer(call, id)
          )
        );
    }
  };

  private answer(call: RpcRequest, id: number): Record<string, unknown> {
    switch (call.method) {
      case 'eth_feeHistory':
        return { jsonrpc: '2.0', id, result: { oldestBlock: '0x10', baseFeePerGas: ['0x3b9aca00', '0x77359400'] } };
      case 'eth_estimateGas': {
        const [transaction] = call.params;
        const self = isRecord(transaction) && transaction.from === ADDRESS && transaction.to === ADDRESS;
        const error = self && this.selfEstimateError !== null ? this.selfEstimateError : this.estimateError;
        return error === null ? { jsonrpc: '2.0', id, result: '0x30d40' } : { jsonrpc: '2.0', id, error };
      }
      case 'eth_call':
        if (isDecimalsCall(call)) {
          return typeof this.decimals === 'number'
            ? {
                jsonrpc: '2.0',
                id,
                result: encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: this.decimals })
              }
            : { jsonrpc: '2.0', id, error: this.decimals };
        }
        return this.callError === null
          ? { jsonrpc: '2.0', id, result: this.resultOf(call) }
          : { jsonrpc: '2.0', id, error: this.callError };
      case 'eth_getTransactionReceipt':
        return { jsonrpc: '2.0', id, result: this.receipts.get(String(call.params[0])) ?? null };
      case 'eth_sendRawTransaction':
        return this.sendError === null
          ? { jsonrpc: '2.0', id, result: `0x${'77'.repeat(32)}` }
          : { jsonrpc: '2.0', id, error: this.sendError };
      default:
        return { jsonrpc: '2.0', id, result: this.resultOf(call) };
    }
  }

  private resultOf({ method, params }: RpcRequest): Hex {
    const [first] = params;
    switch (method) {
      case 'eth_getCode':
        return first === CALIBUR_ADDRESS ? this.implementationCode : this.accountCode;
      case 'eth_getTransactionCount':
        return first === RELAYER ? '0x9' : '0x5';
      case 'eth_maxPriorityFeePerGas':
        return '0x5f5e100';
      case 'eth_getBalance':
        return '0x64';
      default:
        return this.callResult(first);
    }
  }

  private callResult(transaction: unknown): Hex {
    if (!isRecord(transaction) || typeof transaction.data !== 'string') throw new Error('Bad eth_call');
    if (transaction.to === USDC) {
      return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 2_500_000n });
    }
    if (transaction.data.startsWith('0x84b0196e')) {
      const { name, version, chainId, verifyingContract, salt } = this.domain;
      return encodeFunctionResult({
        abi: CALIBUR_ABI,
        functionName: 'eip712Domain',
        result: ['0x1f', name, version, chainId, verifyingContract, salt, []]
      });
    }
    return this.sequenceResult ?? encodeFunctionResult({ abi: CALIBUR_ABI, functionName: 'getSeq', result: 9n });
  }
}

/** True for an `eth_call` of `decimals()`. */
function isDecimalsCall({ params }: RpcRequest): boolean {
  const [transaction] = params;
  return isRecord(transaction) && transaction.data === DECIMALS_DATA;
}

const DECIMALS_DATA = encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' });

function toRequest(value: unknown): RpcRequest {
  if (!isRecord(value) || typeof value.method !== 'string' || !Array.isArray(value.params)) {
    throw new Error('Bad JSON-RPC call');
  }
  return { method: value.method, params: value.params };
}

function setup(node = new FakeNode(), cache = new Map<string, CachedCode>(), decimals = new Map<string, number>()) {
  return { node, cache, decimals, reader: createRpcReader(ENV, { fetcher: node.fetcher, cache, decimals }) };
}

describe('createRpcReader', () => {
  it('reads a delegated address in two batches and sends no state override', async () => {
    const { node, reader } = setup();
    const state = await reader.readAccount(chainOf(), ADDRESS, TOKENS);
    expect(state).toEqual({
      delegated: true,
      authorizationNonce: 5,
      salt: SALT,
      balances: [2_500_000n, 100n],
      sequence: 9n
    });
    expect(node.urls).toEqual([TEST_RPC_URL, TEST_RPC_URL]);
    const [first, second] = node.batches;
    expect(first?.map(call => call.method)).toEqual([
      'eth_getCode',
      'eth_getTransactionCount',
      'eth_call',
      'eth_getBalance',
      'eth_getCode'
    ]);
    expect(first?.[1]?.params).toEqual([ADDRESS, 'pending']);
    expect(first?.[4]?.params).toEqual([CALIBUR_ADDRESS, 'latest']);
    expect(second?.map(call => call.params.length)).toEqual([2, 2]);
    const getSeq = second?.[0]?.params[0];
    expect(
      isRecord(getSeq) &&
        typeof getSeq.data === 'string' &&
        getSeq.data.endsWith(RELAY_NONCE_KEY.toString(16).padStart(64, '0'))
    ).toBe(true);
  });

  it('reads the balances in the order of the tokens', async () => {
    const { node, reader } = setup();
    const state = await reader.readAccount(chainOf(), ADDRESS, [NATIVE, USDC]);
    expect(state.balances).toEqual([100n, 2_500_000n]);
    expect(node.batches[0]?.map(call => call.method)).toEqual([
      'eth_getCode',
      'eth_getTransactionCount',
      'eth_getBalance',
      'eth_call',
      'eth_getCode'
    ]);
  });

  it('reads no balance and still the sequence and the domain when no token is asked', async () => {
    const { node, reader } = setup();
    const state = await reader.readAccount(chainOf(), ADDRESS, []);
    expect(state.balances).toEqual([]);
    expect(state.sequence).toBe(9n);
    expect(node.batches[0]?.map(call => call.method)).toEqual([
      'eth_getCode',
      'eth_getTransactionCount',
      'eth_getCode'
    ]);
    expect(node.batches[1]).toHaveLength(2);
  });

  it('reads a non-delegated address with the Calibur code as a state override', async () => {
    const node = new FakeNode();
    node.accountCode = '0x';
    const state = await setup(node).reader.readAccount(chainOf(), ADDRESS, TOKENS);
    expect(state.delegated).toBe(false);
    const override = { [ADDRESS]: { code: IMPLEMENTATION_CODE } };
    expect(node.batches[1]?.map(call => call.params[2])).toEqual([override, override]);
  });

  it('treats a delegation to another contract as not delegated', async () => {
    const node = new FakeNode();
    node.accountCode = `0xef0100${'99'.repeat(20)}`;
    expect((await setup(node).reader.readAccount(chainOf(), ADDRESS, [])).delegated).toBe(false);
  });

  it('keeps the verified Calibur code in memory and leaves it out of the next batch', async () => {
    const { node, cache, reader } = setup();
    await reader.readAccount(chainOf(), ADDRESS, TOKENS);
    await reader.readAccount(chainOf(), ADDRESS, TOKENS);
    expect(node.batches).toHaveLength(4);
    expect(node.batches[2]?.map(call => call.method)).toEqual([
      'eth_getCode',
      'eth_getTransactionCount',
      'eth_call',
      'eth_getBalance'
    ]);
    expect([...cache.values()].map(entry => entry.code)).toEqual([IMPLEMENTATION_CODE]);
  });

  it('refuses a Calibur code with another hash after one batch and caches nothing', async () => {
    const node = new FakeNode();
    node.implementationCode = '0x6000';
    const { cache, reader } = setup(node);
    await expect(reader.readAccount(chainOf(), ADDRESS, [])).rejects.toBeInstanceOf(ChainIntegrityError);
    expect(node.batches).toHaveLength(1);
    expect(cache.size).toBe(0);
  });

  const domainChanges: [string, Partial<Domain>][] = [
    ['name', { name: 'Other' }],
    ['version', { version: '2.0.0' }],
    ['chain id', { chainId: 1n }],
    ['verifying contract', { verifyingContract: `0x${'34'.repeat(20)}` }],
    ['salt', { salt: `0x${'00'.repeat(32)}` }]
  ];
  it.each(domainChanges)('refuses a domain with another %s', async (_name, change) => {
    const node = new FakeNode();
    node.domain = { ...DOMAIN, ...change };
    await expect(setup(node).reader.readAccount(chainOf(), ADDRESS, [])).rejects.toBeInstanceOf(ChainIntegrityError);
  });

  it.each(FAILURES)('maps an RPC failure (%s) to RpcUnavailableError', async failWith => {
    const node = new FakeNode();
    node.failWith = failWith;
    const error = await setup(node)
      .reader.readAccount(chainOf(), ADDRESS, [])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect(String(error)).not.toContain('secret');
  });

  it('answers 503 when the chain has no RPC URL', async () => {
    const reader = createRpcReader({}, { fetcher: new FakeNode().fetcher });
    const error = await reader.readAccount(chainOf(), ADDRESS, []).catch((caught: unknown) => caught);
    expect(error instanceof ApiError && error.code).toBe('service_unavailable');
  });
});

describe('readRelay', () => {
  const call: RelayCall = { evmAddress: ADDRESS, relayer: RELAYER, data: '0xabcd', authorization: null };
  const authorization = {
    address: CALIBUR_ADDRESS,
    chainId: 8453,
    nonce: 5,
    r: `0x${'01'.repeat(32)}`,
    s: `0x${'02'.repeat(32)}`,
    yParity: 1
  } satisfies RelayCall['authorization'];

  const getSeq = {
    method: 'eth_call',
    params: [
      {
        to: ADDRESS,
        data: encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'getSeq', args: [RELAY_NONCE_KEY] })
      },
      'latest',
      { [ADDRESS]: { code: DELEGATION } }
    ]
  };

  it('reads the address, the relayer, the fees, the estimate and the sequence in one batch', async () => {
    const { node, reader } = setup();
    await expect(reader.readRelay(chainOf(), call)).resolves.toEqual({
      delegated: true,
      authorizationNonce: 5,
      relayerNonce: 9,
      relayerBalance: 100n,
      baseFee: 2_000_000_000n,
      priorityFee: 100_000_000n,
      gasEstimate: 200_000n,
      sequence: 9n
    });
    expect(node.batches).toHaveLength(1);
    expect(node.batches[0]).toEqual([
      { method: 'eth_getCode', params: [ADDRESS, 'latest'] },
      { method: 'eth_getTransactionCount', params: [ADDRESS, 'pending'] },
      { method: 'eth_getTransactionCount', params: [RELAYER, 'pending'] },
      { method: 'eth_getBalance', params: [RELAYER, 'latest'] },
      { method: 'eth_feeHistory', params: ['0x1', 'latest', []] },
      { method: 'eth_maxPriorityFeePerGas', params: [] },
      { method: 'eth_estimateGas', params: [{ from: RELAYER, to: ADDRESS, data: '0xabcd', value: '0x0' }] },
      getSeq
    ]);
  });

  it.each<[string, Hex]>([
    ['no code', '0x'],
    ['a delegation to another contract', `0xef0100${'99'.repeat(20)}`]
  ])(
    'reads the sequence of an address with %s through the Calibur delegation as a state override',
    async (_name, code) => {
      const node = new FakeNode();
      node.accountCode = code;
      const state = await setup(node).reader.readRelay(chainOf(), call);
      expect(state).toMatchObject({ delegated: false, sequence: 9n });
      expect(node.batches).toHaveLength(1);
      expect(node.batches[0]?.[7]).toEqual(getSeq);
    }
  );

  it.each<[string, RpcError | null, Hex | null]>([
    ['an RPC error', { code: -32000, message: 'execution reverted' }, null],
    ['an empty result', null, '0x'],
    ['a result that is not hex', null, '0xzz']
  ])('maps a getSeq read with %s to RpcUnavailableError', async (_name, callError, sequenceResult) => {
    const node = new FakeNode();
    node.callError = callError;
    node.sequenceResult = sequenceResult;
    await expect(setup(node).reader.readRelay(chainOf(), call)).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it('simulates with the authorization list when the request has an authorization', async () => {
    const node = new FakeNode();
    node.accountCode = '0x';
    const state = await setup(node).reader.readRelay(chainOf(), { ...call, authorization });
    expect(state.delegated).toBe(false);
    expect(node.batches[0]?.[6]?.params).toEqual([
      {
        from: RELAYER,
        to: ADDRESS,
        data: '0xabcd',
        value: '0x0',
        authorizationList: [{ ...authorization, chainId: '0x2105', nonce: '0x5', yParity: '0x1' }]
      }
    ]);
  });

  it.each([
    [3, 'execution reverted'],
    [-32000, 'execution reverted'],
    [-32015, 'VM execution error'],
    [-32000, 'gas required exceeds allowance (30000000)']
  ])('reads an estimate error %d "%s" as a revert', async (code, message) => {
    const node = new FakeNode();
    node.estimateError = { code, message };
    expect((await setup(node).reader.readRelay(chainOf(), call)).gasEstimate).toBeNull();
  });

  it.each([
    [-32603, 'internal error'],
    [-32005, 'request limit exceeded']
  ])('reads an estimate error %d "%s" as an RPC failure', async (code, message) => {
    const node = new FakeNode();
    node.estimateError = { code, message };
    await expect(setup(node).reader.readRelay(chainOf(), call)).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it.each(FAILURES)('maps an RPC failure (%s) to RpcUnavailableError', async failWith => {
    const node = new FakeNode();
    node.failWith = failWith;
    await expect(setup(node).reader.readRelay(chainOf(), call)).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});

describe('createRpcReader fee token decimals of the relay read', () => {
  const call: RelayCall = { evmAddress: ADDRESS, relayer: RELAYER, data: '0xabcd', authorization: null };

  it('asks the fee token for its decimals in the same batch, and then keeps them', async () => {
    const { node, reader, decimals } = setup();
    expect((await reader.readRelay(chainOf(), call, USDC)).feeTokenDecimals).toBe(6);
    expect(node.batches).toHaveLength(1);
    expect(node.batches[0]).toHaveLength(9);
    expect(node.batches[0]?.[8]).toEqual({ method: 'eth_call', params: [{ to: USDC, data: DECIMALS_DATA }, 'latest'] });
    expect(decimals.get(`8453:${USDC}`)).toBe(6);
    expect((await reader.readRelay(chainOf(), call, USDC)).feeTokenDecimals).toBe(6);
    expect(node.batches[1]).toHaveLength(8);
  });

  it('gives 18 for the native coin without a call, and nothing without a fee token', async () => {
    const { node, reader } = setup();
    expect((await reader.readRelay(chainOf(), call, NATIVE)).feeTokenDecimals).toBe(18);
    expect(node.batches[0]).toHaveLength(8);
    const plain = await reader.readRelay(chainOf(), call);
    expect(plain).not.toHaveProperty('feeTokenDecimals');
  });

  it.each<[string, number | RpcError]>([
    ['an error', { code: -32000, message: 'execution reverted' }],
    ['more than 36 decimals', 37]
  ])('maps a decimals() answer of %s to ChainIntegrityError and keeps nothing', async (_name, answer) => {
    const node = new FakeNode();
    node.decimals = answer;
    const { reader, decimals } = setup(node);
    await expect(reader.readRelay(chainOf(), call, USDC)).rejects.toBeInstanceOf(ChainIntegrityError);
    expect(decimals.size).toBe(0);
  });
});

describe('createRpcReader quote read', () => {
  const DATA: Hex = '0x99e1d016abcd';
  const CALIBRATION_ADDRESS: Hex = `0x${'c0'.repeat(20)}`;
  const authorization = {
    address: CALIBUR_ADDRESS,
    chainId: 8453,
    nonce: 0,
    r: `0x${'01'.repeat(32)}`,
    s: `0x${'02'.repeat(32)}`,
    yParity: 0
  } satisfies RelayCall['authorization'];
  const quoteCall = {
    evmAddress: ADDRESS,
    relayer: RELAYER,
    data: DATA,
    feeToken: USDC,
    calibration: { address: CALIBRATION_ADDRESS, selfData: '0x99e1d0', signedData: '0xc3c16e', authorization }
  } satisfies Parameters<ReturnType<typeof createRpcReader>['readQuote']>[1];

  it('reads the code, the fees, the four estimates and the decimals in one batch', async () => {
    const { node, reader } = setup();
    await expect(reader.readQuote(chainOf(), quoteCall)).resolves.toEqual({
      delegated: true,
      baseFee: 2_000_000_000n,
      priorityFee: 100_000_000n,
      batchEstimate: 200_000n,
      calibration: { self: 200_000n, signed: 200_000n, signedWithAuthorization: 200_000n },
      feeTokenDecimals: 6
    });
    expect(node.batches).toHaveLength(1);
    const override = (account: Hex) => ({ [account]: { code: DELEGATION } });
    expect(node.batches[0]).toEqual([
      { method: 'eth_getCode', params: [ADDRESS, 'latest'] },
      { method: 'eth_feeHistory', params: ['0x1', 'latest', []] },
      { method: 'eth_maxPriorityFeePerGas', params: [] },
      {
        method: 'eth_estimateGas',
        params: [{ from: ADDRESS, to: ADDRESS, data: DATA, value: '0x0' }, 'latest', override(ADDRESS)]
      },
      {
        method: 'eth_estimateGas',
        params: [
          { from: CALIBRATION_ADDRESS, to: CALIBRATION_ADDRESS, data: '0x99e1d0', value: '0x0' },
          'latest',
          override(CALIBRATION_ADDRESS)
        ]
      },
      {
        method: 'eth_estimateGas',
        params: [
          { from: RELAYER, to: CALIBRATION_ADDRESS, data: '0xc3c16e', value: '0x0' },
          'latest',
          override(CALIBRATION_ADDRESS)
        ]
      },
      {
        method: 'eth_estimateGas',
        params: [
          {
            from: RELAYER,
            to: CALIBRATION_ADDRESS,
            data: '0xc3c16e',
            value: '0x0',
            authorizationList: [{ ...authorization, chainId: '0x2105', nonce: '0x0', yParity: '0x0' }]
          }
        ]
      },
      { method: 'eth_call', params: [{ to: USDC, data: DECIMALS_DATA }, 'latest'] }
    ]);
  });

  it('reads an address that does not delegate, and asks no decimals for the native coin', async () => {
    const node = new FakeNode();
    node.accountCode = '0x';
    const state = await setup(node).reader.readQuote(chainOf(), { ...quoteCall, feeToken: NATIVE });
    expect(state.delegated).toBe(false);
    expect(state.feeTokenDecimals).toBe(18);
    expect(node.batches[0]).toHaveLength(7);
  });

  it('reads a revert of the batch as a null estimate', async () => {
    const node = new FakeNode();
    node.selfEstimateError = { code: 3, message: 'execution reverted' };
    const state = await setup(node).reader.readQuote(chainOf(), quoteCall);
    expect(state.batchEstimate).toBeNull();
    expect(state.calibration.self).toBe(200_000n);
  });

  it('maps a revert of the calibration batch to ChainIntegrityError', async () => {
    const node = new FakeNode();
    node.estimateError = { code: 3, message: 'execution reverted' };
    await expect(setup(node).reader.readQuote(chainOf(), quoteCall)).rejects.toBeInstanceOf(ChainIntegrityError);
  });

  it.each([
    ['a node error of an estimate', { code: -32602, message: 'too many arguments, want at most 2' }],
    ['a rate limit of an estimate', { code: -32005, message: 'request limit exceeded' }]
  ])('maps %s to RpcUnavailableError: a node without state overrides in eth_estimateGas', async (_name, error) => {
    const node = new FakeNode();
    node.selfEstimateError = error;
    await expect(setup(node).reader.readQuote(chainOf(), quoteCall)).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it.each(FAILURES)('maps an RPC failure (%s) to RpcUnavailableError', async failWith => {
    const node = new FakeNode();
    node.failWith = failWith;
    await expect(setup(node).reader.readQuote(chainOf(), quoteCall)).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});

describe('broadcastTransaction', () => {
  it('sends the signed bytes and treats "already known" as a success', async () => {
    const node = new FakeNode();
    await expect(broadcastTransaction(ENV, 8453, RAW, node.fetcher)).resolves.toBe('accepted');
    node.sendError = { code: -32000, message: 'already known' };
    await expect(broadcastTransaction(ENV, 8453, RAW, node.fetcher)).resolves.toBe('accepted');
    node.sendError = { code: -32010, message: 'AlreadyKnown' };
    await expect(broadcastTransaction(ENV, 8453, RAW, node.fetcher)).resolves.toBe('accepted');
    expect(node.batches).toHaveLength(3);
    expect(node.batches[0]).toEqual([{ method: 'eth_sendRawTransaction', params: [RAW] }]);
  });

  it.each(['nonce too low: next nonce 6, tx nonce 5', 'NONCE_TOO_LOW', 'OldNonce'])(
    'reads "%s" as a nonce that a mined transaction holds',
    async message => {
      const node = new FakeNode();
      node.sendError = { code: -32000, message };
      await expect(broadcastTransaction(ENV, 8453, RAW, node.fetcher)).resolves.toBe('nonce_used');
    }
  );

  it('fails without the URL or the bytes in the error', async () => {
    const node = new FakeNode();
    node.sendError = { code: -32000, message: `insufficient funds for gas ${RAW}` };
    const error = await broadcastTransaction(ENV, 8453, RAW, node.fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect(String(error)).not.toContain('secret');
    expect(String(error)).not.toContain(RAW);
    await expect(broadcastTransaction({}, 8453, RAW, node.fetcher)).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});

describe('readReceipts', () => {
  const MINED: Hex = `0x${'01'.repeat(32)}`;
  const REVERTED: Hex = `0x${'02'.repeat(32)}`;
  const WAITING: Hex = `0x${'03'.repeat(32)}`;

  it('reads every hash in one batch, in hash order', async () => {
    const node = new FakeNode();
    node.receipts.set(MINED, { transactionHash: MINED, status: '0x1' });
    node.receipts.set(REVERTED, { transactionHash: REVERTED, status: '0x0' });
    await expect(readReceipts(ENV, 8453, [MINED, WAITING, REVERTED], node.fetcher)).resolves.toEqual([
      'success',
      null,
      'reverted'
    ]);
    expect(node.batches).toEqual([
      [MINED, WAITING, REVERTED].map(hash => ({ method: 'eth_getTransactionReceipt', params: [hash] }))
    ]);
  });

  it('sends nothing for no hash', async () => {
    const node = new FakeNode();
    await expect(readReceipts(ENV, 8453, [], node.fetcher)).resolves.toEqual([]);
    expect(node.batches).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a receipt without a status', { transactionHash: MINED }],
    ['a receipt that is not an object', '0x1']
  ])('reads %s as an RPC failure', async (_name, receipt) => {
    const node = new FakeNode();
    node.receipts.set(MINED, receipt);
    await expect(readReceipts(ENV, 8453, [MINED], node.fetcher)).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it.each(FAILURES)('maps an RPC failure (%s) to RpcUnavailableError', async failWith => {
    const node = new FakeNode();
    node.failWith = failWith;
    await expect(readReceipts(ENV, 8453, [MINED], node.fetcher)).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});

describe('readFees', () => {
  it('reads the next base fee and the priority fee in one batch', async () => {
    const node = new FakeNode();
    await expect(readFees(ENV, 8453, node.fetcher)).resolves.toEqual({
      baseFee: 2_000_000_000n,
      priorityFee: 100_000_000n
    });
    expect(node.batches).toEqual([
      [
        { method: 'eth_feeHistory', params: ['0x1', 'latest', []] },
        { method: 'eth_maxPriorityFeePerGas', params: [] }
      ]
    ]);
    expect(maxFeeOf({ baseFee: 2n, priorityFee: 1n })).toBe(5n);
  });

  it('fails when the chain has no RPC URL', async () => {
    await expect(readFees({}, 8453, new FakeNode().fetcher)).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});
