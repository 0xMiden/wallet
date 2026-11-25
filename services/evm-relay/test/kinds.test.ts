/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { AGGLAYER_DEPOSIT, FEE_RECIPIENT, NATIVE, USDC } from './harness';
import { buildAgglayerDepositCalls } from '../../../src/lib/evm-relay/batch';
import { RELAY_KINDS, isRelayKind, kindsOf, parseKinds } from '../src/kinds';
import { ParseError } from '../src/parse';

const handler = RELAY_KINDS['agglayer-deposit'];
const ACCOUNT = `0x${'0A'.repeat(15)}`;
const PARAMS = { token: USDC.toUpperCase().replace('0X', '0x'), amount: '1900000', midenAccountHex: ACCOUNT, fee: '0' };

function parseError(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    if (error instanceof ParseError) return error.message;
    throw error;
  }
  throw new Error('The value parsed');
}

describe('relay kind registry', () => {
  it('knows the kinds of the batch module only', () => {
    expect(isRelayKind('agglayer-deposit')).toBe(true);
    expect(isRelayKind('agglayer')).toBe(false);
    expect(isRelayKind('toString')).toBe(false);
  });

  it('lists the kinds of a chain in registry order', () => {
    const kinds = parseKinds({ 'agglayer-deposit': AGGLAYER_DEPOSIT }, 'kinds');
    expect(kindsOf(kinds)).toEqual(['agglayer-deposit']);
    expect(kindsOf(parseKinds({}, 'kinds'))).toEqual([]);
  });

  it('parses the params into lower-case values and gives the token, the fee and the deposit', () => {
    const params = handler.parseParams({ ...PARAMS, fee: '100000' }, 'params');
    expect(params).toEqual({ token: USDC, amount: 1_900_000n, midenAccountHex: ACCOUNT.toLowerCase(), fee: 100_000n });
    expect(handler.tokenOf(params)).toBe(USDC);
    expect(handler.feeOf(params)).toBe(100_000n);
    expect(handler.depositOf(params)).toBe(2_000_000n);
  });

  it.each([
    ['a missing fee', { ...PARAMS, fee: undefined }, 'params.fee is missing.'],
    ['an unknown field', { ...PARAMS, recipient: FEE_RECIPIENT }, 'params.recipient is not a known field.'],
    ['a numeric amount', { ...PARAMS, amount: 1 }, 'params.amount must be a decimal integer string.'],
    ['an amount of 0', { ...PARAMS, amount: '0' }, 'params.amount must be above 0.'],
    [
      'a short account',
      { ...PARAMS, midenAccountHex: '0x0a' },
      'params.midenAccountHex must be 0x and 30 hex characters.'
    ],
    ['a token that is not an address', { ...PARAMS, token: 'usdc' }, 'params.token must be a 20-byte hex address.']
  ])('refuses params with %s', (_name, value, message) => {
    expect(parseError(() => handler.parseParams(JSON.parse(JSON.stringify(value)), 'params'))).toBe(message);
  });

  it('builds the calls of the batch module, with a fee call only for a fee', () => {
    const config = handler.parseConfig(AGGLAYER_DEPOSIT, 'kind');
    const sponsored = handler.parseParams({ ...PARAMS, token: NATIVE }, 'params');
    expect(handler.buildCalls(config, sponsored, null)).toEqual(
      buildAgglayerDepositCalls(config, {
        token: NATIVE,
        amount: 1_900_000n,
        midenAccountHex: ACCOUNT.toLowerCase(),
        fee: null
      })
    );
    const paid = handler.parseParams({ ...PARAMS, fee: '100000' }, 'params');
    expect(handler.buildCalls(config, paid, FEE_RECIPIENT)).toEqual(
      buildAgglayerDepositCalls(config, {
        token: USDC,
        amount: 1_900_000n,
        midenAccountHex: ACCOUNT.toLowerCase(),
        fee: { recipient: FEE_RECIPIENT, amount: 100_000n }
      })
    );
    expect(() => handler.buildCalls(config, paid, null)).toThrow('A fee needs a fee recipient.');
  });
});
