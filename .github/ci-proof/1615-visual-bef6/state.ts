import { testBridgeSnapshot } from '../../../src/lib/remote-config/testing/fixture';
import { forbidden } from './rpc';

export const FAUCET = '0x4cbdcaffe75f0a317482224dae6436';
export const ACCOUNT = '0x8da911727d5b53916f2c221c00c091';
const metadata = { symbol: 'USDCX', name: 'USDCX', decimals: 6, scaleIsUnknown: false };
const balances = [{ tokenId: FAUCET, metadata, balance: 100 }];
const snapshot = testBridgeSnapshot();
const store = {
  tokenPrices: {},
  assetsMetadata: { [FAUCET]: metadata },
  setLastCompletedTxHash: () => forbidden('setLastCompletedTxHash'),
  assessSpendingLimit: () => forbidden('assessSpendingLimit'),
  readSpendingLimit: () => forbidden('readSpendingLimit')
};

export const useAccount = () => ({ publicKey: ACCOUNT, name: 'Fixture account', type: 'guardian' });
export const useAllTokensBaseMetadata = () => ({ [FAUCET]: metadata });
export const useAllBalances = () => ({ data: balances });
export function useWalletStore<T>(select: (state: typeof store) => T): T {
  return select(store);
}
useWalletStore.getState = () => store;
export const getNativeAssetIdSync = () => FAUCET;
export const getNativeAssetId = async () => FAUCET;
export const getSdkSyncedNativeAssetIdSync = getNativeAssetIdSync;
export const getNativeAssetMetadataSync = () => metadata;
export const getNativeAssetMetadata = async () => metadata;
export const getVerificationBaseFeeSync = () => 7;
export const getVerificationBaseFee = async () => 7;
export const onNativeAssetChanged = () => () => undefined;
export const getEffectiveNetworkName = () => 'testnet';
export const getTestNetworkNameKey = () => 'testnet';
export const getEffectiveRpcUrl = () => 'http://127.0.0.1:5191/forbidden-rpc';
export const getEffectiveExplorerUrl = () => '';
export const getEffectiveGuardianUrl = () => '';
export const getEffectiveFeeFaucetId = () => FAUCET;
export const getBridgeConfigSnapshot = () => snapshot;
export const subscribeBridgeConfig = () => () => undefined;
export const initBridgeConfig = async () => snapshot;
export const holdFastPoll = () => () => undefined;
export const useTokenLogoUri = () => undefined;
export { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from '../../../src/lib/miden/metadata/defaults';
export const getTokenMetadata = () => forbidden('getTokenMetadata');
