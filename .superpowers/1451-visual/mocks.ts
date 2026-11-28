const wallet = { assetsMetadata: {} };

export const useWalletStore = <T,>(selector: (state: typeof wallet) => T): T => selector(wallet);
export const faucetMetadataOf = () => undefined;
export const getIntercom = () => {
  throw new Error('The bridge visual fixture cannot call the wallet backend');
};
export default function useNativeFeeFaucetId(): null {
  return null;
}
