import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { hashAuthorization } from 'viem/utils';

import {
  RELAY_NONCE_KEY,
  batchDigest,
  batchNonceOf,
  buildFeeCall,
  type BatchCall,
  type BatchEnvelope
} from 'lib/evm-relay/batch';
import {
  SEPOLIA_CALIBUR_PIN,
  TEST_ERC20,
  TEST_EXECUTOR,
  TEST_FEE_RECIPIENT,
  TEST_TARGET
} from 'lib/evm-relay/batch/testing';
import type { RelayChainConfig } from 'lib/remote-config/schema';

import {
  MAX_RELAY_CALL_DATA_BYTES,
  MAX_RELAY_CALLS,
  MAX_RELAY_DEADLINE_SECONDS,
  planRelaySignature,
  relaySignChainId,
  RelaySignRuleError,
  type RelaySignContext
} from './sign-rules';

const CHAIN_ID = 11155111;
const NOW = 1_800_000_000;
const NATIVE = '0x0000000000000000000000000000000000000000';
const RELAY_ADDRESS = '0x69ee74a6f96658c72fb4db3bde950972cc865bfa';
const CALIBUR: Address = '0x00000cabfc76478c1537dd418ab00967cbbe4ae6';
const SALT: Hex = `0x${'0'.repeat(24)}${CALIBUR.slice(2)}`;

const CHAIN: RelayChainConfig = {
  key: 'sepolia',
  chainId: CHAIN_ID,
  executor: TEST_EXECUTOR,
  calibur: { ...SEPOLIA_CALIBUR_PIN, address: CALIBUR },
  maxFeeMicroUsd: 500_000
};

const CONTEXT: RelaySignContext = { relayAddress: RELAY_ADDRESS, chain: CHAIN, nowSeconds: NOW };

const SEQUENCE = 7n;

const APPROVE: BatchCall = {
  to: TEST_ERC20,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEST_TARGET, 2_500_000n] })
};
const BRIDGE_CALL: BatchCall = { to: TEST_TARGET, value: 0n, data: '0xcafe0001' };
const FEE_CALL = buildFeeCall({ token: TEST_ERC20, recipient: TEST_FEE_RECIPIENT, amount: 1000n });
const CALLS: BatchCall[] = [APPROVE, BRIDGE_CALL, FEE_CALL];

function wire(call: BatchCall) {
  return { to: call.to, value: call.value.toString(), data: call.data };
}

function batchRequest(overrides: Record<string, unknown> = {}) {
  return {
    op: 'batch',
    chainId: CHAIN_ID,
    calls: CALLS.map(wire),
    batchNonce: batchNonceOf(SEQUENCE).toString(),
    salt: SALT,
    deadline: NOW + 600,
    ...overrides
  };
}

function callRequest(call: Record<string, unknown>) {
  return batchRequest({ calls: [{ ...wire(BRIDGE_CALL), ...call }] });
}

function authorizationRequest(overrides: Record<string, unknown> = {}) {
  return { op: 'authorization', chainId: CHAIN_ID, nonce: 3, ...overrides };
}

/** The reason of the refusal, or null when the request passes. */
function reasonOf(request: unknown, context: RelaySignContext = CONTEXT): string | null {
  try {
    planRelaySignature(request, context);
    return null;
  } catch (error) {
    if (error instanceof RelaySignRuleError) return error.reason;
    throw error;
  }
}

/** The digest of a batch built here from explicit values, not from the request. */
function expectedBatchDigest(calls: BatchCall[], deadline = NOW + 600): Hex {
  const envelope: BatchEnvelope = {
    chainId: CHAIN_ID,
    evmAddress: RELAY_ADDRESS,
    executor: TEST_EXECUTOR,
    batchNonce: batchNonceOf(SEQUENCE),
    salt: SALT,
    deadline: BigInt(deadline)
  };
  return batchDigest(SEPOLIA_CALIBUR_PIN, envelope, calls);
}

describe('relaySignChainId', () => {
  it('reads a positive safe integer', () => {
    expect(relaySignChainId(batchRequest())).toBe(CHAIN_ID);
  });

  it.each([0, -1, 1.5, '11155111', Number.MAX_SAFE_INTEGER + 1, null, undefined])('refuses %p', chainId => {
    expect(() => relaySignChainId({ op: 'authorization', chainId, nonce: 0 })).toThrow(
      new RelaySignRuleError('chain-id')
    );
  });

  it('refuses a request that is not an object', () => {
    expect(() => relaySignChainId('batch')).toThrow(RelaySignRuleError);
  });
});

describe('planRelaySignature: request shape', () => {
  it.each([null, undefined, 'batch', 42, [authorizationRequest()]])('refuses %p as a request', request => {
    expect(reasonOf(request)).toBe('request');
  });

  it.each(['typed-data', 'message', 'transaction', 'digest', undefined])('refuses the op %p', op => {
    expect(reasonOf({ ...authorizationRequest(), op })).toBe('op');
  });

  it('refuses a caller-supplied digest in place of a structured request', () => {
    expect(reasonOf({ op: 'typed-data', digest: `0x${'11'.repeat(32)}` })).toBe('op');
  });
});

