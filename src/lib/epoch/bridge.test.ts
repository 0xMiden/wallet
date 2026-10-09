import { normalizeMidenIdToHex } from './bridge';

jest.mock('@miden-sdk/miden-sdk', () => ({
  AccountId: {
    fromHex: (value: string) => {
      if (!/^0x[0-9a-f]{28,32}$/.test(value)) throw new Error('hex encoded data must start with 0x');
      return { toString: () => value };
    }
  },
  Address: {}
}));

it('normalizes an id with an uppercase 0X prefix to its 0x form', () => {
  expect(normalizeMidenIdToHex('0X0123456789abcdef0123456789abcd')).toBe('0x0123456789abcdef0123456789abcd');
});
