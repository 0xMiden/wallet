import { isBalanceReflected, tagBalanceSnapshot, type BalanceSnapshot } from './balance-snapshot';
import type { TokenBalanceData } from './front/balance';

const requirement = { accountId: 'account-a_tag', faucetId: 'coin', minimumNonce: '5' };
const rows = (patch: Partial<TokenBalanceData> = {}): TokenBalanceData[] => [
  {
    tokenId: 'coin',
    tokenSlug: 'COIN',
    balance: 10,
    fiatPrice: 0,
    change24h: 0,
    metadata: { name: 'Coin', symbol: 'COIN', decimals: 0 },
    ...patch
  }
];

it.each<BalanceSnapshot>([
  { network: 'mainnet', accountNonce: '5' },
  { network: 'mainnet', accountNonce: '6' },
  { network: 'mainnet', accountNonce: '18446744073709551615' }
])('accepts a displayed same-account vault at/after the consume nonce %s', snapshot => {
  const displayed = rows({ balance: 0 }); // Later spending does not undo the original consumption.
  tagBalanceSnapshot(displayed, snapshot);
  expect(isBalanceReflected(requirement, { 'account-a': displayed })).toBe(true);
});

it.each<BalanceSnapshot>([
  { network: 'mainnet', accountNonce: '4' },
  { network: 'mainnet' },
  { network: 'mainnet', accountNonce: '' },
  { network: 'mainnet', accountNonce: '-1' },
  { network: 'mainnet', accountNonce: '5.5' },
  { network: 'mainnet', accountNonce: 'bad' },
  { network: 'testnet', accountNonce: '5' },
  { network: 'override', accountNonce: '5' },
  { network: 'changed', accountNonce: '5' }
])('rejects stale, missing, malformed or wrong-network provenance %s', snapshot => {
  const displayed = rows();
  tagBalanceSnapshot(displayed, snapshot);
  expect(isBalanceReflected(requirement, { 'account-a': displayed })).toBe(false);
});

it('does not mistake a positive balance, fetch timestamp, clone, removed account or cleared store for proof', () => {
  const displayed = rows();
  expect(isBalanceReflected(requirement, { 'account-a': displayed })).toBe(false);
  tagBalanceSnapshot(displayed, { network: 'mainnet', accountNonce: '5' });
  expect(isBalanceReflected(requirement, { 'account-a': [...displayed] })).toBe(false);
  expect(isBalanceReflected(requirement, { 'account-b': displayed })).toBe(false);
  expect(isBalanceReflected(requirement, { 'account-a': undefined })).toBe(false);
  expect(isBalanceReflected(requirement, {})).toBe(false);
  expect(isBalanceReflected({ ...requirement, minimumNonce: '-1' }, { 'account-a': displayed })).toBe(false);
});

it.each<Partial<TokenBalanceData>>([
  { tokenId: 'other' },
  { balance: Infinity },
  { balance: NaN },
  { metadata: { name: 'Unknown', symbol: 'Unknown', decimals: 6, scaleIsUnknown: true } }
])('requires the qualifying asset to have a visible finite quantity %s', patch => {
  const displayed = rows(patch);
  tagBalanceSnapshot(displayed, { network: 'mainnet', accountNonce: '5' });
  expect(isBalanceReflected(requirement, { 'account-a': displayed })).toBe(false);
});
