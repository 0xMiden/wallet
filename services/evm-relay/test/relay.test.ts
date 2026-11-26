/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import {
  CALIBUR_ADDRESS,
  FEE_RECIPIENT,
  IMPLEMENTATION_CODE,
  NATIVE,
  TARGET,
  TEST_EXECUTOR,
  USDC,
  bodyOf,
  chainEntry,
  createHarness,
  relayConfigOf,
  relayState,
  send,
  transactionSigner,
  type Harness
} from './harness';
import {
  CALIBUR_ABI,
  RELAY_NONCE_KEY,
  batchDigest,
  batchNonceOf,
  batchTypedData,
  buildFeeCall,
  encodeExecution,
  type BatchCall,
  type BatchEnvelope,
  type RelayFee
} from '../../../src/lib/evm-relay/batch';
import { RpcUnavailableError, type RelayAuthorization } from '../src/chain';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const USER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const EVM: Hex = `0x${USER.address.slice(2).toLowerCase()}`;
const SALT: Hex = `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`;
const PIN = {
  address: CALIBUR_ADDRESS,
  runtimeHash: keccak256(IMPLEMENTATION_CODE),
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};
const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** An address that no config of the tests names. */
const STRANGER: Hex = `0x${'5c'.repeat(20)}`;
const OTHER_TOKEN: Hex = `0x${'bb'.repeat(20)}`;

/** The chains that the tests serve: each one has an RPC URL. */
const CHAINS = [8453, 1];
/** Chain 8453 allows any target. */
const OPEN_CONFIG = relayConfigOf({ '8453': chainEntry(), '1': chainEntry() });
/** Chain 8453 allows only the bridge target and USDC. */
const TARGETED_CONFIG = relayConfigOf({ '8453': chainEntry({ allowedTargets: [TARGET, USDC] }), '1': chainEntry() });

/** The calls that a bridge flow asks the wallet to send: an approval of USDC, then the bridge call. */
const APPROVE: BatchCall = {
  to: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TARGET, 2_000_000n] })
};
const BRIDGE_CALL: BatchCall = { to: TARGET, value: 0n, data: '0xcafe0001deadbeef' };
/** The configured native fee of the test chains: 10 wei to the fee recipient. */
const NATIVE_FEE_VALUES: RelayFee = { token: NATIVE, recipient: FEE_RECIPIENT, amount: 10n };
const NATIVE_FEE = buildFeeCall(NATIVE_FEE_VALUES);

/** An ERC-20 fee call that pays `amount` of USDC to the fee recipient. The configured USDC fee is 100000. */
function usdcFee(amount: bigint): BatchCall {
  return buildFeeCall({ token: USDC, recipient: FEE_RECIPIENT, amount });
}

const USDC_FEE = usdcFee(100_000n);
const SPONSOR_CALLS = [APPROVE, BRIDGE_CALL];
const DEDUCT_CALLS = [APPROVE, BRIDGE_CALL, USDC_FEE];

interface Draft {
  calls: BatchCall[];
  deadline: number;
  batchNonce: bigint;
  signer: PrivateKeyAccount;
}

interface Signed {
  body: Record<string, unknown>;
  id: Hex;
  data: Hex;
  calls: BatchCall[];
}

/** The calls as the wire carries them. */
function wire(calls: readonly BatchCall[]): Record<string, string>[] {
  return calls.map(call => ({ to: call.to, value: call.value.toString(), data: call.data }));
}

/** A request body that the wallet would send, signed by `signer` over `calls`. */
async function signed(overrides: Partial<Draft> = {}): Promise<Signed> {
  const value: Draft = {
    calls: SPONSOR_CALLS,
    deadline: NOW_S + 600,
    batchNonce: batchNonceOf(7n),
    signer: USER,
    ...overrides
  };
  const envelope: BatchEnvelope = {
    chainId: 8453,
    evmAddress: EVM,
    executor: TEST_EXECUTOR,
    batchNonce: value.batchNonce,
    salt: SALT,
    deadline: BigInt(value.deadline)
  };
  const signature = await value.signer.signTypedData(batchTypedData(PIN, envelope, value.calls));
  const body = {
    chainId: 8453,
    evmAddress: EVM,
    calls: wire(value.calls),
    batchNonce: value.batchNonce.toString(),
    salt: SALT,
    deadline: value.deadline,
    signature
  };
  return {
    body,
    id: batchDigest(PIN, envelope, value.calls),
    data: encodeExecution(envelope, value.calls, signature),
    calls: value.calls
  };
}