describe('planRelaySignature: authorization', () => {
  it('delegates to the pinned Calibur of the chain', () => {
    const plan = planRelaySignature(authorizationRequest(), CONTEXT);
    const authorization = { address: CALIBUR, chainId: CHAIN_ID, nonce: 3 };
    expect(plan).toEqual({ op: 'authorization', digest: hashAuthorization(authorization), authorization });
  });

  it('accepts nonce 0 and the largest safe integer', () => {
    expect(reasonOf(authorizationRequest({ nonce: 0 }))).toBeNull();
    expect(reasonOf(authorizationRequest({ nonce: Number.MAX_SAFE_INTEGER }))).toBeNull();
  });

  it.each([-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, Number.NaN, null])('refuses the nonce %p', nonce => {
    expect(reasonOf(authorizationRequest({ nonce }))).toBe('nonce');
  });

  it.each([0, 1, -CHAIN_ID, `${CHAIN_ID}`, CHAIN_ID + 0.5])('refuses the chain ID %p', chainId => {
    expect(reasonOf(authorizationRequest({ chainId }))).toBe('chain-id');
  });

  it('refuses a delegate named by the caller', () => {
    expect(reasonOf(authorizationRequest({ address: TEST_EXECUTOR }))).toBe('request');
    expect(reasonOf(authorizationRequest({ contractAddress: TEST_EXECUTOR }))).toBe('request');
  });

  it('refuses a missing nonce', () => {
    expect(reasonOf({ op: 'authorization', chainId: CHAIN_ID })).toBe('request');
  });
});

