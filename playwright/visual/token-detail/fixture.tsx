import { useState } from 'react';

import type { PendingActivityItem } from 'app/templates/history/PendingActivityCard';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import actualPlatform from '../../../src/lib/platform';

const params = new URLSearchParams(window.location.search);
const scenario = params.get('state') ?? 'fresh';
export const TOKEN_DETAIL_FIXTURE_ID = TEST_TOKEN_IETH.faucetId;
const tokenId = TOKEN_DETAIL_FIXTURE_ID;
const metadata = {
  name: 'Synthetic test asset',
  symbol: 'IETH',
  decimals: 8,
  description: 'Synthetic test asset for token detail state acceptance.'
};
const token = { tokenId, balance: 2.5, metadata };
const marketQuote = {
  price: 4,
  change24h: 0.04,
  percentageChange24h: 1,
  provider: 'binance' as const,
  observedAt: Date.now() - 60_000
};
const tokenPrices =
  scenario === 'fresh'
    ? { ETH: marketQuote }
    : scenario === 'stale'
      ? { ETH: { ...marketQuote, observedAt: Date.now() - 10 * 60_000 - 1 } }
      : scenario === 'unavailable-source'
        ? { ETH: { price: 4, change24h: 0, percentageChange24h: 0, observedAt: Date.now() - 60_000 } }
        : scenario === 'unavailable'
          ? { BTC: marketQuote }
          : {};
const storeState = {
  tokenPrices,
  tokenMetadataOverrides: {},
  setTokenMetadataOverride: async () => undefined,
  clearTokenMetadataOverride: async () => undefined
};

const claimNote = (id: string, faucetId: string): ClaimableNoteWithMetadata => ({
  id,
  faucetId,
  amount: '25000000',
  senderAddress: 'mtst1synthetic-sender',
  isBeingClaimed: false,
  type: 'unknown',
  receivedAt: 1_700_000_000,
  metadata: { ...metadata }
});
const claimItems: PendingActivityItem[] = [
  { note: claimNote('pending-ieth', tokenId), status: 'pending' },
  { note: claimNote('same-symbol-other-token', 'mtst1otherfaucet'), status: 'pending' }
];
const account = { publicKey: 'synthetic-account' };

export const useAppEnv = () => ({ fullPage: false, sidePanel: params.has('sidePanel') || params.has('mobile') });
export const useAccount = () => account;
export const useMidenContext = (): never => {
  throw new Error('The background price service is outside the TokenDetail visual fixture');
};
export const useAllBalances = () => ({
  data: scenario === 'loading' ? undefined : [{ ...token }],
  isLoading: scenario === 'loading'
});
export const useAllTokensBaseMetadata = () => ({ [tokenId]: metadata });
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
    { time: 1_700_000_000_000, value: 3.9 },
    { time: 1_700_000_060_000, value: 4 },
    { time: 1_700_000_120_000, value: 4.04 }
  ]
});
export const useTokenVerification = () => 'verified';
export const useTokenLogoUri = () => undefined;
export const useActivityClaims = () => ({
  items: scenario === 'loading' || scenario === 'loading-history' ? [] : claimItems,
  accept: async () => undefined,
  acceptMany: async () => undefined,
  retryHeld: async () => undefined,
  cannotPayFee: () => false,
  account,
  isLoadingNotes: scenario === 'loading' || scenario === 'loading-history'
});
export const useActivityHiddenNotes = () => ({
  loaded: true,
  ids: new Set<string>(),
  hide: async () => true,
  restore: async () => true
});
export const useConfirm = () => async () => false;

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

export { hasExtensionRuntime, reloadInPlace, isIOS, isAndroid, isTauri, isDesktop } from '../../../src/lib/platform';
export type { PlatformType } from '../../../src/lib/platform';
export {
  ENDPOINT_OVERRIDE_STORAGE_KEY,
  getActiveOverride,
  hasDeveloperNetworkChoice,
  getEffectiveRpcUrl,
  getEffectiveRpcEndpoint,
  getEffectiveProverUrl,
  getEffectiveNoteTransportUrl,
  isNoteTransportConfigured,
  getEffectiveFaucetUrl,
  getEffectiveFaucetApiUrl,
  isFaucetConfigured,
  getEffectiveExplorerUrl,
  getEffectiveGuardianUrl,
  getEffectiveAllowNoGuardian,
  FEE_FAUCET_STORAGE_KEY,
  setFeeFaucetIdForTest,
  getEffectiveFeeFaucetId,
  getEndpointState,
  adoptEndpointState,
  sameEndpointState,
  getEffectiveDefaultGuardianEndpoint,
  buildDefaultOverrideFor,
  buildNetworkChoiceOverride,
  whenEndpointOverridesLoaded,
  loadEndpointOverrides,
  applyEndpointOverride,
  forgetDeveloperNetworkChoice,
  clearEndpointOverride,
  isNetworkChoiceOverride,
  hasCustomEndpointOverride,
  provenBadgeNetwork,
  isEndpointOverrideActive
} from '../../../src/lib/miden-chain/effective-endpoints';
export type { EndpointOverride, EndpointState } from '../../../src/lib/miden-chain/effective-endpoints';
export {
  TOKENS_METADATA_OVERRIDES_STORAGE_KEY,
  TOKEN_NAME_MAX_LENGTH,
  TOKEN_SYMBOL_MAX_LENGTH,
  TOKEN_DECIMALS_MAX,
  isValidTokenName,
  isValidTokenSymbol,
  isValidTokenDecimals,
  isNativeFaucetId,
  applyMetadataOverride,
  overrideFor,
  applyOverrideFor,
  parseTokenMetadataOverrides,
  getTokenMetadataOverrides,
  writeTokenMetadataOverride
} from '../../../src/lib/miden/metadata/overrides';
export type { TokenMetadataOverride, TokenMetadataOverrides } from '../../../src/lib/miden/metadata/overrides';
export {
  _resetTokenListForTest,
  onTokenListUpdated,
  loadVerifiedFaucetIds,
  loadTokenLogos,
  peekVerifiedFaucetIds,
  peekTokenLogos,
  loadTokenPriceAssets,
  loadTokenFaucetsBySymbol
} from '../../../src/lib/token-list/runtime';
export { pricesLoaded, quotedPrice } from '../../../src/lib/prices/binance';
export type { Timeframe, TokenPriceInfo } from '../../../src/lib/prices/binance';
export { fetchKlineData } from '../../../src/lib/prices/feed';
