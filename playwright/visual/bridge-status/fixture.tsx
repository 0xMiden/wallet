import type { ITransaction } from 'lib/miden/db/types';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

export { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from '../../../src/lib/miden-chain/networks-config';
function unavailable() {
  throw new Error('Live wallet operations are unavailable in the bridge fixture');
}

export const getNetworkId = unavailable;
export const getRpcEndpoint = unavailable;
export const initBridgeConfig = unavailable;

export { DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from '../../../src/lib/miden/metadata/defaults';

export const phase = new URLSearchParams(window.location.search).has('received') ? 'received' : 'ready';
const faucetId = 'fixture-usdcx';
const row: ITransaction = {
  id: 'fixture-deposit',
  type: 'bridged-receive',
  accountId: 'fixture-account',
  faucetId,
  amount: phase === 'received' ? 5_000_000n : 0n,
  status: 2,
  initiatedAt: 1,
  completedAt: 1,
  displayMessage: 'Bridging in',
  displayIcon: 'DEFAULT',
  extraInputs: {
    provider: 'usdcx',
    sourceChainId: 8453,
    sourceAddress: '0x0000000000000000000000000000000000000000',
    sourceAmount: '5',
    sourceSymbol: 'USDC',
    outputAmount: '5',
    outputSymbol: 'USDCx',
    phase
  }
};

const store: { assetsMetadata: Record<string, { name: string; symbol: string; decimals: number }> } = {
  assetsMetadata: {
    [faucetId]: { name: 'USDCx', symbol: 'USDCx', decimals: 6 }
  }
};

export const useTransactionRow = () => ({ row, loaded: true, readFailed: false });
export const useWalletStore = <T,>(select: (state: typeof store) => T) => select(store);
export default function useMidenFaucetId() {
  return null;
}

export const getTokensBaseMetadata = async (token: string) => store.assetsMetadata[token];
export const getTokenMetadata = getTokensBaseMetadata;
export const getSdkSyncedNativeAssetIdSync = () => null;
export const getNativeAssetId = async () => {
  throw new Error('RPC is unavailable in the bridge fixture');
};
export const getNativeAssetIdSync = () => null;
export const getNativeAssetMetadataSync = () => null;
export const getNativeAssetMetadata = async () => null;
export const getEffectiveNetworkName = () => MIDEN_NETWORK_NAME.MAINNET;
export const getTestNetworkNameKey = () => null;
export const getEffectiveRpcUrl = () => '';
export const peekTokenPriceAssets = () => new Map();
export const useBridgeConfigSnapshot = (): BridgeConfigSnapshot => ({
  network: MIDEN_NETWORK_NAME.MAINNET,
  status: 'ready',
  config: null,
  derived: null,
  lastFetch: null
});
export const getBridgeConfigSnapshot = useBridgeConfigSnapshot;

export const useHideNavbarWhileOpen = () => undefined;
export const useCommandWorkbenchSlots = () => null;
export const useUserVisibleError = () => undefined;
export const hapticLight = () => undefined;
export const hapticMedium = () => undefined;
export const hapticSelection = () => undefined;
export const openExternalUrl = async () => {
  throw new Error('External navigation is unavailable in the bridge fixture');
};
export const UsdcxExecuteAction = () => {
  throw new Error('Executing transactions is unavailable in the bridge fixture');
};