describe('planRelaySignature: batch', () => {
  it('gives the digest of the calls as sent, with the config executor and pin', () => {
    expect(planRelaySignature(batchRequest(), CONTEXT)).toEqual({ op: 'batch', digest: expectedBatchDigest(CALLS) });
  });

  it('signs the calls in their order: another order is another digest', () => {
    const reversed = planRelaySignature(batchRequest({ calls: [...CALLS].reverse().map(wire) }), CONTEXT);
    expect(reversed.digest).toBe(expectedBatchDigest([...CALLS].reverse()));
    expect(reversed.digest).not.toBe(planRelaySignature(batchRequest(), CONTEXT).digest);
  });

  it('reads addresses and calldata in any case', () => {
    const upper = CALLS.map(call => ({
      to: `0x${call.to.slice(2).toUpperCase()}`,
      value: call.value.toString(),
      data: `0x${call.data.slice(2).toUpperCase()}`
    }));
    expect(planRelaySignature(batchRequest({ calls: upper }), CONTEXT).digest).toBe(expectedBatchDigest(CALLS));
  });

  it('takes the executor from the config, never from the request', () => {
    const otherChain = { ...CHAIN, executor: TEST_FEE_RECIPIENT };
    const other = planRelaySignature(batchRequest(), { ...CONTEXT, chain: otherChain });
    expect(other.digest).not.toBe(planRelaySignature(batchRequest(), CONTEXT).digest);
  });

  it.each([
    ['executor', TEST_EXECUTOR],
    ['evmAddress', TEST_EXECUTOR],
    ['calibur', CALIBUR],
    ['digest', `0x${'11'.repeat(32)}`],
    ['params', { token: TEST_ERC20 }]
  ])('refuses the extra field %s', (key, value) => {
    expect(reasonOf(batchRequest({ [key]: value }))).toBe('request');
  });

  it.each([0, CHAIN_ID + 1, `${CHAIN_ID}`])('refuses the chain ID %p', chainId => {
    expect(reasonOf(batchRequest({ chainId }))).toBe('chain-id');
  });

  it('refuses a relay address that is not an address', () => {
    expect(reasonOf(batchRequest(), { ...CONTEXT, relayAddress: 'mtst1relay' })).toBe('relay-address');
  });

  describe('calls', () => {
    it('accepts one call and the largest batch', () => {
      expect(reasonOf(batchRequest({ calls: [wire(BRIDGE_CALL)] }))).toBeNull();
      expect(reasonOf(batchRequest({ calls: Array.from({ length: MAX_RELAY_CALLS }, () => wire(BRIDGE_CALL)) }))).toBe(
        null
      );
      expect(MAX_RELAY_CALLS).toBe(8);
    });

    it.each([
      ['no calls', []],
      ['nine calls', Array.from({ length: MAX_RELAY_CALLS + 1 }, () => wire(BRIDGE_CALL))],
      ['an object', { 0: wire(BRIDGE_CALL) }],
      ['null', null]
    ])('refuses %s', (_name, calls) => {
      expect(reasonOf(batchRequest({ calls }))).toBe('calls');
    });

    it.each([
      ['a string', 'call'],
      ['an array', []],
      ['a missing data field', { to: TEST_TARGET, value: '0' }],
      ['an extra key', { ...wire(BRIDGE_CALL), gas: '21000' }]
    ])('refuses a call that is %s', (_name, call) => {
      expect(reasonOf(batchRequest({ calls: [call] }))).toBe('call');
    });

    it.each([NATIVE, RELAY_ADDRESS, `0x${RELAY_ADDRESS.slice(2).toUpperCase()}`, '0x1234', TEST_TARGET.slice(2), 1])(
      'refuses the target %p',
      to => {
        expect(reasonOf(callRequest({ to }))).toBe('call-to');
      }
    );

    it.each(['-1', '01', '1.5', '0x01', 1, null, (1n << 256n).toString()])('refuses the value %p', value => {
      expect(reasonOf(callRequest({ value }))).toBe('call-value');
    });

    it('accepts a native value and the largest uint256 value', () => {
      expect(reasonOf(callRequest({ value: '1000000000000000000', data: '0x' }))).toBeNull();
      expect(reasonOf(callRequest({ value: ((1n << 256n) - 1n).toString() }))).toBeNull();
    });

    it.each(['0x1', 'cafe', '0xzz', '', null, 42])('refuses the data %p', data => {
      expect(reasonOf(callRequest({ data }))).toBe('call-data');
    });

    it('accepts calldata up to the cap and refuses one byte more', () => {
      expect(reasonOf(callRequest({ data: `0x${'ab'.repeat(MAX_RELAY_CALL_DATA_BYTES)}` }))).toBeNull();
      expect(reasonOf(callRequest({ data: `0x${'ab'.repeat(MAX_RELAY_CALL_DATA_BYTES + 1)}` }))).toBe('call-data');
    });
  });

  describe('batch nonce', () => {
    it('accepts sequence 0 and the largest uint64 sequence', () => {
      expect(reasonOf(batchRequest({ batchNonce: batchNonceOf(0n).toString() }))).toBeNull();
      expect(reasonOf(batchRequest({ batchNonce: batchNonceOf((1n << 64n) - 1n).toString() }))).toBeNull();
    });

    it('refuses a nonce under another key', () => {
      const otherKey = (RELAY_NONCE_KEY + 1n) << 64n;
      expect(reasonOf(batchRequest({ batchNonce: otherKey.toString() }))).toBe('batch-nonce-key');
      expect(reasonOf(batchRequest({ batchNonce: '7' }))).toBe('batch-nonce-key');
    });

    it('refuses a sequence that overflows into the key', () => {
      const overflow = (batchNonceOf(0n) + (1n << 64n)).toString();
      expect(reasonOf(batchRequest({ batchNonce: overflow }))).toBe('batch-nonce-key');
    });

    it.each(['0x07', '-7', '', 7, (1n << 256n).toString()])('refuses the nonce %p', batchNonce => {
      expect(reasonOf(batchRequest({ batchNonce }))).toBe('batch-nonce');
    });
  });

  describe('salt', () => {
    it('accepts the Calibur address in any case', () => {
      expect(reasonOf(batchRequest({ salt: `0x${SALT.slice(2).toUpperCase()}` }))).toBeNull();
    });

    it('refuses a salt whose last 20 bytes are not the Calibur address', () => {
      expect(reasonOf(batchRequest({ salt: `0x${'0'.repeat(24)}${TEST_EXECUTOR.slice(2)}` }))).toBe('salt');
      expect(reasonOf(batchRequest({ salt: `0x${CALIBUR.slice(2)}${'0'.repeat(24)}` }))).toBe('salt');
    });

    it.each([`0x${'0'.repeat(22)}${CALIBUR.slice(2)}`, `${'0'.repeat(24)}${CALIBUR.slice(2)}`, null, 1])(
      'refuses the salt %p',
      salt => {
        expect(reasonOf(batchRequest({ salt }))).toBe('salt');
      }
    );
  });

  describe('deadline', () => {
    it('refuses a deadline at now', () => {
      expect(reasonOf(batchRequest({ deadline: NOW }))).toBe('deadline');
    });

    it('accepts one second after now', () => {
      expect(reasonOf(batchRequest({ deadline: NOW + 1 }))).toBeNull();
    });

    it('accepts a deadline 24 hours after now', () => {
      expect(reasonOf(batchRequest({ deadline: NOW + MAX_RELAY_DEADLINE_SECONDS }))).toBeNull();
      expect(MAX_RELAY_DEADLINE_SECONDS).toBe(86_400);
    });

    it('refuses a deadline one second past 24 hours', () => {
      expect(reasonOf(batchRequest({ deadline: NOW + MAX_RELAY_DEADLINE_SECONDS + 1 }))).toBe('deadline');
    });

    it.each([NOW - 1, NOW + 1.5, `${NOW + 600}`, null])('refuses the deadline %p', deadline => {
      expect(reasonOf(batchRequest({ deadline }))).toBe('deadline');
    });

    it('signs the deadline it read', () => {
      const plan = planRelaySignature(batchRequest({ deadline: NOW + 60 }), CONTEXT);
      expect(plan.digest).toBe(expectedBatchDigest(CALLS, NOW + 60));
    });
  });
});
