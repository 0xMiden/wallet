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
const PARSED_CALIBUR = { ...CALIBUR, address: `0x${'ab'.repeat(20)}`, runtimeHash: `0x${'cd'.repeat(32)}` };
const USDC = `0x${'Aa'.repeat(20)}`;
const FEE_RECIPIENT = `0x${'Fe'.repeat(20)}`;
const TARGET = `0x${'2A'.repeat(20)}`;
const OTHER_TARGET = `0x${'3b'.repeat(20)}`;
const RPC_URL = 'https://rpc.example/key';

/** A chains entry with the native price and one ERC-20 fee token, valid in both gas modes. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { nativePrice: 'ETHUSDT', feeTokens: { [USDC]: 'usd' }, ...overrides };
}

/** RELAY_CONFIG with the Calibur pin, the fee recipient and the chains entries. `top` adds or replaces top fields. */
function relayConfig(chains: Record<string, unknown> = {}, top: Record<string, unknown> = {}): string {
  return JSON.stringify({ calibur: CALIBUR, feeRecipient: FEE_RECIPIENT, chains, ...top });
}

/** The env: the variables, and one `RPC_URL_<chainId>` secret for each served chain. */
function env(
  chains: Record<string, unknown>,
  gasMode = 'sponsor',
  served: readonly string[] = Object.keys(chains),
  top: Record<string, unknown> = {}
): Env {
  const value: Env = { GAS_MODE: gasMode, ALLOWED_ORIGINS: '[]', RELAY_CONFIG: relayConfig(chains, top) };
  for (const chainId of served) Reflect.set(value, `RPC_URL_${chainId}`, RPC_URL);
  return value;
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
  it('parses the minimal config: one Calibur pin and no RPC URL, so no chain', () => {
    const config = parseConfig({
      GAS_MODE: 'sponsor',
      ALLOWED_ORIGINS: '[]',
      RELAY_CONFIG: JSON.stringify({ calibur: CALIBUR })
    });
    expect(config.gasMode).toBe('sponsor');
    expect(config.allowedOrigins.size).toBe(0);
    expect(config.calibur).toEqual(PARSED_CALIBUR);
    expect(config.feeRecipient).toBeNull();
    expect(config.chains.size).toBe(0);
  });

  it('parses a full config and lower-cases every address and hash', () => {
    const value = env({ '8453': entry({ allowedTargets: [TARGET, OTHER_TARGET] }) }, 'deduct');
    const config = parseConfig({ ...value, ALLOWED_ORIGINS: JSON.stringify(['a://b']) });
    expect(config.gasMode).toBe('deduct');
    expect([...config.allowedOrigins]).toEqual(['a://b']);
    expect(config.feeRecipient).toBe(`0x${'fe'.repeat(20)}`);
    expect(config.chains.get(8453)).toEqual({
      chainId: 8453,
      calibur: PARSED_CALIBUR,
      feeRecipient: `0x${'fe'.repeat(20)}`,
      nativePrice: 'ETHUSDT',
      feeTokens: new Map([[`0x${'aa'.repeat(20)}`, 'usd']]),
      allowedTargets: [`0x${'2a'.repeat(20)}`, OTHER_TARGET]
    });
  });

  it('serves exactly the chains with an RPC_URL_ secret, in chain id order', () => {
    const config = parseConfig(env({ '1': entry() }, 'sponsor', ['8453', '10', '1']));
    expect([...config.chains.keys()]).toEqual([1, 10, 8453]);
  });

  it('gives every served chain the one Calibur pin and the one fee recipient', () => {
    const config = parseConfig(env({}, 'sponsor', ['1', '8453']));
    for (const chain of config.chains.values()) {
      expect(chain.calibur).toEqual(PARSED_CALIBUR);
      expect(chain.feeRecipient).toBe(`0x${'fe'.repeat(20)}`);
    }
  });

  it('gives a served chain without an entry no price, no fee token and no target list', () => {
    const parsed = parseConfig(env({ '1': entry({ allowedTargets: [TARGET] }) }, 'sponsor', ['1', '8453']));
    expect(parsed.chains.get(1)?.allowedTargets).toEqual([`0x${'2a'.repeat(20)}`]);
    expect(parsed.chains.get(8453)?.nativePrice).toBeNull();
    expect(parsed.chains.get(8453)?.feeTokens).toEqual(new Map());
    expect(parsed.chains.get(8453)?.allowedTargets).toBeNull();
  });

  it('checks the entry of a chain without an RPC URL, but does not serve that chain', () => {
    expect(parseConfig(env({ '1': entry(), '10': entry() }, 'deduct', ['1'])).chains.has(10)).toBe(false);
    expect(parseError(env({ '10': entry({ feeTokens: [] }) }, 'sponsor', []))).toBe(
      'RELAY_CONFIG.chains.10.feeTokens must be an object.'
    );
  });

  it('keeps the fee tokens in config order', () => {
    const other = `0x${'bb'.repeat(20)}`;
    const parsed = parseConfig(env({ '1': entry({ feeTokens: { [other]: 'BTCUSDT', [USDC]: 'usd' } }) })).chains.get(1);
    expect([...(parsed?.feeTokens ?? [])]).toEqual([
      [other, 'BTCUSDT'],
      [`0x${'aa'.repeat(20)}`, 'usd']
    ]);
  });

  it('accepts a sponsor config without a fee recipient and without chains', () => {
    const value = env({}, 'sponsor', ['1'], { feeRecipient: undefined, chains: undefined });
    expect(value.RELAY_CONFIG).toBe(JSON.stringify({ calibur: CALIBUR }));
    const parsed = parseConfig(value).chains.get(1);
    expect(parsed?.feeRecipient).toBeNull();
    expect(parsed?.nativePrice).toBeNull();
    expect(parsed?.feeTokens).toEqual(new Map());
    expect(parsed?.allowedTargets).toBeNull();
  });

  it('accepts an empty entry and an empty feeTokens object in sponsor mode', () => {
    expect(parseConfig(env({ '1': {} })).chains.get(1)?.feeTokens.size).toBe(0);
    expect(parseConfig(env({ '1': entry({ feeTokens: {} }) })).chains.get(1)?.feeTokens.size).toBe(0);
  });

  it('accepts a deduct entry with only nativePrice: the native coin is then the only fee token', () => {
    const parsed = parseConfig(env({ '1': { nativePrice: 'usd' } }, 'deduct')).chains.get(1);
    expect(parsed?.nativePrice).toBe('usd');
    expect(parsed?.feeTokens.size).toBe(0);
  });

  it.each(['usd', 'ETHUSDT', 'POLUSDT', 'A1B2C', 'ABCDEFGHIJKLMNOPQRST'])('accepts the price symbol %s', symbol => {
    const parsed = parseConfig(env({ '1': entry({ nativePrice: symbol, feeTokens: { [USDC]: symbol } }) }));
    expect(parsed.chains.get(1)?.nativePrice).toBe(symbol);
    expect(parsed.chains.get(1)?.feeTokens.get(`0x${'aa'.repeat(20)}`)).toBe(symbol);
  });

  it.each([
    ['GAS_MODE absent', { ALLOWED_ORIGINS: '[]', RELAY_CONFIG: relayConfig() }, 'GAS_MODE must be sponsor or deduct.'],
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
    ['RELAY_CONFIG without calibur', { ...env({}), RELAY_CONFIG: '{}' }, 'RELAY_CONFIG.calibur is missing.'],
    ['the old shape: only chains', { ...env({}), RELAY_CONFIG: '{"chains":{}}' }, 'RELAY_CONFIG.calibur is missing.'],
    ['an unknown top field', env({}, 'sponsor', [], { x: 1 }), 'RELAY_CONFIG.x is not a known field.'],
    ['chains an array', env({}, 'sponsor', [], { chains: [] }), 'RELAY_CONFIG.chains must be an object.'],
    ['chains null', env({}, 'sponsor', [], { chains: null }), 'RELAY_CONFIG.chains must be an object.'],
    [
      'a calibur that is not an object',
      env({}, 'sponsor', [], { calibur: 'Calibur' }),
      'RELAY_CONFIG.calibur must be an object.'
    ],
    [
      'a short calibur address',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, address: '0x12' } }),
      'RELAY_CONFIG.calibur.address must be a 20-byte hex address.'
    ],
    [
      'a zero calibur address',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, address: ZERO } }),
      'RELAY_CONFIG.calibur.address must not be the zero address.'
    ],
    [
      'a short runtimeHash',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, runtimeHash: `0x${'1'.repeat(63)}` } }),
      'RELAY_CONFIG.calibur.runtimeHash must be a 32-byte hex hash.'
    ],
    [
      'an empty domainName',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, domainName: '' } }),
      'RELAY_CONFIG.calibur.domainName must be a non-empty string.'
    ],
    [
      'a numeric domainVersion',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, domainVersion: 1 } }),
      'RELAY_CONFIG.calibur.domainVersion must be a non-empty string.'
    ],
    [
      'a calibur without domainVersion',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, domainVersion: undefined } }),
      'RELAY_CONFIG.calibur.domainVersion is missing.'
    ],
    [
      'an unknown calibur field',
      env({}, 'sponsor', [], { calibur: { ...CALIBUR, salt: '0x' } }),
      'RELAY_CONFIG.calibur.salt is not a known field.'
    ],
    [
      'a zero feeRecipient',
      env({}, 'sponsor', [], { feeRecipient: ZERO }),
      'RELAY_CONFIG.feeRecipient must not be the zero address.'
    ],
    [
      'a null feeRecipient',
      env({}, 'sponsor', [], { feeRecipient: null }),
      'RELAY_CONFIG.feeRecipient must be a 20-byte hex address.'
    ]
  ])('refuses %s', (_name, value, message) => {
    expect(parseError(value)).toBe(message);
  });

  it.each(['0', '01', '-1', '1.5', 'base', '9007199254740992'])('refuses the chain id key %s', key => {
    expect(parseError(env({ [key]: entry() }, 'sponsor', []))).toBe(
      `RELAY_CONFIG.chains.${key} must have a positive decimal chain id key.`
    );
  });

  it.each(['0', '01', 'base', '', '9007199254740992'])('refuses the secret RPC_URL_%s', suffix => {
    expect(parseError(env({}, 'sponsor', [suffix]))).toBe(
      'Each RPC_URL_ secret must end in a positive decimal chain id.'
    );
  });

  it('names no RPC URL and no secret key in a message', () => {
    const value = env({});
    Reflect.set(value, 'RPC_URL_hidden', 'https://rpc.example/apikey');
    const message = parseError(value);
    expect(message).not.toContain('hidden');
    expect(message).not.toContain('apikey');
  });

  const at = 'RELAY_CONFIG.chains.1';
  it.each([
    ['an entry that is not an object', [], `${at} must be an object.`],
    ['an unknown entry field', entry({ rpcUrl: 'https://x' }), `${at}.rpcUrl is not a known field.`],
    ['the old tokens field', entry({ tokens: {} }), `${at}.tokens is not a known field.`],
    ['the old per-chain calibur', entry({ calibur: CALIBUR }), `${at}.calibur is not a known field.`],
    [
      'the old per-chain feeRecipient',
      entry({ feeRecipient: FEE_RECIPIENT }),
      `${at}.feeRecipient is not a known field.`
    ],
    ['the old fees field', entry({ fees: { [USDC]: '100000' } }), `${at}.fees is not a known field.`],
    ['feeTokens an array', entry({ feeTokens: [] }), `${at}.feeTokens must be an object.`],
    ['feeTokens null', entry({ feeTokens: null }), `${at}.feeTokens must be an object.`],
    [
      'a fee token key that is not an address',
      entry({ feeTokens: { usdc: 'usd' } }),
      `${at}.feeTokens.usdc must be a 20-byte hex address.`
    ],
    [
      'the zero address as a fee token: the native coin is always one',
      entry({ feeTokens: { [ZERO]: 'usd' } }),
      `${at}.feeTokens.${ZERO} must not be the zero address.`
    ],
    [
      'a fee token repeated in another case',
      entry({ feeTokens: { [USDC]: 'usd', [USDC.toLowerCase()]: 'usd' } }),
      `${at}.feeTokens.${USDC.toLowerCase()} repeats a token address.`
    ],
    ...['USD', 'Usd', 'ethusdt', 'ETH', 'ETHUSDTETHUSDTETHUSDT', 'ETH-USDT', 'ETH USDT', ''].map(
      (symbol): [string, Record<string, unknown>, string] => [
        `the fee token symbol "${symbol}"`,
        entry({ feeTokens: { [USDC]: symbol } }),
        `${at}.feeTokens.${USDC} must be "usd" or a market symbol of 5 to 20 characters A-Z and 0-9.`
      ]
    ),
    [
      'a numeric fee token symbol',
      entry({ feeTokens: { [USDC]: 1 } }),
      `${at}.feeTokens.${USDC} must be "usd" or a market symbol of 5 to 20 characters A-Z and 0-9.`
    ],
    [
      'a numeric nativePrice',
      entry({ nativePrice: 2000 }),
      `${at}.nativePrice must be "usd" or a market symbol of 5 to 20 characters A-Z and 0-9.`
    ],
    [
      'a null nativePrice',
      entry({ nativePrice: null }),
      `${at}.nativePrice must be "usd" or a market symbol of 5 to 20 characters A-Z and 0-9.`
    ],
    [
      'a lower-case nativePrice',
      entry({ nativePrice: 'ethusdt' }),
      `${at}.nativePrice must be "usd" or a market symbol of 5 to 20 characters A-Z and 0-9.`
    ],
    ['allowedTargets an object', entry({ allowedTargets: {} }), `${at}.allowedTargets must be a non-empty array.`],
    ['allowedTargets null', entry({ allowedTargets: null }), `${at}.allowedTargets must be a non-empty array.`],
    ['an empty allowedTargets', entry({ allowedTargets: [] }), `${at}.allowedTargets must be a non-empty array.`],
    [
      'a target that is not an address',
      entry({ allowedTargets: [TARGET, '0x12'] }),
      `${at}.allowedTargets.1 must be a 20-byte hex address.`
    ],
    [
      'the zero address as a target',
      entry({ allowedTargets: [ZERO] }),
      `${at}.allowedTargets.0 must not be the zero address.`
    ],
    [
      'a target repeated in another case',
      entry({ allowedTargets: [TARGET, TARGET.toLowerCase()] }),
      `${at}.allowedTargets.1 repeats a target address.`
    ]
  ])('refuses %s', (_name, value, message) => {
    expect(parseError(env({ '1': value }))).toBe(message);
  });

  describe('GAS_MODE deduct', () => {
    it.each([
      [
        'a config without feeRecipient',
        env({ '1': entry() }, 'deduct', ['1'], { feeRecipient: undefined }),
        'RELAY_CONFIG.feeRecipient is required when GAS_MODE is deduct.'
      ],
      [
        'a config without feeRecipient and without a served chain',
        env({}, 'deduct', [], { feeRecipient: undefined }),
        'RELAY_CONFIG.feeRecipient is required when GAS_MODE is deduct.'
      ],
      [
        'a served chain without nativePrice',
        env({ '1': entry({ nativePrice: undefined }) }, 'deduct'),
        `${at}.nativePrice is required when GAS_MODE is deduct.`
      ],
      [
        'a served chain with an empty entry',
        env({ '1': {} }, 'deduct'),
        `${at}.nativePrice is required when GAS_MODE is deduct.`
      ],
      [
        'a served chain without an entry',
        env({ '8453': entry() }, 'deduct', ['8453', '1']),
        `${at}.nativePrice is required when GAS_MODE is deduct.`
      ]
    ])('refuses %s', (_name, value, message) => {
      expect(parseError(value)).toBe(message);
    });

    it('accepts the same chains in sponsor mode', () => {
      const value = env({ '1': entry({ nativePrice: undefined }) }, 'sponsor', ['1', '8453'], {
        feeRecipient: undefined
      });
      expect(parseConfig(value).chains.size).toBe(2);
    });
  });
});
