import { normalizeMidenIdToHex } from './bridge';

jest.mock('@miden-sdk/miden-sdk', () => ({
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('hex encoded data must start with 0x');
      return { toString: () => value };
    }
  },
  // An underscore stands in for a routing suffix the SDK's bech32 decoder rejects.
  Address: {
    fromBech32: (value: string) => {
      if (value.includes('_')) throw new Error('invalid note tag length');
      return { accountId: () => ({ toString: () => `0x${value.slice(value.indexOf('1') + 1)}` }) };
    }
  }
}));

it('normalizes an id with an uppercase 0X prefix to its 0x form', () => {
  expect(normalizeMidenIdToHex('0X0123456789abcdef0123456789abcd')).toBe('0x0123456789abcdef0123456789abcd');
});

it('normalizes a composite address whose routing suffix the bech32 parser rejects to its address part', () => {
  expect(normalizeMidenIdToHex('mtst10123456789abcdef0123456789abcd_qruqqypuyph')).toBe(
    '0x0123456789abcdef0123456789abcd'
  );
});
