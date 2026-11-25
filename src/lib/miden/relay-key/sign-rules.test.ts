import type { Address, Hex } from 'viem';
import { hashAuthorization } from 'viem/utils';

import {
  batchDigest,
  batchNonceOf,
  buildAgglayerDepositCalls,
  type AgglayerDepositParams,
  type BatchEnvelope
} from 'lib/evm-relay/batch';
import {
  SEPOLIA_AGGLAYER_CONFIG,
  SEPOLIA_CALIBUR_PIN,
  TEST_ERC20,
  TEST_EXECUTOR,
  TEST_FEE_RECIPIENT,
  TEST_MIDEN_ACCOUNT_HEX
} from 'lib/evm-relay/batch/testing';
import type { RelayChainConfig } from 'lib/remote-config/schema';

import {
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
const ERC20_CAP = 1000n;
const NATIVE_CAP = 500n;

const CHAIN: RelayChainConfig = {
  key: 'sepolia',
  chainId: CHAIN_ID,
  executor: TEST_EXECUTOR,
  calibur: { ...SEPOLIA_CALIBUR_PIN, address: CALIBUR },
  maxFee: { [TEST_ERC20]: ERC20_CAP.toString(), [NATIVE]: NATIVE_CAP.toString() }
};

const CONTEXT: RelaySignContext = {
  midenAccountHex: TEST_MIDEN_ACCOUNT_HEX,
  relayAddress: RELAY_ADDRESS,
  chain: CHAIN,
  agglayer: SEPOLIA_AGGLAYER_CONFIG,
  nowSeconds: NOW
};

const SEQUENCE = 7n;

function batchRequest(overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return {
    op: 'batch',
    chainId: CHAIN_ID,
    kind: 'agglayer-deposit',
    params: {
      token: TEST_ERC20,
      amount: '1000000',
      fee: { recipient: TEST_FEE_RECIPIENT, amount: '1000' },
      ...params
    },
    batchNonce: batchNonceOf('agglayer-deposit', SEQUENCE).toString(),
    salt: SALT,
    deadline: NOW + 600,
    ...overrides
  };
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
function expectedBatchDigest(params: Omit<AgglayerDepositParams, 'midenAccountHex'>, deadline = NOW + 600): Hex {
  const envelope: BatchEnvelope = {
    chainId: CHAIN_ID,
    evmAddress: RELAY_ADDRESS,
    executor: TEST_EXECUTOR,
    batchNonce: batchNonceOf('agglayer-deposit', SEQUENCE),
    salt: SALT,
    deadline: BigInt(deadline)
  };
  const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, {
    ...params,
    midenAccountHex: TEST_MIDEN_ACCOUNT_HEX
  });
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
  it('gives the digest of the batch to the account own Miden account, with the config executor and pin', () => {
    const plan = planRelaySignature(batchRequest(), CONTEXT);
    expect(plan).toEqual({
      op: 'batch',
      digest: expectedBatchDigest({
        token: TEST_ERC20,
        amount: 1_000_000n,
        fee: { recipient: TEST_FEE_RECIPIENT, amount: 1000n }
      })
    });
  });

  it('gives the sponsored digest when the fee is null', () => {
    const plan = planRelaySignature(batchRequest({}, { fee: null }), CONTEXT);
    expect(plan.digest).toBe(expectedBatchDigest({ token: TEST_ERC20, amount: 1_000_000n, fee: null }));
  });

  it('bridges to the account in the context, never to another account', () => {
    const other = planRelaySignature(batchRequest(), { ...CONTEXT, midenAccountHex: `0x${'0b'.repeat(15)}` });
    expect(other.digest).not.toBe(planRelaySignature(batchRequest(), CONTEXT).digest);
  });

  it('reads the token address in any case', () => {
    const upper = `0x${TEST_ERC20.slice(2).toUpperCase()}`;
    expect(planRelaySignature(batchRequest({}, { token: upper }), CONTEXT).digest).toBe(
      planRelaySignature(batchRequest(), CONTEXT).digest
    );
  });

  it.each([
    ['midenAccountHex', TEST_MIDEN_ACCOUNT_HEX],
    ['bridgeAddress', TEST_EXECUTOR],
    ['calls', []]
  ])('refuses the extra parameter %s', (key, value) => {
    expect(reasonOf(batchRequest({}, { [key]: value }))).toBe('params');
  });

  it.each([
    ['executor', TEST_EXECUTOR],
    ['evmAddress', TEST_EXECUTOR],
    ['calibur', CALIBUR],
    ['digest', `0x${'11'.repeat(32)}`]
  ])('refuses the extra field %s', (key, value) => {
    expect(reasonOf(batchRequest({ [key]: value }))).toBe('request');
  });

  it('refuses params that are not an object', () => {
    expect(reasonOf(batchRequest({ params: null }))).toBe('params');
    expect(reasonOf(batchRequest({ params: [] }))).toBe('params');
  });

  it.each(['bridge-out', 'agglayer-withdraw', undefined, 1])('refuses the kind %p', kind => {
    expect(reasonOf(batchRequest({ kind }))).toBe('kind');
  });

  it.each([0, CHAIN_ID + 1, `${CHAIN_ID}`])('refuses the chain ID %p', chainId => {
    expect(reasonOf(batchRequest({ chainId }))).toBe('chain-id');
  });

  it('refuses a chain with no Agglayer deposit', () => {
    expect(reasonOf(batchRequest(), { ...CONTEXT, agglayer: null })).toBe('agglayer');
  });

  it('refuses an account ID that is not 15 bytes', () => {
    expect(reasonOf(batchRequest(), { ...CONTEXT, midenAccountHex: `0x${'0a'.repeat(14)}` })).toBe('account');
  });

  it('refuses a relay address that is not an address', () => {
    expect(reasonOf(batchRequest(), { ...CONTEXT, relayAddress: 'mtst1relay' })).toBe('relay-address');
  });

  describe('token and amount', () => {
    it.each(['0x1234', 'usdc', TEST_ERC20.slice(2), null, 42])('refuses the token %p', token => {
      expect(reasonOf(batchRequest({}, { token }))).toBe('token');
    });

    it.each(['0', '-1', '01', '1.5', '1e6', ' 1', 1, null, (1n << 256n).toString()])(
      'refuses the amount %p',
      amount => {
        expect(reasonOf(batchRequest({}, { amount }))).toBe('amount');
      }
    );

    it('accepts the largest uint256 amount', () => {
      expect(reasonOf(batchRequest({}, { amount: ((1n << 256n) - 1n).toString(), fee: null }))).toBeNull();
    });
  });

  describe('fee', () => {
    const fee = (amount: string, recipient: string = TEST_FEE_RECIPIENT) => ({ fee: { recipient, amount } });

    it('accepts a fee exactly at the cap', () => {
      expect(reasonOf(batchRequest({}, fee(ERC20_CAP.toString())))).toBeNull();
    });

    it('refuses a fee one above the cap', () => {
      expect(reasonOf(batchRequest({}, fee((ERC20_CAP + 1n).toString())))).toBe('fee-amount');
    });

    it('refuses a zero fee', () => {
      expect(reasonOf(batchRequest({}, fee('0')))).toBe('fee-amount');
    });

    it.each(['-1', '1.0', '', 1000])('refuses the fee amount %p', amount => {
      expect(reasonOf(batchRequest({}, { fee: { recipient: TEST_FEE_RECIPIENT, amount } }))).toBe('fee-amount');
    });

    it('refuses a fee in a token without a cap', () => {
      const token = '0x4444444444444444444444444444444444444444';
      expect(reasonOf(batchRequest({}, { token, ...fee('1') }))).toBe('fee-token');
      expect(reasonOf(batchRequest({}, { token, fee: null }))).toBeNull();
    });

    it('caps a native fee with the native entry', () => {
      expect(reasonOf(batchRequest({}, { token: NATIVE, ...fee(NATIVE_CAP.toString()) }))).toBeNull();
      expect(reasonOf(batchRequest({}, { token: NATIVE, ...fee((NATIVE_CAP + 1n).toString()) }))).toBe('fee-amount');
    });

    it('refuses the zero recipient', () => {
      expect(reasonOf(batchRequest({}, fee('1', NATIVE)))).toBe('fee-recipient');
    });

    it.each(['0x1234', 'relayer', '', 1])('refuses the recipient %p', recipient => {
      expect(reasonOf(batchRequest({}, { fee: { recipient, amount: '1' } }))).toBe('fee-recipient');
    });

    it.each([
      ['a string', 'free'],
      ['an array', []],
      ['a missing amount', { recipient: TEST_FEE_RECIPIENT }],
      ['an extra key', { recipient: TEST_FEE_RECIPIENT, amount: '1', token: TEST_ERC20 }]
    ])('refuses a fee with %s', (_case, value) => {
      expect(reasonOf(batchRequest({}, { fee: value }))).toBe('fee');
    });

    it('refuses a missing fee field', () => {
      expect(reasonOf({ ...batchRequest(), params: { token: TEST_ERC20, amount: '1' } })).toBe('params');
    });
  });

  describe('batch nonce', () => {
    it('accepts sequence 0 and the largest uint64 sequence', () => {
      expect(reasonOf(batchRequest({ batchNonce: batchNonceOf('agglayer-deposit', 0n).toString() }))).toBeNull();
      const top = batchNonceOf('agglayer-deposit', (1n << 64n) - 1n).toString();
      expect(reasonOf(batchRequest({ batchNonce: top }))).toBeNull();
    });

    it('refuses a nonce under another key', () => {
      const otherKey = ((batchNonceOf('agglayer-deposit', 0n) >> 64n) + 1n) << 64n;
      expect(reasonOf(batchRequest({ batchNonce: otherKey.toString() }))).toBe('batch-nonce-key');
      expect(reasonOf(batchRequest({ batchNonce: '7' }))).toBe('batch-nonce-key');
    });

    it('refuses a sequence that overflows into the key', () => {
      const overflow = (batchNonceOf('agglayer-deposit', 0n) + (1n << 64n)).toString();
      expect(reasonOf(batchRequest({ batchNonce: overflow }))).toBe('batch-nonce-key');
    });

    it.each(['0x07', '-7', '', 7, (1n << 256n).toString()])('refuses the nonce %p', batchNonce => {
      expect(reasonOf(batchRequest({ batchNonce }))).toBe('batch-nonce');
    });
  });

  describe('salt', () => {
    it('accepts the Calibur address in any case', () => {
      expect(reasonOf(batchRequest({ salt: SALT.toUpperCase().replace('0X', '0x') }))).toBeNull();
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
      expect(plan.digest).toBe(
        expectedBatchDigest(
          { token: TEST_ERC20, amount: 1_000_000n, fee: { recipient: TEST_FEE_RECIPIENT, amount: 1000n } },
          NOW + 60
        )
      );
    });
  });
});
