import testnet from '../../../src/lib/remote-config/testing/testnet.json';
import { mainnetOneClickConfig } from './mainnet-one-click-config';

const oneClick = {
  serviceUrl: 'https://one-click.example',
  midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
};

function mainnetDocument(nearIntentsEnabled?: boolean) {
  return {
    ...testnet,
    network: 'mainnet',
    features: {
      ...testnet.features,
      ...(nearIntentsEnabled === undefined ? {} : { nearIntents: nearIntentsEnabled })
    },
    swap: { ...testnet.swap, oneClick }
  };
}

describe('mainnet 1Click config rollout gate', () => {
  it('keeps a configured service and mapped assets unavailable when the feature is absent or false', () => {
    expect(mainnetOneClickConfig(mainnetDocument())).toBeUndefined();
    expect(mainnetOneClickConfig(mainnetDocument(false))).toBeUndefined();
  });

  it('uses the configured route only when the wallet-config switch is explicitly true', () => {
    expect(mainnetOneClickConfig(mainnetDocument(true))).toEqual(oneClick);
  });
});
