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
const USDC = `0x${'Aa'.repeat(20)}`;
const FEE_RECIPIENT = `0x${'Fe'.repeat(20)}`;
const TARGET = `0x${'2A'.repeat(20)}`;
const OTHER_TARGET = `0x${'3b'.repeat(20)}`;

/** A chain with a fee in one ERC-20 and in the native coin, valid in both gas modes. */
function chain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    calibur: CALIBUR,
    feeRecipient: FEE_RECIPIENT,
    fees: { [USDC]: '100000', [ZERO]: '10' },
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
    const value = env({ '8453': chain({ allowedTargets: [TARGET, OTHER_TARGET] }) }, 'deduct');
    const config = parseConfig({ ...value, ALLOWED_ORIGINS: JSON.stringify(['a://b']) });
    expect(config.gasMode).toBe('deduct');
    expect([...config.allowedOrigins]).toEqual(['a://b']);
    expect(config.chains.get(8453)).toEqual({
      chainId: 8453,
      calibur: { ...CALIBUR, address: `0x${'ab'.repeat(20)}`, runtimeHash: `0x${'cd'.repeat(32)}` },
      feeRecipient: `0x${'fe'.repeat(20)}`,
      fees: new Map([
        [`0x${'aa'.repeat(20)}`, 100_000n],
        [ZERO, 10n]
      ]),
      allowedTargets: [`0x${'2a'.repeat(20)}`, OTHER_TARGET]
    });
  });

  it('keeps the fees in config order', () => {
    const parsed = parseConfig(env({ '1': chain({ fees: { [ZERO]: '1', [USDC]: '2' } }) })).chains.get(1);
    expect([...(parsed?.fees.keys() ?? [])]).toEqual([ZERO, `0x${'aa'.repeat(20)}`]);
  });

  it('accepts a sponsor chain with only calibur: no fee recipient, no fees and any target', () => {
    const parsed = parseConfig(env({ '1': { calibur: CALIBUR } })).chains.get(1);
    expect(parsed?.feeRecipient).toBeNull();
    expect(parsed?.fees).toEqual(new Map());
    expect(parsed?.allowedTargets).toBeNull();
  });

  it('accepts an empty fees object in sponsor mode', () => {
    expect(parseConfig(env({ '1': chain({ fees: {} }) })).chains.get(1)?.fees.size).toBe(0);
  });

  it('accepts a fee of 2^256 - 1', () => {
    const max = (2n ** 256n - 1n).toString();
    const parsed = parseConfig(env({ '1': chain({ fees: { [USDC]: max } }) })).chains.get(1);
    expect(parsed?.fees.get(`0x${'aa'.repeat(20)}`)).toBe(2n ** 256n - 1n);
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
    ['the old tokens field', chain({ tokens: {} }), `${at}.tokens is not a known field.`],
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
    ['fees an array', chain({ fees: [] }), `${at}.fees must be an object.`],
    ['fees null', chain({ fees: null }), `${at}.fees must be an object.`],
    [
      'a fee key that is not an address',
      chain({ fees: { usdc: '1' } }),
      `${at}.fees.usdc must be a 20-byte hex address.`
    ],
    [
      'a fee key repeated in another case',
      chain({ fees: { [USDC]: '1', [USDC.toLowerCase()]: '1' } }),
      `${at}.fees.${USDC.toLowerCase()} repeats a token address.`
    ],
    ['a numeric fee', chain({ fees: { [USDC]: 1 } }), `${at}.fees.${USDC} must be a decimal integer string.`],
    [
      'a fee with a leading zero',
      chain({ fees: { [USDC]: '01' } }),
      `${at}.fees.${USDC} must be a decimal integer string.`
    ],
    ['a negative fee', chain({ fees: { [USDC]: '-1' } }), `${at}.fees.${USDC} must be a decimal integer string.`],
    ['a fee of 2^256', chain({ fees: { [USDC]: (2n ** 256n).toString() } }), `${at}.fees.${USDC} must be below 2^256.`],
    [
      'a fee of 79 digits',
      chain({ fees: { [USDC]: '1'.repeat(79) } }),
      `${at}.fees.${USDC} must be a decimal integer string.`
    ],
    ['a fee of 0', chain({ fees: { [USDC]: '0' } }), `${at}.fees.${USDC} must be above 0.`],
    [
      'a fee that is an object',
      chain({ fees: { [USDC]: { fee: '1' } } }),
      `${at}.fees.${USDC} must be a decimal integer string.`
    ],
    ['allowedTargets an object', chain({ allowedTargets: {} }), `${at}.allowedTargets must be a non-empty array.`],
    ['allowedTargets null', chain({ allowedTargets: null }), `${at}.allowedTargets must be a non-empty array.`],
    ['an empty allowedTargets', chain({ allowedTargets: [] }), `${at}.allowedTargets must be a non-empty array.`],
    [
      'a target that is not an address',
      chain({ allowedTargets: [TARGET, '0x12'] }),
      `${at}.allowedTargets.1 must be a 20-byte hex address.`
    ],
    [
      'the zero address as a target',
      chain({ allowedTargets: [ZERO] }),
      `${at}.allowedTargets.0 must not be the zero address.`
    ],
    [
      'a target repeated in another case',
      chain({ allowedTargets: [TARGET, TARGET.toLowerCase()] }),
      `${at}.allowedTargets.1 repeats a target address.`
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
      ['a chain without fees', chain({ fees: undefined }), `${at}.fees must name a token when GAS_MODE is deduct.`],
      ['a chain with empty fees', chain({ fees: {} }), `${at}.fees must name a token when GAS_MODE is deduct.`]
    ])('refuses %s', (_name, value, message) => {
      expect(parseError(env({ '1': value }, 'deduct'))).toBe(message);
    });

    it('accepts the same chains in sponsor mode', () => {
      const value = chain({ feeRecipient: undefined, fees: undefined });
      expect(parseConfig(env({ '1': value })).chains.size).toBe(1);
    });
  });
});