async function authorizationOf(
  nonce = 3,
  signer: PrivateKeyAccount = USER,
  address: Hex = CALIBUR_ADDRESS,
  chainId = 8453
): Promise<RelayAuthorization> {
  const authorization = await signer.signAuthorization({ address, chainId, nonce });
  if (typeof authorization.yParity !== 'number') throw new Error('The authorization has no yParity');
  return { address, chainId, nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
}

function harnessFor(gasMode = 'sponsor', relayConfig = OPEN_CONFIG): Harness {
  return createHarness({ gasMode, relayConfig, chains: CHAINS });
}

function post(harness: Harness, body: unknown, headers: Record<string, string> = CALLER): Promise<Response> {
  return send(harness, '/v1/relay', { method: 'POST', body: JSON.stringify(body), headers });
}

/** The one transaction that the test Sender of chain 8453 broadcast. */
function broadcastRaw(harness: Harness): Hex {
  expect(harness.senders.broadcasts).toHaveLength(1);
  const raw = harness.senders.broadcasts[0]?.raw;
  if (raw === undefined) throw new Error('Nothing was broadcast');
  return raw;
}

/** The calls that `execute` calldata carries, in calldata order. */
function executedCalls(data: Hex): readonly { to: string; value: bigint; data: string }[] {
  const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data });
  if (decoded.functionName !== 'execute') throw new Error('The calldata is not execute');
  return decoded.args[0].batchedCall.calls;
}

async function expectError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect((await bodyOf(response)).error).toBe(error);
}

/** What the route did with a request: its status and error code, the chain reads, the rate limit keys, the broadcasts. */
interface Outcome {
  status: number;
  error: unknown;
  chainReads: number;
  limitKeys: string[];
  broadcasts: number;
}

async function outcomeOf(harness: Harness, body: unknown): Promise<Outcome> {
  const response = await post(harness, body);
  return {
    status: response.status,
    error: (await bodyOf(response)).error,
    chainReads: harness.reader.relayCalls.length,
    limitKeys: harness.relayLimit.keys,
    broadcasts: harness.senders.broadcasts.length
  };
}

