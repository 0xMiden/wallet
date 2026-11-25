/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { encodeFunctionResult, type Hex } from 'viem';

import { CALIBUR_ADDRESS, IMPLEMENTATION_CODE, TEST_RPC_URL, USDC, chainEntry } from './harness';
import { CALIBUR_ABI, ERC20_ABI, nonceKeyOf } from '../../../src/lib/evm-relay/batch';
import { ChainIntegrityError, RpcUnavailableError, createRpcReader, type CachedCode, type Fetcher } from '../src/chain';
import { parseChains, type ChainConfig } from '../src/config';
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

type Failure = 'reject' | 'status' | 'item';
const FAILURES: Failure[] = ['reject', 'status', 'item'];

const DOMAIN: Domain = { name: 'Calibur', version: '1.0.0', chainId: 8453n, verifyingContract: ADDRESS, salt: SALT };

function chainOf(agglayer = true): ChainConfig {
  const chain = parseChains(JSON.stringify({ chains: { '8453': chainEntry(agglayer) } }), 'sponsor').get(8453);
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
    return { jsonrpc: '2.0', id, result: this.resultOf(call) };
  }

  private resultOf({ method, params }: RpcRequest): Hex {
    const [first] = params;
    switch (method) {
      case 'eth_getCode':
        return first === CALIBUR_ADDRESS ? this.implementationCode : this.accountCode;
      case 'eth_getTransactionCount':
        return '0x5';
      case 'eth_getBalance':
        return '0x64';
      default:
        return this.callResult(first);
    }
  }

  private callResult(transaction: unknown): Hex {
    if (!isRecord(transaction) || typeof transaction.data !== 'string') throw new Error('Bad eth_call');
    if (transaction.to === USDC) {
      return encodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', result: 2_500_000n });
    }
    if (transaction.data.startsWith('0x84b0196e')) {
      const { name, version, chainId, verifyingContract, salt } = this.domain;
      return encodeFunctionResult({
        abi: CALIBUR_ABI,
        functionName: 'eip712Domain',
        result: ['0x1f', name, version, chainId, verifyingContract, salt, []]
      });
    }
    return encodeFunctionResult({ abi: CALIBUR_ABI, functionName: 'getSeq', result: 9n });
  }
}

function toRequest(value: unknown): RpcRequest {
  if (!isRecord(value) || typeof value.method !== 'string' || !Array.isArray(value.params)) {
    throw new Error('Bad JSON-RPC call');
  }
  return { method: value.method, params: value.params };
}

function setup(node = new FakeNode(), cache = new Map<string, CachedCode>()) {
  return { node, cache, reader: createRpcReader(ENV, { fetcher: node.fetcher, cache }) };
}

describe('createRpcReader', () => {
  it('reads a delegated address in two batches and sends no state override', async () => {
    const { node, reader } = setup();
    const state = await reader.readAccount(chainOf(), ADDRESS, ['agglayer-deposit']);
    expect(state).toEqual({
      delegated: true,
      authorizationNonce: 5,
      salt: SALT,
      balances: [2_500_000n, 100n],
      sequences: new Map([['agglayer-deposit', 9n]])
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
        getSeq.data.endsWith(nonceKeyOf('agglayer-deposit').toString(16).padStart(64, '0'))
    ).toBe(true);
  });

  it('reads a non-delegated address with the Calibur code as a state override', async () => {
    const node = new FakeNode();
    node.accountCode = '0x';
    const state = await setup(node).reader.readAccount(chainOf(), ADDRESS, ['agglayer-deposit']);
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
    await reader.readAccount(chainOf(), ADDRESS, ['agglayer-deposit']);
    await reader.readAccount(chainOf(), ADDRESS, ['agglayer-deposit']);
    expect(node.batches).toHaveLength(4);
    expect(node.batches[2]?.map(call => call.method)).toEqual([
      'eth_getCode',
      'eth_getTransactionCount',
      'eth_call',
      'eth_getBalance'
    ]);
    expect([...cache.values()].map(entry => entry.code)).toEqual([IMPLEMENTATION_CODE]);
  });

  it('reads only the domain for a chain without relay kinds', async () => {
    const { node, reader } = setup();
    const state = await reader.readAccount(chainOf(false), ADDRESS, []);
    expect(state.sequences.size).toBe(0);
    expect(node.batches[1]).toHaveLength(1);
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
