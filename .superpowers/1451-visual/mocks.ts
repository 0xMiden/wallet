const wallet = { assetsMetadata: {} };

export const useWalletStore = <T,>(selector: (state: typeof wallet) => T): T => selector(wallet);
export default function useNativeFeeFaucetId(): null {
  return null;
}
