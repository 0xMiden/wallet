/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  CALIBUR_ADDRESS,
  CALIBUR_PIN,
  FEE_RECIPIENT,
  NATIVE,
  TARGET,
  TEST_EXECUTOR,
  USDC,
  bodyOf,
  chainEntry,
  createHarness,
  price,
  quoteState,
  relayConfigOf,
  relayState,
  send,
  type Harness
} from './harness';
import {
  batchNonceOf,
  batchTypedData,
  buildFeeCall,
  type BatchCall,
  type BatchEnvelope
} from '../../../src/lib/evm-relay/batch';
import { ChainIntegrityError, RpcUnavailableError, type RelayAuthorization } from '../src/chain';
import { QUOTE_VALID_SECONDS, exactFee, quotedFee } from '../src/fee';
import { SELF_EXECUTE_ABI, encodeSelfExecution, quoteGasOf } from '../src/quote-gas';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const USER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const EVM: Hex = `0x${USER.address.slice(2).toLowerCase()}`;
const SALT: Hex = `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`;
const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const OTHER_TOKEN: Hex = `0x${'bb'.repeat(20)}`;
const STRANGER: Hex = `0x${'5c'.repeat(20)}`;

const APPROVE: BatchCall = {
  to: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TARGET, 2_000_000n] })
};
const BRIDGE_CALL: BatchCall = { to: TARGET, value: 0n, data: '0xcafe0001deadbeef' };
const CALLS = [APPROVE, BRIDGE_CALL];
const CONFIG = relayConfigOf({ '8453': chainEntry(), '1': chainEntry() });
const TARGETED_CONFIG = relayConfigOf({ '8453': chainEntry({ allowedTargets: [TARGET, USDC] }), '1': chainEntry() });

function wire(calls: readonly BatchCall[]): Record<string, string>[] {
  return calls.map(call => ({ to: call.to, value: call.value.toString(), data: call.data }));
}

function quoteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { chainId: 8453, evmAddress: EVM, calls: wire(CALLS), feeToken: USDC, ...overrides };
}

function harnessFor(gasMode = 'deduct', relayConfig = CONFIG): Harness {
  return createHarness({ gasMode, relayConfig, chains: [8453, 1] });
}

function postQuote(harness: Harness, body: unknown, headers: Record<string, string> = CALLER): Promise<Response> {
  return send(harness, '/v1/quote', { method: 'POST', body: JSON.stringify(body), headers });
}

async function expectError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect((await bodyOf(response)).error).toBe(error);
}

