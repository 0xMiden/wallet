/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { ConfigError, parseConfig } from '../src/config';
import type { Env } from '../src/types';

const ZERO = `0x${'0'.repeat(40)}`;
const CALIBUR = {
  address: `0x${'AB'.repeat(20)}`,
  runtimeHash: `0x${'CD'.repeat(32)}`,
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};
const AGGLAYER = { bridgeAddress: `0x${'2A'.repeat(20)}`, midenNetworkId: 1, forceUpdateGlobalExitRoot: true };
const USDC = `0x${'Aa'.repeat(20)}`;
const FEE_RECIPIENT = `0x${'Fe'.repeat(20)}`;

/** A chain with one ERC-20 and the native coin, valid in both gas modes. */
function chain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    calibur: CALIBUR,
    feeRecipient: FEE_RECIPIENT,
    agglayer: AGGLAYER,
    tokens: { [USDC]: { minAmount: '2000000', fee: '100000' }, [ZERO]: { minAmount: '1000', fee: '10' } },
    ...overrides
  };
}

function env(chains: Record<string, unknown>, gasMode = 'sponsor'): Env {
  return { GAS_MODE: gasMode, ALLOWED_ORIGINS: '[]', RELAY_CONFIG: JSON.stringify({ chains }) };
}

function parseError(value: Env): string {
  try {
    parseConfig(value);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error('The config parsed');
}

describe('parseConfig', () => {
  it('parses the committed placeholder: no chains', () => {
    const config = parseConfig({ GAS_MODE: 'sponsor', ALLOWED_ORIGINS: '[]', RELAY_CONFIG: '{"chains":{}}' });
    expect(config.gasMode).toBe('sponsor');
    expect(config.allowedOrigins.size).toBe(0);
    expect(config.chains.size).toBe(0);
  });

  it('parses a full chain and lower-cases every address and hash', () => {
    const config = parseConfig({ ...env({ '8453': chain() }, 'deduct'), ALLOWED_ORIGINS: JSON.stringify(['a://b']) });
    expect(config.gasMode).toBe('deduct');
    expect([...config.allowedOrigins]).toEqual(['a://b']);
    expect(config.chains.get(8453)).toEqual({
      chainId: 8453,
      calibur: { ...CALIBUR, address: `0x${'ab'.repeat(20)}`, runtimeHash: `0x${'cd'.repeat(32)}` },
      feeRecipient: `0x${'fe'.repeat(20)}`,
      agglayer: { ...AGGLAYER, bridgeAddress: `0x${'2a'.repeat(20)}` },
      tokens: new Map([
        [`0x${'aa'.repeat(20)}`, { minAmount: 2_000_000n, fee: 100_000n }],
        [ZERO, { minAmount: 1000n, fee: 10n }]
      ])
    });
  });

  it('accepts a sponsor chain without feeRecipient and agglayer, and a fee of 0', () => {
    const {
      feeRecipient: _feeRecipient,
      agglayer: _agglayer,
      ...bare
    } = chain({
      tokens: { [USDC]: { minAmount: '1', fee: '0' } }
    });
    const parsed = parseConfig(env({ '1': bare })).chains.get(1);
    expect(parsed?.feeRecipient).toBeNull();
    expect(parsed?.agglayer).toBeNull();
    expect(parsed?.tokens.get(`0x${'aa'.repeat(20)}`)).toEqual({ minAmount: 1n, fee: 0n });
  });

  it('accepts an amount of 2^256 - 1 and a midenNetworkId of 2^32 - 1', () => {
    const max = (2n ** 256n - 1n).toString();
    const value = env({
      '1': chain({
        agglayer: { ...AGGLAYER, midenNetworkId: 2 ** 32 - 1 },
        tokens: { [USDC]: { minAmount: max, fee: '0' } }
      })
    });
    expect(
      parseConfig(value)
        .chains.get(1)
        ?.tokens.get(`0x${'aa'.repeat(20)}`)?.minAmount
    ).toBe(2n ** 256n - 1n);
  });

  it.each([
    [
      'GAS_MODE absent',
      { ALLOWED_ORIGINS: '[]', RELAY_CONFIG: '{"chains":{}}' },
      'GAS_MODE must be sponsor or deduct.'
    ],
    ['GAS_MODE in upper case', env({}, 'SPONSOR'), 'GAS_MODE must be sponsor or deduct.'],
    [
      'ALLOWED_ORIGINS with a wildcard',
      { ...env({}), ALLOWED_ORIGINS: '["*"]' },
      'ALLOWED_ORIGINS must hold exact origins.'
    ],
    ['ALLOWED_ORIGINS not JSON', { ...env({}), ALLOWED_ORIGINS: 'a://b' }, 'ALLOWED_ORIGINS must be JSON.'],
    ['ALLOWED_ORIGINS an object', { ...env({}), ALLOWED_ORIGINS: '{}' }, 'ALLOWED_ORIGINS must be a JSON array.'],
    ['RELAY_CONFIG absent', { GAS_MODE: 'sponsor' }, 'RELAY_CONFIG must be JSON.'],
    ['RELAY_CONFIG not JSON', { ...env({}), RELAY_CONFIG: '{' }, 'RELAY_CONFIG must be JSON.'],
    ['RELAY_CONFIG an array', { ...env({}), RELAY_CONFIG: '[]' }, 'RELAY_CONFIG must be an object.'],
    ['RELAY_CONFIG without chains', { ...env({}), RELAY_CONFIG: '{}' }, 'RELAY_CONFIG.chains is missing.'],
    [
      'an unknown top field',
      { ...env({}), RELAY_CONFIG: '{"chains":{},"x":1}' },
      'RELAY_CONFIG.x is not a known field.'
    ],
    ['chains an array', { ...env({}), RELAY_CONFIG: '{"chains":[]}' }, 'RELAY_CONFIG.chains must be an object.']
  ])('refuses %s', (_name, value, message) => {
    expect(parseError(value)).toBe(message);
  });

  it.each(['0', '01', '-1', '1.5', 'base', '9007199254740992'])('refuses the chain id key %s', key => {
    expect(parseError(env({ [key]: chain() }))).toBe(
      `RELAY_CONFIG.chains.${key} must have a positive decimal chain id key.`
    );
  });

  const at = 'RELAY_CONFIG.chains.1';
  it.each([
    ['a chain that is not an object', [], `${at} must be an object.`],
    ['an unknown chain field', chain({ rpcUrl: 'https://x' }), `${at}.rpcUrl is not a known field.`],
    ['a missing calibur', chain({ calibur: undefined }), `${at}.calibur is missing.`],
    ['a calibur that is not an object', chain({ calibur: 'Calibur' }), `${at}.calibur must be an object.`],
    [
      'a short calibur address',
      chain({ calibur: { ...CALIBUR, address: '0x12' } }),
      `${at}.calibur.address must be a 20-byte hex address.`
    ],
    [
      'a zero calibur address',
      chain({ calibur: { ...CALIBUR, address: ZERO } }),
      `${at}.calibur.address must not be the zero address.`
    ],
    [
      'a short runtimeHash',
      chain({ calibur: { ...CALIBUR, runtimeHash: `0x${'1'.repeat(63)}` } }),
      `${at}.calibur.runtimeHash must be a 32-byte hex hash.`
    ],
    [
      'an empty domainName',
      chain({ calibur: { ...CALIBUR, domainName: '' } }),
      `${at}.calibur.domainName must be a non-empty string.`
    ],
    [
      'a numeric domainVersion',
      chain({ calibur: { ...CALIBUR, domainVersion: 1 } }),
      `${at}.calibur.domainVersion must be a non-empty string.`
    ],
    [
      'a calibur without domainVersion',
      chain({ calibur: { ...CALIBUR, domainVersion: undefined } }),
      `${at}.calibur.domainVersion is missing.`
    ],
    [
      'an unknown calibur field',
      chain({ calibur: { ...CALIBUR, salt: '0x' } }),
      `${at}.calibur.salt is not a known field.`
    ],
    ['a zero feeRecipient', chain({ feeRecipient: ZERO }), `${at}.feeRecipient must not be the zero address.`],
    ['a null feeRecipient', chain({ feeRecipient: null }), `${at}.feeRecipient must be a 20-byte hex address.`],
    [
      'a zero bridgeAddress',
      chain({ agglayer: { ...AGGLAYER, bridgeAddress: ZERO } }),
      `${at}.agglayer.bridgeAddress must not be the zero address.`
    ],
    [
      'a fractional midenNetworkId',
      chain({ agglayer: { ...AGGLAYER, midenNetworkId: 1.5 } }),
      `${at}.agglayer.midenNetworkId must be an integer.`
    ],
    [
      'a string midenNetworkId',
      chain({ agglayer: { ...AGGLAYER, midenNetworkId: '1' } }),
      `${at}.agglayer.midenNetworkId must be an integer.`
    ],
    [
      'a negative midenNetworkId',
      chain({ agglayer: { ...AGGLAYER, midenNetworkId: -1 } }),
      `${at}.agglayer.midenNetworkId must be in 0..2^32-1.`
    ],
    [
      'a midenNetworkId of 2^32',
      chain({ agglayer: { ...AGGLAYER, midenNetworkId: 2 ** 32 } }),
      `${at}.agglayer.midenNetworkId must be in 0..2^32-1.`
    ],
    [
      'a string forceUpdateGlobalExitRoot',
      chain({ agglayer: { ...AGGLAYER, forceUpdateGlobalExitRoot: 'true' } }),
      `${at}.agglayer.forceUpdateGlobalExitRoot must be a boolean.`
    ],
    ['tokens an array', chain({ tokens: [] }), `${at}.tokens must be an object.`],
    [
      'a token key that is not an address',
      chain({ tokens: { usdc: { minAmount: '1', fee: '0' } } }),
      `${at}.tokens.usdc must be a 20-byte hex address.`
    ],
    [
      'a token key repeated in another case',
      chain({ tokens: { [USDC]: { minAmount: '1', fee: '0' }, [USDC.toLowerCase()]: { minAmount: '1', fee: '0' } } }),
      `${at}.tokens.${USDC.toLowerCase()} repeats a token address.`
    ],
    ['a token without fee', chain({ tokens: { [USDC]: { minAmount: '1' } } }), `${at}.tokens.${USDC}.fee is missing.`],
    [
      'an unknown token field',
      chain({ tokens: { [USDC]: { minAmount: '1', fee: '0', decimals: 6 } } }),
      `${at}.tokens.${USDC}.decimals is not a known field.`
    ],
    [
      'a numeric minAmount',
      chain({ tokens: { [USDC]: { minAmount: 1, fee: '0' } } }),
      `${at}.tokens.${USDC}.minAmount must be a decimal integer string.`
    ],
    [
      'a minAmount with a leading zero',
      chain({ tokens: { [USDC]: { minAmount: '01', fee: '0' } } }),
      `${at}.tokens.${USDC}.minAmount must be a decimal integer string.`
    ],
    [
      'a negative fee',
      chain({ tokens: { [USDC]: { minAmount: '1', fee: '-1' } } }),
      `${at}.tokens.${USDC}.fee must be a decimal integer string.`
    ],
    [
      'a minAmount of 2^256',
      chain({ tokens: { [USDC]: { minAmount: (2n ** 256n).toString(), fee: '0' } } }),
      `${at}.tokens.${USDC}.minAmount must be below 2^256.`
    ],
    [
      'a minAmount of 79 digits',
      chain({ tokens: { [USDC]: { minAmount: '1'.repeat(79), fee: '0' } } }),
      `${at}.tokens.${USDC}.minAmount must be a decimal integer string.`
    ],
    [
      'a minAmount of 0',
      chain({ tokens: { [USDC]: { minAmount: '0', fee: '0' } } }),
      `${at}.tokens.${USDC}.minAmount must be above 0.`
    ]
  ])('refuses %s', (_name, value, message) => {
    expect(parseError(env({ '1': value }))).toBe(message);
  });

  describe('GAS_MODE deduct', () => {
    it.each([
      [
        'a chain without feeRecipient',
        chain({ feeRecipient: undefined }),
        `${at}.feeRecipient is required when GAS_MODE is deduct.`
      ],
      [
        'a fee of 0',
        chain({ tokens: { [USDC]: { minAmount: '10', fee: '0' } } }),
        `${at}.tokens.${USDC}.fee must be above 0 when GAS_MODE is deduct.`
      ],
      [
        'a minAmount equal to the fee',
        chain({ tokens: { [USDC]: { minAmount: '10', fee: '10' } } }),
        `${at}.tokens.${USDC}.minAmount must be above the fee when GAS_MODE is deduct.`
      ],
      [
        'a minAmount below the fee',
        chain({ tokens: { [USDC]: { minAmount: '9', fee: '10' } } }),
        `${at}.tokens.${USDC}.minAmount must be above the fee when GAS_MODE is deduct.`
      ]
    ])('refuses %s', (_name, value, message) => {
      expect(parseError(env({ '1': value }, 'deduct'))).toBe(message);
    });

    it('accepts the same chains in sponsor mode', () => {
      const value = chain({ feeRecipient: undefined, tokens: { [USDC]: { minAmount: '9', fee: '10' } } });
      expect(parseConfig(env({ '1': value })).chains.size).toBe(1);
    });
  });
});
