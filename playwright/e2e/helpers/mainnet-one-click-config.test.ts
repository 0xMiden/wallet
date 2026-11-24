import testnet from '../../../src/lib/remote-config/testing/testnet.json';
import { mainnetOneClickConfig } from './mainnet-one-click-config';

const nearIntents = {
  serviceUrl: 'https://one-click.example',
  midenAssets: { usdc: { assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 } },
  chains: {
    eth: {
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: {
        USDC: {
          assetId: 'eth:usdc',
          decimals: 6,
          contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          miden: ['usdc']
        }
      }
    }
  }
};

function mainnetDocument(nearIntentsEnabled?: boolean) {
  return {
    ...testnet,
    network: 'mainnet',
    features: {
      ...testnet.features,
      ...(nearIntentsEnabled === undefined ? {} : { nearIntents: nearIntentsEnabled })
    },
    nearIntents
  };
}

describe('mainnet NEAR Intents config rollout gate', () => {
  it('keeps a configured service and mapped assets unavailable when the feature is absent or false', () => {
    expect(mainnetOneClickConfig(mainnetDocument())).toBeUndefined();
    expect(mainnetOneClickConfig(mainnetDocument(false))).toBeUndefined();
  });

  it('uses the configured route only when the wallet-config switch is explicitly true', () => {
    expect(mainnetOneClickConfig(mainnetDocument(true))).toEqual({
      serviceUrl: 'https://one-click.example',
      midenAssets: [{ id: 'usdc', ...nearIntents.midenAssets.usdc }],
      chains: [
        {
          id: 'eth',
          name: 'Ethereum',
          addressKind: 'evm',
          tokens: [{ symbol: 'USDC', ...nearIntents.chains.eth.tokens.USDC }]
        }
      ]
    });
  });

  it('ignores the retired swap.oneClick section', () => {
    const retiredOneClick = { ...nearIntents, serviceUrl: 'https://retired.example' };
    const withBoth = { ...mainnetDocument(true), swap: { ...testnet.swap, oneClick: retiredOneClick } };
    expect(mainnetOneClickConfig(withBoth)?.serviceUrl).toBe('https://one-click.example');

    const retiredOnly = {
      ...mainnetDocument(true),
      nearIntents: undefined,
      swap: { ...testnet.swap, oneClick: retiredOneClick }
    };
    expect(mainnetOneClickConfig(retiredOnly)).toBeUndefined();
  });
});