/** A refusal before the chain read: the route read no chain, did not charge the address and sent nothing. */
function refused(status: number, error: string): Outcome {
  return { status, error, chainReads: 0, limitKeys: ['relay:203.0.113.7'], broadcasts: 0 };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /v1/relay', () => {
  it('relays a sponsored batch of the calls as sent, as a type 2 transaction, and answers pending', async () => {
    const harness = harnessFor();
    const { body, id, data } = await signed();
    const response = await post(harness, body);
    expect(response.status).toBe(200);
    const raw = broadcastRaw(harness);
    await expect(bodyOf(response)).resolves.toEqual({ id, state: 'pending', txHash: keccak256(raw) });
    expect(harness.reader.relayCalls).toEqual([
      { chainId: 8453, call: { evmAddress: EVM, relayer: TEST_EXECUTOR, data, authorization: null } }
    ]);
    expect(harness.relayLimit.keys).toEqual(['relay:203.0.113.7', `relay-address:${EVM}`]);
    // The row was stored before the broadcast.
    expect(harness.senders.broadcasts[0]?.storedRows).toBe(1);
    expect(harness.senders.rows(8453).map(row => [row.id, row.nonce, row.state])).toEqual([[id, 5, 'pending']]);

    const transaction = parseTransaction(raw);
    expect(transaction).toMatchObject({
      type: 'eip1559',
      chainId: 8453,
      nonce: 5,
      to: EVM,
      data,
      gas: 240_000n,
      maxFeePerGas: 2_100_000_000n,
      maxPriorityFeePerGas: 100_000_000n
    });
    expect(transaction.value ?? 0n).toBe(0n);
    await expect(transactionSigner(raw)).resolves.toBe(TEST_EXECUTOR);
    expect(executedCalls(data).map(call => [call.to.toLowerCase(), call.value, call.data])).toEqual(
      SPONSOR_CALLS.map(call => [call.to, call.value, call.data])
    );
  });

  it('relays one call with a value and no data', async () => {
    const harness = harnessFor();
    const { body, id } = await signed({ calls: [{ to: TARGET, value: 5n, data: '0x' }] });
    const response = await post(harness, body);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).id).toBe(id);
  });

  it('relays 8 calls', async () => {
    const { body } = await signed({ calls: Array.from({ length: 8 }, () => BRIDGE_CALL) });
    expect((await post(harnessFor(), body)).status).toBe(200);
  });

  it('reads the addresses and the data in any case and gives the same id', async () => {
    const harness = harnessFor();
    const { body, id } = await signed();
    const upper = SPONSOR_CALLS.map(call => ({
      to: `0x${call.to.slice(2).toUpperCase()}`,
      value: call.value.toString(),
      data: `0x${call.data.slice(2).toUpperCase()}`
    }));
    const response = await post(harness, { ...body, calls: upper });
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).id).toBe(id);
  });

  it('applies no fee rule in sponsor mode: a batch that pays a fee to anyone relays', async () => {
    const { body } = await signed({
      calls: [BRIDGE_CALL, buildFeeCall({ ...NATIVE_FEE_VALUES, recipient: STRANGER })]
    });
    expect((await post(harnessFor(), body)).status).toBe(200);
  });

  it.each([
    ['an ERC-20 fee call of the configured fee', DEDUCT_CALLS],
    ['an ERC-20 fee call above the configured fee', [APPROVE, BRIDGE_CALL, usdcFee(150_000n)]],
    ['a native fee call of the configured fee', [BRIDGE_CALL, NATIVE_FEE]],
    ['a native fee call above the configured fee', [BRIDGE_CALL, buildFeeCall({ ...NATIVE_FEE_VALUES, amount: 11n })]]
  ])('relays a deduct batch with %s as the last call', async (_name, calls) => {
    const harness = harnessFor('deduct');
    const { body, id, data } = await signed({ calls });
    const response = await post(harness, body);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).id).toBe(id);
    expect(parseTransaction(broadcastRaw(harness)).data).toBe(data);
  });

  it('sends a type 4 transaction with the authorization when the address does not delegate', async () => {
    const harness = harnessFor();
    harness.reader.relay = relayState({ delegated: false, authorizationNonce: 3 });
    const authorization = await authorizationOf(3);
    const { body, data } = await signed();
    expect((await post(harness, { ...body, authorization })).status).toBe(200);
    expect(harness.reader.relayCalls[0]?.call).toEqual({
      evmAddress: EVM,
      relayer: TEST_EXECUTOR,
      data,
      authorization
    });
    const transaction = parseTransaction(broadcastRaw(harness));
    expect(transaction.type).toBe('eip7702');
    expect(transaction.to).toBe(EVM);
    expect(transaction.authorizationList).toEqual([{ ...authorization, v: BigInt(authorization.yParity) + 27n }]);
  });

  it('sends no authorization for an address that already delegates', async () => {
    const harness = harnessFor();
    const { body } = await signed();
    expect((await post(harness, { ...body, authorization: await authorizationOf(3) })).status).toBe(200);
    expect(parseTransaction(broadcastRaw(harness)).type).toBe('eip1559');
  });

  it.each([
    ['no authorization', null],
    ['an authorization with an old nonce', 2]
  ])('answers stale_request for an address that does not delegate and %s', async (_name, nonce) => {
    const harness = harnessFor();
    harness.reader.relay = relayState({ delegated: false, authorizationNonce: 3 });
    const { body } = await signed();
    const request = nonce === null ? body : { ...body, authorization: await authorizationOf(nonce) };
    await expectError(await post(harness, request), 409, 'stale_request');
    expect(harness.senders.rows(8453)).toEqual([]);
  });

  it('returns the stored relay for the same request without a chain read or a second transaction', async () => {
    const harness = harnessFor();
    const { body, id } = await signed();
    const first = await bodyOf(await post(harness, body));
    const again = await bodyOf(await post(harness, body));
    expect(again).toEqual(first);
    expect(harness.reader.relayCalls).toHaveLength(1);
    expect(harness.senders.rows(8453)).toHaveLength(1);
    expect(harness.senders.broadcasts).toHaveLength(1);

    harness.senders.databases.get(8453)?.run("UPDATE inflight SET state = 'succeeded'");
    await expect(bodyOf(await post(harness, body))).resolves.toEqual({ ...first, id, state: 'succeeded' });
  });

  it('answers busy with the id of the open relay for another batch of the address', async () => {
    const harness = harnessFor();
    const first = await signed();
    await post(harness, first.body);
    const second = await signed({ deadline: NOW_S + 900 });
    const response = await post(harness, second.body);
    expect(response.status).toBe(409);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'busy',
      message: 'Another relay of the address is open.',
      id: first.id
    });
    expect(harness.senders.rows(8453)).toHaveLength(1);
  });

  it('answers 200 pending and keeps the row when the broadcast fails', async () => {
    const harness = harnessFor();
    harness.senders.broadcastError = new Error('node down');
    const { body } = await signed();
    const response = await post(harness, body);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).state).toBe('pending');
    expect(harness.senders.rows(8453).map(row => [row.state, row.raw_tx])).toEqual([
      ['pending', broadcastRaw(harness)]
    ]);
  });

  it('answers 409 simulation_failed when the batch reverts', async () => {
    const harness = harnessFor();
    harness.reader.relay = relayState({ gasEstimate: null });
    await expectError(await post(harness, (await signed()).body), 409, 'simulation_failed');
    expect(harness.senders.rows(8453)).toEqual([]);
  });

  it.each([
    ['delegates, and the chain used the sequence', true, 8n],
    ['delegates, and the chain has not reached the sequence', true, 6n],
    ['does not delegate, and the stored sequence of an earlier delegation is higher', false, 8n],
    ['does not delegate, and the chain has not reached the sequence', false, 6n]
  ])('answers stale_request, not simulation_failed, when the address %s', async (_name, delegated, sequence) => {
    const harness = harnessFor();
    // The simulation of a stale batch reverts. The sequence check comes first.
    harness.reader.relay = relayState({ delegated, authorizationNonce: 3, sequence, gasEstimate: null });
    const { body } = await signed();
    const request = delegated ? body : { ...body, authorization: await authorizationOf(3) };
    const response = await post(harness, request);
    expect(response.status).toBe(409);
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'stale_request',
      message: 'The batch nonce is not the current Calibur sequence. Read the account and sign again.'
    });
    expect(harness.reader.relayCalls).toHaveLength(1);
    expect(harness.senders.rows(8453)).toEqual([]);
    expect(harness.senders.broadcasts).toEqual([]);
  });

  it('compares only the low 64 bits of batchNonce with the sequence', async () => {
    const harness = harnessFor();
    harness.reader.relay = relayState({ sequence: 2n ** 64n - 1n });
    const { body } = await signed({ batchNonce: batchNonceOf(2n ** 64n - 1n) });
    expect((await post(harness, body)).status).toBe(200);
  });

  it('answers 502 rpc_unavailable when the chain read fails', async () => {
    const harness = harnessFor();
    harness.reader.error = new RpcUnavailableError('The chain RPC does not answer.');
    await expectError(await post(harness, (await signed()).body), 502, 'rpc_unavailable');
    expect(harness.senders.rows(8453)).toEqual([]);
  });

  it('answers 500 for an unexpected chain read failure', async () => {
    const harness = harnessFor();
    harness.reader.error = new Error('unexpected');
    const response = await post(harness, (await signed()).body);
    expect(response.status).toBe(500);
    expect(harness.senders.rows(8453)).toEqual([]);
  });

  it('answers 503 relayer_unfunded and logs one fixed line when the relayer cannot pay the gas', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = harnessFor();
    // gas 240000 at 2.1 gwei is the cost; one wei less is not enough.
    harness.reader.relay = relayState({ relayerBalance: 240_000n * 2_100_000_000n - 1n });
    await expectError(await post(harness, (await signed()).body), 503, 'relayer_unfunded');
    expect(log.mock.calls).toEqual([['evm-relay: the relayer account cannot pay the gas on chain 8453.']]);
    expect(harness.senders.rows(8453)).toEqual([]);

    harness.reader.relay = relayState({ relayerBalance: 240_000n * 2_100_000_000n });
    expect((await post(harness, (await signed()).body)).status).toBe(200);
  });

  it('charges the address after the checks and refuses an address over its budget before the chain read', async () => {
    const harness = harnessFor();
    harness.relayLimit.allow(1);
    const { body } = await signed();
    expect((await post(harness, body)).status).toBe(200);
    await expectError(await post(harness, body, { 'CF-Connecting-IP': '198.51.100.1' }), 429, 'rate_limited');
    expect(harness.reader.relayCalls).toHaveLength(1);
  });

  it('answers 503 when the relayer key is missing', async () => {
    const harness = createHarness({ relayConfig: OPEN_CONFIG, chains: CHAINS, relayerKey: null });
    const response = await post(harness, (await signed()).body);
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe('service_unavailable');
  });
});

