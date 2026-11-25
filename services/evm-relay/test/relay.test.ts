/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import {
  AGGLAYER_DEPOSIT,
  CALIBUR_ADDRESS,
  FEE_RECIPIENT,
  IMPLEMENTATION_CODE,
  TEST_EXECUTOR,
  USDC,
  bodyOf,
  chainEntry,
  createHarness,
  relayState,
  send,
  transactionSigner,
  type Harness
} from './harness';
import {
  batchDigest,
  batchNonceOf,
  batchTypedData,
  buildAgglayerDepositCalls,
  encodeExecution,
  type BatchEnvelope
} from '../../../src/lib/evm-relay/batch';
import { RpcUnavailableError, type RelayAuthorization } from '../src/chain';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const USER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const EVM: Hex = `0x${USER.address.slice(2).toLowerCase()}`;
const ACCOUNT = `0x${'0a'.repeat(15)}`;
const SALT: Hex = `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`;
const PIN = {
  address: CALIBUR_ADDRESS,
  runtimeHash: keccak256(IMPLEMENTATION_CODE),
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};
const CONFIG = JSON.stringify({ chains: { '8453': chainEntry(), '1': chainEntry(false) } });
const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

interface Draft {
  token: Hex;
  amount: bigint;
  fee: bigint;
  deadline: number;
  batchNonce: bigint;
  signer: PrivateKeyAccount;
}

interface Signed {
  body: Record<string, unknown>;
  id: Hex;
  data: Hex;
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    token: USDC,
    amount: 2_000_000n,
    fee: 0n,
    deadline: NOW_S + 600,
    batchNonce: batchNonceOf('agglayer-deposit', 7n),
    signer: USER,
    ...overrides
  };
}

