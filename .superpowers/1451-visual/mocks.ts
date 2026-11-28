const wallet = { assetsMetadata: {} };

export const useWalletStore = <T,>(selector: (state: typeof wallet) => T): T => selector(wallet);
export const getTokensBaseMetadata = async () => undefined;
export const useAllTokensBaseMetadata = () => wallet.assetsMetadata;
const unsupportedWalletOperation = () => {
  throw new Error('The bridge visual fixture cannot call the wallet backend');
};
export const putToStorage = unsupportedWalletOperation;
export const searchAssets = unsupportedWalletOperation;
export default function useNativeFeeFaucetId(): null {
  return null;
}