describe('POST /v1/relay allowed targets', () => {
  it('relays a sponsored batch whose every call goes to an allowed target', async () => {
    const harness = harnessFor('sponsor', TARGETED_CONFIG);
    expect((await post(harness, (await signed()).body)).status).toBe(200);
  });

  it.each([
    ['the first call', [{ ...BRIDGE_CALL, to: STRANGER }, BRIDGE_CALL]],
    ['the last call', [APPROVE, { ...BRIDGE_CALL, to: STRANGER }]],
    ['a fee-shaped last call, which sponsor mode does not exempt', [BRIDGE_CALL, NATIVE_FEE]]
  ])('refuses in sponsor mode a call to another target in %s', async (_name, calls) => {
    const harness = harnessFor('sponsor', TARGETED_CONFIG);
    expect(await outcomeOf(harness, (await signed({ calls })).body)).toEqual(refused(400, 'target_not_allowed'));
  });

  it.each([
    ['an ERC-20 fee call', DEDUCT_CALLS],
    ['a native fee call to the fee recipient, which is not a target', [BRIDGE_CALL, NATIVE_FEE]]
  ])('exempts the verified fee call of a deduct batch: %s', async (_name, calls) => {
    const harness = harnessFor('deduct', TARGETED_CONFIG);
    expect((await post(harness, (await signed({ calls })).body)).status).toBe(200);
  });

  it('exempts the fee call when the fee token is not an allowed target', async () => {
    const config = relayConfigOf({ '8453': chainEntry({ allowedTargets: [TARGET] }), '1': chainEntry() });
    const harness = harnessFor('deduct', config);
    expect((await post(harness, (await signed({ calls: [BRIDGE_CALL, USDC_FEE] })).body)).status).toBe(200);
  });

  it.each([
    ['a call before the fee call', [{ ...BRIDGE_CALL, to: STRANGER }, USDC_FEE]],
    ['a fee-shaped call that is not the last call', [NATIVE_FEE, BRIDGE_CALL, USDC_FEE]]
  ])('refuses in deduct mode %s to another target', async (_name, calls) => {
    const harness = harnessFor('deduct', TARGETED_CONFIG);
    expect(await outcomeOf(harness, (await signed({ calls })).body)).toEqual(refused(400, 'target_not_allowed'));
  });
});