/** A request body that the wallet would send, signed by `signer` over the calls of the Worker's config. */
async function signed(overrides: Partial<Draft> = {}): Promise<Signed> {
  const value = draft(overrides);
  const fee = value.fee === 0n ? null : { recipient: FEE_RECIPIENT, amount: value.fee };
  const calls = buildAgglayerDepositCalls(AGGLAYER_DEPOSIT, {
    token: value.token,
    amount: value.amount,
    midenAccountHex: ACCOUNT,
    fee
  });
  const envelope: BatchEnvelope = {
    chainId: 8453,
    evmAddress: EVM,
    executor: TEST_EXECUTOR,
    batchNonce: value.batchNonce,
    salt: SALT,
    deadline: BigInt(value.deadline)
  };
  const signature = await value.signer.signTypedData(batchTypedData(PIN, envelope, calls));
  const body = {
    chainId: 8453,
    kind: 'agglayer-deposit',
    evmAddress: EVM,
    params: {
      token: value.token,
      amount: value.amount.toString(),
      midenAccountHex: ACCOUNT,
      fee: value.fee.toString()
    },
    batchNonce: value.batchNonce.toString(),
    salt: SALT,
    deadline: value.deadline,
    signature
  };
  return { body, id: batchDigest(PIN, envelope, calls), data: encodeExecution(envelope, calls, signature) };
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

function harnessFor(gasMode = 'sponsor'): Harness {
  return createHarness({ gasMode, relayConfig: CONFIG });
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

async function expectError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect((await bodyOf(response)).error).toBe(error);
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /v1/relay', () => {
  it('relays a sponsored batch as a type 2 transaction and answers pending', async () => {
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
  });

  it('relays a deduct batch that pays the fee to the configured fee recipient', async () => {
    const harness = harnessFor('deduct');
    const { body, id, data } = await signed({ amount: 1_900_000n, fee: 100_000n });
    const response = await post(harness, body);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).id).toBe(id);
    expect(parseTransaction(broadcastRaw(harness)).data).toBe(data);
  });

  it('accepts a deduct fee above the configured fee', async () => {
    const { body } = await signed({ amount: 1_900_000n, fee: 150_000n });
    expect((await post(harnessFor('deduct'), body)).status).toBe(200);
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

  it('answers 502 rpc_unavailable when the chain read fails', async () => {
    const harness = harnessFor();
    harness.reader.error = new RpcUnavailableError('The chain RPC does not answer.');
    await expectError(await post(harness, (await signed()).body), 502, 'rpc_unavailable');
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
});

describe('POST /v1/relay refusals', () => {
  type Mutation = (body: Record<string, unknown>) => unknown;
  const params = (body: Record<string, unknown>): Record<string, unknown> => {
    const value = body.params;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('No params');
    return { ...value };
  };
  const without = (body: Record<string, unknown>, key: string): Record<string, unknown> => {
    const copy = { ...body };
    Reflect.deleteProperty(copy, key);
    return copy;
  };

  const malformed: [string, Mutation][] = [
    ['an array body', () => []],
    ['no signature', body => without(body, 'signature')],
    ['an unknown field', body => ({ ...body, calls: [] })],
    ['a string chainId', body => ({ ...body, chainId: '8453' })],
    ['chainId 0', body => ({ ...body, chainId: 0 })],
    ['a numeric kind', body => ({ ...body, kind: 1 })],
    ['a bad evmAddress', body => ({ ...body, evmAddress: '0x12' })],
    ['a numeric batchNonce', body => ({ ...body, batchNonce: 7 })],
    ['a short salt', body => ({ ...body, salt: '0x00' })],
    ['a string deadline', body => ({ ...body, deadline: String(NOW_S + 600) })],
    ['a fractional deadline', body => ({ ...body, deadline: NOW_S + 600.5 })],
    ['a 64-byte signature', body => ({ ...body, signature: `0x${'11'.repeat(64)}` })],
    ['params without midenAccountHex', body => ({ ...body, params: without(params(body), 'midenAccountHex') })],
    ['params with an amount of 0', body => ({ ...body, params: { ...params(body), amount: '0' } })],
    ['params with an unknown field', body => ({ ...body, params: { ...params(body), recipient: FEE_RECIPIENT } })],
    [
      'an authorization with yParity 2',
      body => ({
        ...body,
        authorization: { address: CALIBUR_ADDRESS, chainId: 8453, nonce: 3, r: SALT, s: SALT, yParity: 2 }
      })
    ],
    ['the relayer as evmAddress', body => ({ ...body, evmAddress: TEST_EXECUTOR })],
    ['a batchNonce of another key', body => ({ ...body, batchNonce: '7' })]
  ];

  const refusals: [string, Mutation, number, string][] = [
    ...malformed.map((entry): [string, Mutation, number, string] => [entry[0], entry[1], 400, 'invalid_request']),
    ['an unknown chain', body => ({ ...body, chainId: 10 }), 400, 'unsupported_chain'],
    ['an unknown kind', body => ({ ...body, kind: 'cctp-deposit' }), 400, 'unsupported_kind'],
    ['a chain without the kind', body => ({ ...body, chainId: 1 }), 400, 'unsupported_kind'],
    [
      'a token that is not configured',
      body => ({ ...body, params: { ...params(body), token: `0x${'bb'.repeat(20)}` } }),
      400,
      'token_not_allowed'
    ],
    ['a deadline 60 seconds away', body => ({ ...body, deadline: NOW_S + 60 }), 409, 'stale_request'],
    ['a deadline past 24 hours and the slack', body => ({ ...body, deadline: NOW_S + 86_701 }), 409, 'stale_request'],
    ['a signature of another account', body => body, 400, 'bad_signature']
  ];

  it.each(refusals)('refuses %s before the chain read', async (name, mutate, status, error) => {
    const harness = harnessFor();
    const { body } = await signed(name === 'a signature of another account' ? { signer: OTHER } : {});
    await expectError(await post(harness, mutate(body)), status, error);
    expect(harness.reader.relayCalls).toEqual([]);
    expect(harness.relayLimit.keys).toEqual(['relay:203.0.113.7']);
  });

  it.each([
    ['sponsor', { amount: 1_999_999n }, 'below_minimum'],
    ['deduct', { amount: 1_800_000n, fee: 100_000n }, 'below_minimum'],
    ['sponsor', { amount: 1_900_000n, fee: 100_000n }, 'invalid_request'],
    ['deduct', { amount: 1_950_000n, fee: 99_999n }, 'fee_too_low']
  ])('refuses in %s mode the amounts %p with %s', async (gasMode, amounts, error) => {
    const harness = harnessFor(gasMode);
    await expectError(await post(harness, (await signed(amounts)).body), 400, error);
    expect(harness.reader.relayCalls).toEqual([]);
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
    await expectError(await post(harness, { ...body, signature: `0x${'00'.repeat(65)}` }), 400, 'bad_signature');
    expect(harness.reader.relayCalls).toEqual([]);
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
    ]
  ])('refuses an authorization of %s with bad_signature', async (_name, make) => {
    const harness = harnessFor();
    harness.reader.relay = relayState({ delegated: false });
    const { body } = await signed();
    await expectError(await post(harness, { ...body, authorization: await make() }), 400, 'bad_signature');
    expect(harness.reader.relayCalls).toEqual([]);
  });
});
