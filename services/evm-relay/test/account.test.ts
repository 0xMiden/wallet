/**
 * @jest-environment node
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  FEE_RECIPIENT,
  NATIVE,
  TARGET,
  TEST_EXECUTOR,
  USDC,
  bodyOf,
  chainEntry,
  createHarness,
  readState,
  relayConfigOf,
  send,
  type Harness
} from './harness';
import { ChainIntegrityError, RpcUnavailableError } from '../src/chain';

const ADDRESS = `0x${'12'.repeat(20)}`;
const MIXED_CASE_ADDRESS = `0x${'1A'.repeat(20)}`;
const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const SALT = `0x${'00'.repeat(12)}${'ca'.repeat(20)}`;
const OTHER_TARGET = `0x${'3b'.repeat(20)}`;
/** The USDC of Base: the one default fee token of the chain 8453 (DEFAULT_FEE_TOKENS). */
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CONFIG = relayConfigOf({ '8453': chainEntry(), '1': chainEntry({ allowedTargets: [TARGET, OTHER_TARGET] }) });
/** The chains that the tests serve: each one has an RPC URL. */
const CHAINS = [8453, 1];

function harnessFor(gasMode = 'sponsor'): Harness {
  const harness = createHarness({ gasMode, relayConfig: CONFIG, chains: CHAINS });
  harness.reader.state = readState({ balances: [2_500_000n, 100n], sequence: 9n });
  return harness;
}