describe('POST /v1/relay fee rule in deduct mode', () => {
  const approveToRecipient: BatchCall = {
    to: USDC,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FEE_RECIPIENT, 100_000n] })
  };
  const cases: [string, BatchCall[]][] = [
    ['a last call that is not a fee call', [USDC_FEE, BRIDGE_CALL]],
    ['an ERC-20 fee below the configured fee', [BRIDGE_CALL, usdcFee(99_999n)]],
    ['a native fee below the configured fee', [BRIDGE_CALL, buildFeeCall({ ...NATIVE_FEE_VALUES, amount: 9n })]],
    ['a fee to another recipient', [BRIDGE_CALL, buildFeeCall({ token: USDC, recipient: STRANGER, amount: 100_000n })]],
    [
      'a fee in a token that has no fee',
      [BRIDGE_CALL, buildFeeCall({ token: OTHER_TOKEN, recipient: FEE_RECIPIENT, amount: 100_000n })]
    ],
    ['an ERC-20 approval of the fee recipient', [BRIDGE_CALL, approveToRecipient]],
    ['a native transfer of 0', [BRIDGE_CALL, { to: FEE_RECIPIENT, value: 0n, data: '0x' }]],
    ['an ERC-20 transfer that also sends a value', [BRIDGE_CALL, { ...USDC_FEE, value: 1n }]],
    ['a last call with data that is not an ERC-20 call', [APPROVE, { to: USDC, value: 0n, data: '0x1234' }]]
  ];

  it.each(cases)('refuses %s with fee_too_low', async (_name, calls) => {
    expect(await outcomeOf(harnessFor('deduct'), (await signed({ calls })).body)).toEqual(refused(400, 'fee_too_low'));
  });

  it.each([
    ['only the fee call', [USDC_FEE]],
    ['only another call', [BRIDGE_CALL]]
  ])('refuses a deduct batch of %s as invalid_request', async (_name, calls) => {
    const outcome = await outcomeOf(harnessFor('deduct'), (await signed({ calls })).body);
    expect(outcome).toEqual(refused(400, 'invalid_request'));
  });
});

