import { expect, test as bridgeTest } from './hermetic-bridge';
import {
  localnetEpochDocument,
  type BridgeConfigDocument,
  type NearIntentsDocumentSection
} from '../helpers/fake-bridge-config';
import { FAKE_NEAR_INTENTS_ORIGIN_TOKENS, FakeOneClickService } from '../helpers/fake-one-click-service';
import type { OneClickAsset } from '../../../src/lib/one-click/types';

/** The 1Click asset id of the Miden token that a deposit delivers, and its key in the document. */
const MIDEN_ASSET_ID = 'miden:local-one-click';
const MIDEN_ASSET_KEY = 'mlocal';
const MIDEN_SYMBOL = 'MLOCAL';

function originToken(blockchain: string): OneClickAsset {
  const token = FAKE_NEAR_INTENTS_ORIGIN_TOKENS.find(asset => asset.blockchain === blockchain);
  if (!token) throw new Error(`The fake 1Click service lists no ${blockchain} token`);
  return token;
}

/** The origin chain and token that the suite pays from: Solana, a chain that is not an EVM chain. */
const ORIGIN_CHAIN_ID = 'sol';
const ORIGIN_TOKEN_SYMBOL = 'SOL';
const ORIGIN_TOKEN_ASSET_ID = originToken(ORIGIN_CHAIN_ID).assetId;

export interface HermeticOneClickFixture {
  service: FakeOneClickService;
  /**
   * Serve a document whose `nearIntents` section delivers the local faucet `faucetId` from Solana and Bitcoin, and
   * give the fake service the same tokens. Each call raises the document version, so a running wallet accepts it.
   */
  configureNearIntents(faucetId: string, decimals: number): BridgeConfigDocument;
}

export const test = bridgeTest.extend<{}, { oneClick: HermeticOneClickFixture }>({
  oneClick: [
    async ({ bridgeConfig }, use) => {
      const service = new FakeOneClickService({ tokens: [...FAKE_NEAR_INTENTS_ORIGIN_TOKENS] });
      await service.start();
      let version = 2;
      await use({
        service,
        configureNearIntents(faucetId, decimals) {
          const sol = originToken('sol');
          const btc = originToken('btc');
          const nearIntents: NearIntentsDocumentSection = {
            serviceUrl: service.baseUrl,
            midenAssets: { [MIDEN_ASSET_KEY]: { assetId: MIDEN_ASSET_ID, faucetId, decimals } },
            chains: {
              sol: {
                name: 'Solana',
                addressKind: 'solana',
                tokens: { SOL: { assetId: sol.assetId, decimals: sol.decimals, miden: [MIDEN_ASSET_KEY] } }
              },
              btc: {
                name: 'Bitcoin',
                addressKind: 'bitcoin',
                tokens: { BTC: { assetId: btc.assetId, decimals: btc.decimals, miden: [MIDEN_ASSET_KEY] } }
              }
            }
          };
          const document: BridgeConfigDocument = {
            ...localnetEpochDocument(),
            version: version++,
            nearIntents,
            features: { ...localnetEpochDocument().features, nearIntents: true }
          };
          service.setTokens([
            ...FAKE_NEAR_INTENTS_ORIGIN_TOKENS,
            { assetId: MIDEN_ASSET_ID, blockchain: 'miden', symbol: MIDEN_SYMBOL, decimals }
          ]);
          bridgeConfig.setDocument(document);
          return document;
        }
      });
      await service.stop();
    },
    { scope: 'worker', auto: true }
  ]
});

export { MIDEN_ASSET_ID, MIDEN_SYMBOL, ORIGIN_CHAIN_ID, ORIGIN_TOKEN_ASSET_ID, ORIGIN_TOKEN_SYMBOL };
export { expect };