/** The gas and the fee that the quote route must answer for the calls and the fee token. */
function expected(harness: Harness, calls: readonly BatchCall[], token: Hex, authorization: boolean) {
  const quoted = [...calls, buildFeeCall({ token, recipient: FEE_RECIPIENT, amount: 1n })];
  const data = encodeSelfExecution(quoted);
  const state = harness.reader.quote;
  if (state.batchEstimate === null) throw new Error('The test state has no estimate');
  const gas = quoteGasOf({
    batchEstimate: state.batchEstimate,
    calibration: state.calibration,
    authorization,
    calls: quoted.length,
    dataBytes: (data.length - 2) / 2
  });
  const ethPrice = harness.prices.prices.get('ETHUSDT') ?? price('1');
  const fee = quotedFee(
    exactFee({
      gas,
      maxFeePerGas: 2n * state.baseFee + state.priorityFee,
      nativePrice: ethPrice,
      tokenPrice: price('1'),
      tokenDecimals: state.feeTokenDecimals,
      native: token === NATIVE
    })
  );
  return { data, gas, fee };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /v1/quote', () => {
  it('quotes the simulated gas of the calls with a fee call at their end, priced in the fee token', async () => {
    const harness = harnessFor();
    const response = await postQuote(harness, quoteBody());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const { data, gas, fee } = expected(harness, CALLS, USDC, false);
    await expect(bodyOf(response)).resolves.toEqual({
      chainId: 8453,
      token: USDC,
      recipient: FEE_RECIPIENT,
      fee: fee.toString(),
      gas: gas.toString(),
      validUntil: NOW_S + QUOTE_VALID_SECONDS
    });
    // gas = 150000 + 40000 (measured) + 3 calls × 3000 + 2 per byte + 105 × 64.
    expect(gas).toBe(150_000n + 40_000n + 9_000n + 2n * BigInt((data.length - 2) / 2) + 6_720n);

    const [read] = harness.reader.quoteCalls;
    // The calibration batch is empty.
    const calibration = decodeFunctionData({ abi: SELF_EXECUTE_ABI, data: read?.call.calibration.selfData ?? '0x' });
    expect(calibration.args[0].calls).toHaveLength(0);
    expect(read?.chainId).toBe(8453);
    expect(read?.call).toMatchObject({ evmAddress: EVM, relayer: TEST_EXECUTOR, data, feeToken: USDC });
    const decoded = decodeFunctionData({ abi: SELF_EXECUTE_ABI, data: read?.call.data ?? '0x' });
    const last = decoded.args[0].calls[2];
    expect(last?.to.toLowerCase()).toBe(USDC);
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7', `read-address:${EVM}`]);
    expect(harness.relayLimit.keys).toEqual([]);
    expect(harness.prices.requests).toEqual([['ETHUSDT']]);
  });

  it('quotes a fee in the native coin with no price request', async () => {
    const harness = harnessFor();
    harness.reader.quote = quoteState({ feeTokenDecimals: 18 });
    const response = await postQuote(harness, quoteBody({ feeToken: NATIVE }));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.fee).toBe(expected(harness, CALLS, NATIVE, false).fee.toString());
    expect(body.token).toBe(NATIVE);
    expect(harness.prices.requests).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, boolean, boolean]>([
    ['the chain says the address delegates', {}, true, false],
    ['the chain says the address does not delegate', {}, false, true],
    ['the request says true', { authorization: true }, true, true],
    ['the request says false', { authorization: false }, false, false]
  ])('adds the authorization overhead when %s', async (_name, extra, delegated, authorization) => {
    const harness = harnessFor();
    harness.reader.quote = quoteState({ delegated });
    const body = await bodyOf(await postQuote(harness, quoteBody(extra)));
    expect(body.gas).toBe(expected(harness, CALLS, USDC, authorization).gas.toString());
  });

  it('answers 400 fee_not_needed in sponsor mode and reads nothing', async () => {
    const harness = harnessFor('sponsor');
    const response = await postQuote(harness, quoteBody());
    await expectError(response, 400, 'fee_not_needed');
    expect(harness.reader.quoteCalls).toEqual([]);
    expect(harness.prices.requests).toEqual([]);
  });

  it('answers 400 fee_not_needed in sponsor mode for any body', async () => {
    const harness = harnessFor('sponsor');
    await expectError(await postQuote(harness, {}), 400, 'fee_not_needed');
    expect(harness.reader.quoteCalls).toEqual([]);
  });

  const without = (key: string): Record<string, unknown> => {
    const body = quoteBody();
    Reflect.deleteProperty(body, key);
    return body;
  };

  it.each<[string, unknown, number, string]>([
    ['an empty body', {}, 400, 'invalid_request'],
    ['an array body', [], 400, 'invalid_request'],
    ['no calls', without('calls'), 400, 'invalid_request'],
    ['no feeToken', without('feeToken'), 400, 'invalid_request'],
    ['no evmAddress', without('evmAddress'), 400, 'invalid_request'],
    ['an unknown field', quoteBody({ deadline: 1 }), 400, 'invalid_request'],
    ['no call', quoteBody({ calls: [] }), 400, 'invalid_request'],
    ['8 calls', quoteBody({ calls: wire(Array.from({ length: 8 }, () => BRIDGE_CALL)) }), 400, 'invalid_request'],
    ['a call with a bad value', quoteBody({ calls: [{ ...wire(CALLS)[0], value: '-1' }] }), 400, 'invalid_request'],
    ['a string authorization', quoteBody({ authorization: 'yes' }), 400, 'invalid_request'],
    ['a bad feeToken', quoteBody({ feeToken: '0x12' }), 400, 'invalid_request'],
    ['the relayer as evmAddress', quoteBody({ evmAddress: TEST_EXECUTOR }), 400, 'invalid_request'],
    ['an unknown chain', quoteBody({ chainId: 10 }), 400, 'unsupported_chain'],
    ['a token the chain takes no fee in', quoteBody({ feeToken: OTHER_TOKEN }), 400, 'fee_token_not_accepted']
  ])('refuses %s before the chain read and the address charge', async (_name, body, status, error) => {
    const harness = harnessFor();
    await expectError(await postQuote(harness, body), status, error);
    expect(harness.reader.quoteCalls).toEqual([]);
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7']);
  });

  it('accepts 7 calls', async () => {
    const seven = quoteBody({ calls: wire(Array.from({ length: 7 }, () => BRIDGE_CALL)) });
    expect((await postQuote(harnessFor(), seven)).status).toBe(200);
  });

  it('applies the target rule to the calls of the request, not to the fee call', async () => {
    const harness = harnessFor('deduct', TARGETED_CONFIG);
    expect((await postQuote(harness, quoteBody({ feeToken: NATIVE }))).status).toBe(200);
    const stray = quoteBody({ calls: wire([{ ...BRIDGE_CALL, to: STRANGER }]) });
    await expectError(await postQuote(harness, stray), 400, 'target_not_allowed');
  });

  it('answers 409 simulation_failed when the calls revert', async () => {
    const harness = harnessFor();
    harness.reader.quote = quoteState({ batchEstimate: null });
    await expectError(await postQuote(harness, quoteBody()), 409, 'simulation_failed');
    expect(harness.prices.requests).toEqual([]);
  });

  it('answers 503 price_unavailable when no price is available', async () => {
    const harness = harnessFor();
    harness.prices.prices.clear();
    await expectError(await postQuote(harness, quoteBody()), 503, 'price_unavailable');
    expect(harness.prices.requests).toEqual([['ETHUSDT']]);
  });

  it('answers 502 rpc_unavailable when the chain read fails', async () => {
    const harness = harnessFor();
    harness.reader.error = new RpcUnavailableError('The chain RPC does not answer.');
    await expectError(await postQuote(harness, quoteBody()), 502, 'rpc_unavailable');
    expect(harness.prices.requests).toEqual([]);
  });

  it('answers 503 and logs one fixed line when the calibration batch fails', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = harnessFor();
    harness.reader.error = new ChainIntegrityError('The quote calibration batch fails in simulation.');
    await expectError(await postQuote(harness, quoteBody()), 503, 'service_unavailable');
    expect(log.mock.calls).toEqual([['evm-relay: The quote calibration batch fails in simulation.']]);
  });

  it('refuses an address over its read budget from another caller IP, before the chain read', async () => {
    const harness = harnessFor();
    harness.readLimit.allow(1);
    expect((await postQuote(harness, quoteBody())).status).toBe(200);
    const other = { 'CF-Connecting-IP': '198.51.100.1' };
    await expectError(await postQuote(harness, quoteBody(), other), 429, 'rate_limited');
    expect(harness.reader.quoteCalls).toHaveLength(1);
  });

  it('allows only POST', async () => {
    const response = await send(harnessFor(), '/v1/quote', { headers: CALLER });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('a quote and the relay of the same batch', () => {
  async function authorizationOf(nonce: number): Promise<RelayAuthorization> {
    const signed = await USER.signAuthorization({ address: CALIBUR_ADDRESS, chainId: 8453, nonce });
    if (typeof signed.yParity !== 'number') throw new Error('The authorization has no yParity');
    return { address: CALIBUR_ADDRESS, chainId: 8453, nonce, r: signed.r, s: signed.s, yParity: signed.yParity };
  }

  /** The relay body of the calls with the quoted fee as the last call, signed by the user. */
  async function relayBody(calls: readonly BatchCall[], token: Hex, fee: bigint, authorization: boolean) {
    const signedCalls = [...calls, buildFeeCall({ token, recipient: FEE_RECIPIENT, amount: fee })];
    const envelope: BatchEnvelope = {
      chainId: 8453,
      evmAddress: EVM,
      executor: TEST_EXECUTOR,
      batchNonce: batchNonceOf(7n),
      salt: SALT,
      deadline: BigInt(NOW_S + 600)
    };
    const signature = await USER.signTypedData(batchTypedData(CALIBUR_PIN, envelope, signedCalls));
    const body: Record<string, unknown> = {
      chainId: 8453,
      evmAddress: EVM,
      calls: wire(signedCalls),
      batchNonce: envelope.batchNonce.toString(),
      salt: SALT,
      deadline: NOW_S + 600,
      signature
    };
    if (authorization) body.authorization = await authorizationOf(3);
    return body;
  }

  interface Scenario {
    name: string;
    calls: BatchCall[];
    token: Hex;
    baseFee: bigint;
    priorityFee: bigint;
    ethPrice: string;
    delegated: boolean;
    batchEstimate: bigint;
  }

  const scenarios: Scenario[] = [
    {
      name: 'USDC on a cheap chain',
      calls: CALLS,
      token: USDC,
      baseFee: 5_000_000n,
      priorityFee: 1_000_000n,
      ethPrice: '3456.78',
      delegated: true,
      batchEstimate: 120_000n
    },
    {
      name: 'USDC at a high gas price, with an authorization',
      calls: CALLS,
      token: USDC,
      baseFee: 80_000_000_000n,
      priorityFee: 2_000_000_000n,
      ethPrice: '1999.99',
      delegated: false,
      batchEstimate: 310_000n
    },
    {
      name: 'the native coin with 7 calls',
      calls: Array.from({ length: 7 }, () => BRIDGE_CALL),
      token: NATIVE,
      baseFee: 1_000_000_000n,
      priorityFee: 100_000_000n,
      ethPrice: '2500',
      delegated: true,
      batchEstimate: 400_000n
    },
    {
      name: 'a large call',
      calls: [{ to: TARGET, value: 0n, data: `0x${'ab'.repeat(20_000)}` }],
      token: USDC,
      baseFee: 30_000_000n,
      priorityFee: 1_000_000n,
      ethPrice: '1234.5',
      delegated: true,
      batchEstimate: 900_000n
    }
  ];

  /**
   * Quote the batch, then relay the same batch with the quoted fee at the same gas price, when the relay's own estimate
   * of the signed batch is `relayGas(quoteGas)`. Return the relay response.
   */
  async function quoteThenRelay(scenario: Scenario, relayGas: (quoteGas: bigint) => bigint): Promise<Response> {
    const harness = harnessFor();
    const fees = { baseFee: scenario.baseFee, priorityFee: scenario.priorityFee };
    harness.prices.prices.set('ETHUSDT', price(scenario.ethPrice));
    harness.reader.quote = quoteState({
      ...fees,
      delegated: scenario.delegated,
      batchEstimate: scenario.batchEstimate,
      feeTokenDecimals: scenario.token === NATIVE ? 18 : 6
    });
    const request = quoteBody({ calls: wire(scenario.calls), feeToken: scenario.token });
    const quote = await bodyOf(await postQuote(harness, request));
    if (typeof quote.fee !== 'string' || typeof quote.gas !== 'string') throw new Error('The quote failed');
    harness.reader.relay = relayState({
      ...fees,
      delegated: scenario.delegated,
      gasEstimate: relayGas(BigInt(quote.gas)),
      relayerBalance: 10n ** 30n
    });
    const body = await relayBody(scenario.calls, scenario.token, BigInt(quote.fee), !scenario.delegated);
    return send(harness, '/v1/relay', { method: 'POST', body: JSON.stringify(body), headers: CALLER });
  }

  it.each(scenarios)(
    'accepts the quoted fee for $name when the relay estimate is the quoted gas plus the 1.5 % estimator slack',
    async scenario => {
      // The quote gas bounds the signed batch's gas (quote-gas.ts); a node's eth_estimateGas answers up to 1.5 % above
      // the exact gas (Geth stops its search within that ratio). The relay estimate here is that worst case.
      const response = await quoteThenRelay(scenario, quoteGas => (quoteGas * 1015n + 999n) / 1000n);
      expect(response.status).toBe(200);
      expect((await bodyOf(response)).state).toBe('pending');
    }
  );

  it.each(scenarios)(
    'accepts the quoted fee for $name up to the last estimate that the margins cover, and refuses one more',
    async scenario => {
      // The quoted fee is fee(G) × 1.15 and the relay takes fee(R) × 0.95, so any R ≤ G × 115 / 95 passes.
      const limit = (quoteGas: bigint): bigint => (quoteGas * 115n) / 95n;
      expect((await quoteThenRelay(scenario, limit)).status).toBe(200);
      const beyond = await quoteThenRelay(scenario, quoteGas => (limit(quoteGas) * 102n) / 100n);
      expect(beyond.status).toBe(400);
      const body = await bodyOf(beyond);
      expect(body.error).toBe('fee_too_low');
      expect(body.token).toBe(scenario.token);
    }
  );
});