describe('POST /v1/relay refusals', () => {
  type Mutation = (body: Record<string, unknown>) => unknown;
  const without = (body: Record<string, unknown>, key: string): Record<string, unknown> => {
    const copy = { ...body };
    Reflect.deleteProperty(copy, key);
    return copy;
  };
  /** Replace the first call of the body with the result of `change`. */
  const firstCall =
    (change: (call: Record<string, string>) => unknown): Mutation =>
    body => {
      const [first, ...rest] = wire(SPONSOR_CALLS);
      if (first === undefined) throw new Error('No call');
      return { ...body, calls: [change(first), ...rest] };
    };

  const malformed: [string, Mutation][] = [
    ['an array body', () => []],
    ['no signature', body => without(body, 'signature')],
    ['no calls', body => without(body, 'calls')],
    ['an unknown field', body => ({ ...body, bridge: 'deposit' })],
    ['the old params field', body => ({ ...body, params: {} })],
    ['a string chainId', body => ({ ...body, chainId: '8453' })],
    ['chainId 0', body => ({ ...body, chainId: 0 })],
    ['a bad evmAddress', body => ({ ...body, evmAddress: '0x12' })],
    ['a numeric batchNonce', body => ({ ...body, batchNonce: 7 })],
    ['a batchNonce of 2^256', body => ({ ...body, batchNonce: (2n ** 256n).toString() })],
    ['a short salt', body => ({ ...body, salt: '0x00' })],
    ['a string deadline', body => ({ ...body, deadline: String(NOW_S + 600) })],
    ['a fractional deadline', body => ({ ...body, deadline: NOW_S + 600.5 })],
    ['a 64-byte signature', body => ({ ...body, signature: `0x${'11'.repeat(64)}` })],
    ['calls that are an object', body => ({ ...body, calls: {} })],
    ['no call', body => ({ ...body, calls: [] })],
    ['9 calls', body => ({ ...body, calls: wire(Array.from({ length: 9 }, () => BRIDGE_CALL)) })],
    ['a call that is not an object', body => ({ ...body, calls: ['0x'] })],
    ['a call without data', firstCall(call => without(call, 'data'))],
    ['a call without to', firstCall(call => without(call, 'to'))],
    ['a call without value', firstCall(call => without(call, 'value'))],
    ['a call with an unknown field', firstCall(call => ({ ...call, gas: '100000' }))],
    ['a call to the zero address', firstCall(call => ({ ...call, to: NATIVE }))],
    ['a call to a short address', firstCall(call => ({ ...call, to: '0x12' }))],
    ['a numeric value', firstCall(call => ({ ...call, value: 0 }))],
    ['a negative value', firstCall(call => ({ ...call, value: '-1' }))],
    ['a value with a leading zero', firstCall(call => ({ ...call, value: '01' }))],
    ['a hex value', firstCall(call => ({ ...call, value: '0x1' }))],
    ['a value of 2^256', firstCall(call => ({ ...call, value: (2n ** 256n).toString() }))],
    ['data of an odd length', firstCall(call => ({ ...call, data: '0xabc' }))],
    ['data without 0x', firstCall(call => ({ ...call, data: 'abcd' }))],
    ['data that is not hex', firstCall(call => ({ ...call, data: '0xzz' }))],
    ['numeric data', firstCall(call => ({ ...call, data: 1 }))],
    [
      'an authorization with yParity 2',
      body => ({
        ...body,
        authorization: { address: CALIBUR_ADDRESS, chainId: 8453, nonce: 3, r: SALT, s: SALT, yParity: 2 }
      })
    ],
    ['the relayer as evmAddress', body => ({ ...body, evmAddress: TEST_EXECUTOR })],
    ['a batchNonce of another key', body => ({ ...body, batchNonce: '7' })],
    ['a batchNonce of the next key', body => ({ ...body, batchNonce: ((RELAY_NONCE_KEY + 1n) << 64n).toString() })]
  ];

  const refusals: [string, Mutation, number, string][] = [
    ...malformed.map((entry): [string, Mutation, number, string] => [entry[0], entry[1], 400, 'invalid_request']),
    ['an unknown chain', body => ({ ...body, chainId: 10 }), 400, 'unsupported_chain'],
    ['a deadline 60 seconds away', body => ({ ...body, deadline: NOW_S + 60 }), 409, 'stale_request'],
    ['a deadline past 24 hours and the slack', body => ({ ...body, deadline: NOW_S + 86_701 }), 409, 'stale_request'],
    [
      'calls in another order than signed',
      body => ({ ...body, calls: wire([BRIDGE_CALL, APPROVE]) }),
      400,
      'bad_signature'
    ],
    ['a call with another value than signed', firstCall(call => ({ ...call, value: '1' })), 400, 'bad_signature'],
    [
      'a call that the signature does not cover',
      body => ({ ...body, calls: wire([...SPONSOR_CALLS, BRIDGE_CALL]) }),
      400,
      'bad_signature'
    ],
    ['a signature on another chain', body => ({ ...body, chainId: 1 }), 400, 'bad_signature']
  ];

  it.each(refusals)('refuses %s before the chain read', async (_name, mutate, status, error) => {
    const harness = harnessFor();
    const { body } = await signed();
    expect(await outcomeOf(harness, mutate(body))).toEqual(refused(status, error));
  });

  it('refuses a signature of another account', async () => {
    const outcome = await outcomeOf(harnessFor(), (await signed({ signer: OTHER })).body);
    expect(outcome).toEqual(refused(400, 'bad_signature'));
  });

  it('accepts a deadline just after 60 seconds and at 24 hours and the slack', async () => {
    for (const deadline of [NOW_S + 61, NOW_S + 86_700]) {
      const harness = harnessFor();
      expect((await post(harness, (await signed({ deadline })).body)).status).toBe(200);
    }
  });

  it('refuses a signature that does not recover', async () => {
    const harness = harnessFor();
    const { body } = await signed();
    const outcome = await outcomeOf(harness, { ...body, signature: `0x${'00'.repeat(65)}` });
    expect(outcome).toEqual(refused(400, 'bad_signature'));
  });

  it.each([
    ['another account', () => authorizationOf(3, OTHER)],
    ['another delegate', () => authorizationOf(3, USER, `0x${'99'.repeat(20)}`)],
    ['another chain', () => authorizationOf(3, USER, CALIBUR_ADDRESS, 1)],
    [
      'a high s',
      async () => {
        const authorization = await authorizationOf(3);
        const s = (CURVE_ORDER - BigInt(authorization.s)).toString(16).padStart(64, '0');
        return { ...authorization, s: `0x${s}`, yParity: 1 - authorization.yParity };
      }
    ],
    ['an r that does not recover', async () => ({ ...(await authorizationOf(3)), r: `0x${'00'.repeat(32)}` })]
  ])('refuses an authorization of %s with bad_signature', async (_name, make) => {
    const harness = harnessFor();
    harness.reader.relay = relayState({ delegated: false });
    const { body } = await signed();
    const outcome = await outcomeOf(harness, { ...body, authorization: await make() });
    expect(outcome).toEqual(refused(400, 'bad_signature'));
  });
});
