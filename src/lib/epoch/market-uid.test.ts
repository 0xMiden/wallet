import { NO_EXPLORER_CHAIN } from 'lib/walletconnect/testing/chains';

import { earnRowChain, marketUidChainId } from './market-uid';

jest.mock('lib/walletconnect/config', () => {
  const chains = jest.requireActual<typeof import('lib/walletconnect/testing/chains')>(
    'lib/walletconnect/testing/chains'
  );
  return chains.walletConnectConfigMock([chains.NO_EXPLORER_CHAIN]);
});

const BASE_MARKET =
  'MORPHO_BLUE_D7520AD198B497B6EB75BC690268F4597630DBC12E305E9D4105843BAB36E41D:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('marketUidChainId', () => {
  it.each([
    [BASE_MARKET, 8453],
    ['AAVE_V3:42161:0xunderlying', 42161],
    ['AAVE_V3:1:0xunderlying', 1],
    ['DUMMY_LENDING:11155111:0xunderlying', 11155111],
    [':84532:0xabc', 84532]
  ])('reads the chain id of %s', (marketUid, chainId) => {
    expect(marketUidChainId(marketUid)).toBe(chainId);
  });

  it.each([
    ['no chain segment', 'DUMMY-LENDING'],
    ['an empty chain segment', 'AAVE_V3::0xunderlying'],
    ['a named chain', 'AAVE_V3:base:0xunderlying'],
    ['a zero chain id', 'AAVE_V3:0:0xunderlying'],
    ['a leading zero', 'AAVE_V3:08453:0xunderlying'],
    ['a negative chain id', 'AAVE_V3:-1:0xunderlying'],
    ['a fractional chain id', 'AAVE_V3:1.5:0xunderlying'],
    ['a chain id above the safe integers', 'AAVE_V3:9007199254740993:0xunderlying']
  ])('gives undefined for %s', (_label, marketUid) => {
    expect(marketUidChainId(marketUid)).toBeUndefined();
  });
});

describe('earnRowChain', () => {
  it.each([
    [BASE_MARKET, 'https://basescan.org'],
    ['AAVE_V3:42161:0xunderlying', 'https://arbiscan.io'],
    ['AAVE_V3:1:0xunderlying', 'https://etherscan.io'],
    ['DUMMY_LENDING:11155111:0xunderlying', 'https://sepolia.etherscan.io']
  ])('resolves the chain of %s', (marketUid, explorer) => {
    expect(earnRowChain(marketUid)?.explorer).toBe(explorer);
  });

  it.each([
    ['no market uid', undefined],
    ['an empty market uid', '']
  ])('uses the default chain for %s', (_label, marketUid) => {
    expect(earnRowChain(marketUid)?.id).toBe(11155111);
  });

  it('gives undefined for a chain the registry does not know', () => {
    expect(earnRowChain('AAVE_V3:999999:0xunderlying')).toBeUndefined();
  });

  it('gives undefined, not the default chain, for a market uid that names no chain', () => {
    expect(earnRowChain('AAVE_V3:base:0xunderlying')).toBeUndefined();
  });

  it('gives the registry chain, with its empty explorer, for a chain with no explorer', () => {
    expect(earnRowChain(`AAVE_V3:${NO_EXPLORER_CHAIN.id}:0xunderlying`)).toEqual(NO_EXPLORER_CHAIN);
  });
});
