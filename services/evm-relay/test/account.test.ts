/**
 * @jest-environment node
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  AGGLAYER_DEPOSIT,
  FEE_RECIPIENT,
  NATIVE,
  TEST_EXECUTOR,
  USDC,
  bodyOf,
  chainEntry,
  createHarness,
  readState,
  send,
  type Harness
} from './harness';
import { ChainIntegrityError, RpcUnavailableError } from '../src/chain';

const ADDRESS = `0x${'12'.repeat(20)}`;
const MIXED_CASE_ADDRESS = `0x${'1A'.repeat(20)}`;
const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const SALT = `0x${'00'.repeat(12)}${'ca'.repeat(20)}`;
const CONFIG = JSON.stringify({ chains: { '8453': chainEntry(), '1': chainEntry(false) } });

function harnessFor(gasMode = 'sponsor'): Harness {
  const harness = createHarness({ gasMode, relayConfig: CONFIG });
  harness.reader.state = readState({
    balances: [2_500_000n, 100n],
    sequences: new Map([['agglayer-deposit', 9n]])
  });
  return harness;
}

function accountPath(chainId: string, address: string): string {
  return `/v1/account?chainId=${chainId}&address=${address}`;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /v1/account', () => {
  it('answers the full sponsor response with no fee and no fee recipient', async () => {
    const harness = harnessFor();
    const response = await send(harness, accountPath('8453', MIXED_CASE_ADDRESS), { headers: CALLER });
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
      kinds: { 'agglayer-deposit': { sequence: '9', config: AGGLAYER_DEPOSIT } },
      balances: [
        { token: USDC, balance: '2500000', minAmount: '2000000', fee: '0' },
        { token: NATIVE, balance: '100', minAmount: '1000', fee: '0' }
      ]
    });
    expect(harness.reader.calls).toEqual([{ chainId: 8453, address, kinds: ['agglayer-deposit'] }]);
  });

  it('answers the configured fees and fee recipient in deduct mode', async () => {
    const body = await bodyOf(await send(harnessFor('deduct'), accountPath('8453', ADDRESS)));
    expect(body.mode).toBe('deduct');
    expect(body.feeRecipient).toBe(FEE_RECIPIENT);
    expect(body.balances).toEqual([
      { token: USDC, balance: '2500000', minAmount: '2000000', fee: '100000' },
      { token: NATIVE, balance: '100', minAmount: '1000', fee: '10' }
    ]);
  });

  it('asks for an authorization when the address does not delegate to Calibur', async () => {
    const harness = harnessFor();
    harness.reader.state = { ...harness.reader.state, delegated: false };
    const body = await bodyOf(await send(harness, accountPath('8453', ADDRESS)));
    expect(body.needsAuthorization).toBe(true);
  });

  it('reads no relay kind on a chain without kinds', async () => {
    const harness = harnessFor();
    harness.reader.state = readState({ balances: [1n, 2n] });
    const body = await bodyOf(await send(harness, accountPath('1', ADDRESS)));
    expect(body.kinds).toEqual({});
    expect(harness.reader.calls).toEqual([{ chainId: 1, address: ADDRESS, kinds: [] }]);
  });

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
    ['the relayer address', accountPath('8453', TEST_EXECUTOR.toUpperCase().replace('0X', '0x')), 'invalid_request']
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

  it.each([
    ['RELAYER_PRIVATE_KEY is missing', createHarness({ relayConfig: CONFIG, relayerKey: null })],
    ['RELAY_CONFIG does not parse', createHarness({ relayConfig: '{}' })]
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