function accountPath(chainId: string, address: string, tokens?: string): string {
  const query = tokens === undefined ? '' : `&tokens=${tokens}`;
  return `/v1/account?chainId=${chainId}&address=${address}${query}`;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /v1/account', () => {
  it('answers the full sponsor response with no fee, no fee recipient and the balances of the tokens', async () => {
    const harness = harnessFor();
    const tokens = `${USDC.toUpperCase().replace('0X', '0x')},${NATIVE}`;
    const response = await send(harness, accountPath('8453', MIXED_CASE_ADDRESS, tokens), { headers: CALLER });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=5');
    const address = MIXED_CASE_ADDRESS.toLowerCase();
    await expect(bodyOf(response)).resolves.toEqual({
      chainId: 8453,
      address,
      mode: 'sponsor',
      executor: TEST_EXECUTOR,
      feeRecipient: null,
      needsAuthorization: false,
      authorizationNonce: 3,
      salt: SALT,
      sequence: '9',
      feeTokens: [],
      allowedTargets: null,
      balances: [
        { token: USDC, balance: '2500000' },
        { token: NATIVE, balance: '100' }
      ]
    });
    expect(harness.reader.calls).toEqual([{ chainId: 8453, address, tokens: [USDC, NATIVE] }]);
  });

  it('answers the fee tokens, the native coin first, and the fee recipient in deduct mode', async () => {
    const body = await bodyOf(await send(harnessFor('deduct'), accountPath('8453', ADDRESS, `${USDC},${NATIVE}`)));
    expect(body.mode).toBe('deduct');
    expect(body.feeRecipient).toBe(FEE_RECIPIENT);
    expect(body.feeTokens).toEqual([NATIVE, BASE_USDC, USDC]);
    expect(body).not.toHaveProperty('fees');
  });

  it('answers the default fee tokens of the chain, then the feeTokens of the config in config order', async () => {
    const OTHER = `0x${'bb'.repeat(20)}`;
    const config = relayConfigOf({ '8453': chainEntry({ feeTokens: { [OTHER]: 'BTCUSDT', [USDC]: 'usd' } }) });
    const harness = createHarness({ gasMode: 'deduct', relayConfig: config, chains: [8453] });
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS)));
    expect(body.feeTokens).toEqual([NATIVE, BASE_USDC, OTHER, USDC]);
  });

  it('answers only the native coin for a deduct chain without a fee token', async () => {
    // 999 has no default fee token.
    const config = relayConfigOf({ '999': { nativePrice: 'usd' } });
    const harness = createHarness({ gasMode: 'deduct', relayConfig: config, chains: [999] });
    const body = await bodyOf(await send(harness, accountPath('999', ADDRESS)));
    expect(body.feeTokens).toEqual([NATIVE]);
  });

  it('answers the relayer as the fee recipient, and the default fee tokens, for a deduct config with no values', async () => {
    const config = relayConfigOf({}, { feeRecipient: undefined });
    const harness = createHarness({ gasMode: 'deduct', relayConfig: config, chains: [8453] });
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS)));
    expect(body.mode).toBe('deduct');
    expect(body.feeRecipient).toBe(body.executor);
    expect(body.feeTokens).toEqual([NATIVE, BASE_USDC]);
  });

  it.each(['sponsor', 'deduct'])('answers the allowed targets of the chain in %s mode', async gasMode => {
    const harness = harnessFor(gasMode);
    harness.reader.state = readState();
    const body = await bodyOf(await send(harness, accountPath('1', ADDRESS)));
    expect(body.allowedTargets).toEqual([TARGET, OTHER_TARGET]);
  });

  it('serves a chain that has an RPC URL and no chains entry, with no target list and no fee', async () => {
    const harness = createHarness({ relayConfig: relayConfigOf(), chains: [10] });
    const response = await send(harness, accountPath('10', ADDRESS));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.chainId).toBe(10);
    expect(body.allowedTargets).toBeNull();
    expect(body.feeTokens).toEqual([]);
    expect(harness.reader.calls).toEqual([{ chainId: 10, address: ADDRESS, tokens: [] }]);
  });

  it('refuses a chain that has a chains entry and no RPC URL as unsupported', async () => {
    const harness = createHarness({ relayConfig: CONFIG, chains: [8453] });
    const response = await send(harness, accountPath('1', ADDRESS));
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('unsupported_chain');
    expect(harness.reader.calls).toEqual([]);
  });

  it('answers no balance and reads no token without a tokens parameter', async () => {
    const harness = harnessFor();
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS)));
    expect(body.balances).toEqual([]);
    expect(harness.reader.calls).toEqual([{ chainId: 8453, address: ADDRESS, tokens: [] }]);
  });

  it('reads the balances in query order', async () => {
    const harness = harnessFor();
    harness.reader.state = readState({ balances: [100n, 2_500_000n] });
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS, `${NATIVE},${USDC}`)));
    expect(body.balances).toEqual([
      { token: NATIVE, balance: '100' },
      { token: USDC, balance: '2500000' }
    ]);
    expect(harness.reader.calls[0]?.tokens).toEqual([NATIVE, USDC]);
  });

  it('accepts 16 tokens, a token that the config does not name and the native coin alone', async () => {
    const sixteen = Array.from({ length: 16 }, (_value, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
    const harness = harnessFor();
    harness.reader.state = readState({ balances: sixteen.map(() => 1n) });
    expect((await send(harness, accountPath('8453', ADDRESS, sixteen.join(',')))).status).toBe(200);
    harness.reader.state = readState({ balances: [7n] });
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS, NATIVE)));
    expect(body.balances).toEqual([{ token: NATIVE, balance: '7' }]);
  });

  it('asks for an authorization when the address does not delegate to Calibur', async () => {
    const harness = harnessFor();
    harness.reader.state = { ...harness.reader.state, delegated: false };
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS)));
    expect(body.needsAuthorization).toBe(true);
  });

  it('fails when the reader returns fewer balances than tokens', async () => {
    const harness = harnessFor();
    harness.reader.state = readState({ balances: [] });
    const response = await send(harness, accountPath('8453', ADDRESS, USDC));
    expect(response.status).toBe(500);
    expect((await bodyOf(response)).error).toBe('internal_error');
  });

  const seventeen = Array.from({ length: 17 }, (_value, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
  it.each([
    ['no chainId', `/v1/account?address=${ADDRESS}`, 'invalid_request'],
    ['chainId 0', accountPath('0', ADDRESS), 'invalid_request'],
    ['chainId 01', accountPath('01', ADDRESS), 'invalid_request'],
    ['a chainId that is not a number', accountPath('base', ADDRESS), 'invalid_request'],
    ['a chainId above the safe integers', accountPath('9007199254740993', ADDRESS), 'invalid_request'],
    ['an unknown chain', accountPath('10', ADDRESS), 'unsupported_chain'],
    ['no address', '/v1/account?chainId=8453', 'invalid_request'],
    ['a short address', accountPath('8453', ADDRESS.slice(0, -1)), 'invalid_request'],
    ['an address that is not hex', accountPath('8453', `0x${'zz'.repeat(20)}`), 'invalid_request'],
    ['the relayer address', accountPath('8453', TEST_EXECUTOR.toUpperCase().replace('0X', '0x')), 'invalid_request'],
    ['an empty tokens parameter', accountPath('8453', ADDRESS, ''), 'invalid_request'],
    ['a token that is not an address', accountPath('8453', ADDRESS, `${USDC},usdc`), 'invalid_request'],
    ['a short token', accountPath('8453', ADDRESS, USDC.slice(0, -2)), 'invalid_request'],
    ['an empty token in the list', accountPath('8453', ADDRESS, `${USDC},`), 'invalid_request'],
    ['a token with a space', accountPath('8453', ADDRESS, `${USDC},%20${NATIVE}`), 'invalid_request'],
    [
      'a token repeated in another case',
      accountPath('8453', ADDRESS, `${USDC},${USDC.toUpperCase().replace('0X', '0x')}`),
      'invalid_request'
    ],
    ['17 tokens', accountPath('8453', ADDRESS, seventeen.join(',')), 'invalid_request'],
    ['a second tokens parameter', `${accountPath('8453', ADDRESS, USDC)}&tokens=${NATIVE}`, 'invalid_request']
  ])('answers 400 for %s and reads nothing', async (_name, path, code) => {
    const harness = harnessFor();
    const response = await send(harness, path, { headers: CALLER });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe(code);
    expect(harness.reader.calls).toEqual([]);
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7']);
  });

  it('answers 502 rpc_unavailable when the RPC fails', async () => {
    const harness = harnessFor();
    harness.reader.error = new RpcUnavailableError('The chain RPC does not answer.');
    const response = await send(harness, accountPath('8453', ADDRESS));
    expect(response.status).toBe(502);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'rpc_unavailable',
      message: 'The chain RPC does not answer.'
    });
  });

  it.each([
    ['a Calibur hash mismatch', 'The Calibur runtime hash does not match the pin.'],
    ['an unexpected domain', 'The Calibur signing domain is not the expected domain.']
  ])('answers 503 and logs one line without request data on %s', async (_name, message) => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = harnessFor();
    harness.reader.error = new ChainIntegrityError(message);
    const response = await send(harness, accountPath('8453', ADDRESS));
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'service_unavailable',
      message: 'The service is not available.'
    });
    expect(log.mock.calls).toEqual([[`evm-relay: ${message}`]]);
  });

  it('passes on an unexpected reader failure', async () => {
    const harness = harnessFor();
    harness.reader.error = new Error('unexpected');
    expect((await send(harness, accountPath('8453', ADDRESS))).status).toBe(500);
  });

  it.each([
    ['RELAYER_PRIVATE_KEY is missing', createHarness({ relayConfig: CONFIG, chains: CHAINS, relayerKey: null })],
    ['RELAY_CONFIG does not parse', createHarness({ relayConfig: '{}', chains: CHAINS })],
    [
      'RELAY_CONFIG has the old tokens field',
      createHarness({ relayConfig: relayConfigOf({ '8453': chainEntry({ tokens: {} }) }), chains: CHAINS })
    ],
    [
      'RELAY_CONFIG has the old per-chain Calibur pin',
      createHarness({ relayConfig: relayConfigOf({ '8453': chainEntry({ calibur: {} }) }), chains: CHAINS })
    ],
    [
      // 999 is not in DEFAULT_NATIVE_PRICES, and the config has no entry for it.
      'GAS_MODE is deduct and a served chain has no nativePrice',
      createHarness({ gasMode: 'deduct', relayConfig: relayConfigOf({ '8453': chainEntry() }), chains: [8453, 999] })
    ],
    [
      'RELAY_CONFIG has the old fees field',
      createHarness({ relayConfig: relayConfigOf({ '8453': chainEntry({ fees: {} }) }), chains: CHAINS })
    ],
    ['an RPC_URL_ secret does not name a chain id', createHarness({ relayConfig: CONFIG, rpcUrls: { base: 'x' } })]
  ])('answers 503 when %s', async (_name, harness) => {
    const response = await send(harness, accountPath('8453', ADDRESS));
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe('service_unavailable');
    expect(harness.reader.calls).toEqual([]);
  });
});

describe('GET /v1/account rate limits', () => {
  it('charges the caller IP and then the address on the read binding', async () => {
    const harness = harnessFor();
    await send(harness, accountPath('8453', MIXED_CASE_ADDRESS), { headers: CALLER });
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7', `read-address:${MIXED_CASE_ADDRESS.toLowerCase()}`]);
  });

  it('refuses a read of an address over its budget from another caller IP, before the chain read', async () => {
    const harness = harnessFor();
    harness.readLimit.allow(1);
    expect((await send(harness, accountPath('8453', ADDRESS), { headers: CALLER })).status).toBe(200);
    const other = { 'CF-Connecting-IP': '198.51.100.1' };
    const response = await send(harness, accountPath('8453', ADDRESS), { headers: other });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(harness.reader.calls).toHaveLength(1);
  });
});
