import { useState } from 'react';

import { TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import actualPlatform from '../../../src/lib/platform';

const params = new URLSearchParams(window.location.search);
const longContent = params.has('long');
export const TOKEN_DETAIL_FIXTURE_ID = params.has('missing')
  ? 'mtst1ar3nfx83zanxz5ftttzdakrwcuw5fcz0'
  : TEST_TOKEN_IETH.faucetId;
const tokenId = TOKEN_DETAIL_FIXTURE_ID;
const token = {
  tokenId,
  balance: 987654321.123456,
  metadata: {
    name: 'Synthetic Testnet Asset with a Long Display Name',
    symbol: 'IETH',
    decimals: 8,
    description: longContent
      ? 'A test-only asset description with enough words to wrap cleanly across a narrow token detail panel.'
      : 'A test-only asset used to verify token detail layout.'
  }
};

const priceInfo = { price: 1234.5678, change24h: -29.6296, percentageChange24h: -2.4 };
const storeState = {
  tokenPrices: { ETH: priceInfo },
  tokenMetadataOverrides: {},
  setTokenMetadataOverride: async () => undefined,
  clearTokenMetadataOverride: async () => undefined
};

export const useAppEnv = () => ({ fullPage: false, sidePanel: params.has('sidePanel') || params.has('mobile') });
export const useAccount = () => ({ publicKey: 'synthetic-account' });
export const useMidenContext = (): never => {
  throw new Error('The background price service is outside the TokenDetail visual fixture');
};
export const useAllBalances = () => ({
  data: [{ ...token, metadata: params.has('missing') ? undefined : token.metadata }],
  isLoading: false
});
export const useAllTokensBaseMetadata = () => (params.has('missing') ? {} : { [tokenId]: token.metadata });
export const useWalletStore = <T,>(selector: (state: typeof storeState) => T): T => selector(storeState);
export const useBridgeConfigSnapshot = (): BridgeConfigSnapshot => ({
  network: MIDEN_NETWORK_NAME.TESTNET,
  status: 'ready',
  config: null,
  derived: null,
  lastFetch: null
});
export const useRetryableSWR = () => ({
  data: [
    { time: 1_700_000_000_000, value: 1220 },
    { time: 1_700_000_060_000, value: 1230 },
    { time: 1_700_000_120_000, value: 1234.5678 }
  ]
});
export const useTokenVerification = () => (params.has('unverified') ? 'unverified' : 'verified');
export const useTokenLogoUri = () => undefined;

export const useHiddenTokens = () => {
  const [hidden, setHidden] = useState(false);
  return {
    loaded: true,
    unreadable: false,
    canHide: () => true,
    isHidden: () => hidden,
    hide: async () => {
      setHidden(true);
      return true;
    },
    unhide: async () => {
      setHidden(false);
      return true;
    }
  };
};

export const useHideNavbarWhileOpen = () => undefined;
export const useHideForegroundDappWhileOpen = () => undefined;
export const useUserVisibleError = () => undefined;
export const NetworkModeBanner = () => null;
export const hapticLight = () => undefined;
export const hapticMedium = () => undefined;
export const hapticSelection = () => undefined;
export const openExternalUrl = async () => undefined;
export const goBack = () => undefined;
export const navigate = (destination: string | { pathname: string; search?: string }) => {
  const path = typeof destination === 'string' ? destination : `${destination.pathname}${destination.search ?? ''}`;
  window.location.hash = path;
};

export const getEffectiveNetworkName = () => MIDEN_NETWORK_NAME.TESTNET;
export const getTestNetworkNameKey = () => 'testnet';
export const peekTokenPriceAssets = () => new Map([[tokenId, 'ETH']]);
export const canOverrideMetadata = () => true;
export const isMobile = () => params.has('mobile');
export const isExtension = () => params.has('sidePanel');
export const isCapacitor = isMobile;
export const getPlatform = () => (isMobile() ? 'mobile' : isExtension() ? 'extension' : 'web');
export const platform = { ...actualPlatform, isMobile, isExtension, isCapacitor, getPlatform };
export default platform;

export * from '../../../src/lib/platform';
export * from '../../../src/lib/miden-chain/effective-endpoints';
export * from '../../../src/lib/miden/metadata/overrides';
export * from '../../../src/lib/token-list/runtime';
export { pricesLoaded, quotedPrice } from '../../../src/lib/prices/binance';
export type { Timeframe, TokenPriceInfo } from '../../../src/lib/prices/binance';
export { fetchKlineData } from '../../../src/lib/prices/feed';
