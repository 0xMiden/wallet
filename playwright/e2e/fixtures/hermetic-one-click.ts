import { expect, test as bridgeTest } from './hermetic-bridge';
import { FakeOneClickService } from '../helpers/fake-one-click-service';
import { localnetEpochDocument, type BridgeConfigDocument } from '../helpers/fake-bridge-config';

const MIDEN_ASSET_ID = 'miden:local-one-click';
const ETH_ASSET_ID = 'nep141:eth.omft.near';

export interface HermeticOneClickFixture {
  service: FakeOneClickService;
  configureMidenAsset(faucetId: string, decimals: number): void;
}

export const test = bridgeTest.extend<{}, { oneClick: HermeticOneClickFixture }>({
  oneClick: [
    async ({ bridgeConfig }, use) => {
      const service = new FakeOneClickService({
        tokens: [
          { assetId: ETH_ASSET_ID, blockchain: 'eth', symbol: 'ETH', decimals: 18, contractAddress: 'native' }
        ]
      });
      await service.start();
      let version = 2;
      await use({
        service,
        configureMidenAsset(faucetId, decimals) {
          const document: BridgeConfigDocument = {
            ...localnetEpochDocument(),
            version: version++,
            supportedEvmChains: {
              ...localnetEpochDocument().supportedEvmChains,
              ethereum: { chainId: 1, bridges: {} }
            },
            swap: {
              oneClick: {
                serviceUrl: service.baseUrl,
                midenAssets: [{ assetId: MIDEN_ASSET_ID, faucetId, decimals }]
              }
            },
            features: { ...localnetEpochDocument().features, nearIntents: true }
          };
          service.setTokens([
            { assetId: MIDEN_ASSET_ID, blockchain: 'miden', symbol: 'MLOCAL', decimals },
            { assetId: ETH_ASSET_ID, blockchain: 'eth', symbol: 'ETH', decimals: 18, contractAddress: 'native' }
          ]);
          bridgeConfig.setDocument(document);
        }
      });
      await service.stop();
    },
    { scope: 'worker', auto: true }
  ]
});

export { MIDEN_ASSET_ID, ETH_ASSET_ID };
export { expect };
