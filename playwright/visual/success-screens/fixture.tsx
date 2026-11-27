import testnetList from '../../../src/lib/token-list/snapshot/testnet.json';
// Hermetic visual fixture for the success screens: production components, mocked store and config,
// and NO transaction capability.
// The testnet token list's own faucet ids, so the real logos resolve.

export const USDCX = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0';
export const IETH = 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h';
const assetsMetadata = {
  [USDCX]: { symbol: 'USDCX', name: 'USDCX', decimals: 6 },
  // Testnet names this token "Test iETH" through midenTokenLabel; the stubbed config cannot, so the symbol carries it.
  [IETH]: { symbol: 'Test iETH', name: 'Test iETH', decimals: 18 }
};
export const useWalletStore = <T,>(selector: (state: { assetsMetadata: typeof assetsMetadata }) => T): T =>
  selector({ assetsMetadata });
export default function useMidenFaucetId() {
  return USDCX;
}
export const navigate = () => undefined;
export const goBack = () => undefined;
// The verified list's logo for the faucet, read from the bundled testnet snapshot.
const LOGOS = new Map(testnetList.tokens.map(token => [token.faucetId, (token as { logoURI?: string }).logoURI]));
export const useTokenLogoUri = (faucetId?: string) => (faucetId ? LOGOS.get(faucetId) : undefined);
export const getCurrentLocale = () => 'en';
export const getNumberSymbols = () => ({ decimal: '.', group: ',' });
export const hapticLight = () => undefined;
export const hapticMedium = () => undefined;
export const hapticSelection = () => undefined;
export const hapticSuccess = () => undefined;
export const hapticError = () => undefined;
export const isMobile = () => false;
export const isIOS = () => false;
export const isAndroid = () => false;
export const isExtension = () => false;
export const isDesktop = () => false;
export const getEffectiveExplorerUrl = () => '';
export const getEffectiveGuardianUrl = () => '';
export const getEffectiveNetworkName = () => 'testnet';
export const getEffectiveRpcUrl = () => '';
export const getTestNetworkNameKey = () => 'testnet';
export const getNativeAssetIdSync = () => USDCX;
export const getNativeAssetMetadataSync = () => assetsMetadata[USDCX];
export const getNativeAssetMetadata = async () => assetsMetadata[USDCX];
export const getSdkSyncedNativeAssetIdSync = getNativeAssetIdSync;
export const useHideNavbarWhileOpen = () => undefined;
const bridgeSnapshot = { network: 'testnet', config: undefined, derived: undefined, status: 'idle' };
export const useBridgeConfigSnapshot = () => bridgeSnapshot;
export const useCurrentGuardianEndpoint = () => undefined;

// --- dApp confirm window ---------------------------------------------------------------------
export const ACCOUNT = { name: 'Account 1', publicKey: 'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec', isPublic: false };
export const useAccount = () => ACCOUNT;
const base = {
  origin: 'https://app.darwin.market',
  networkRpc: 'https://rpc.testnet.miden.io',
  appMeta: { name: 'Darwin', description: '', iconUri: '' }
};
export const DAPP_PAYLOADS: Record<string, unknown> = {
  connect: { type: 'connect', ...base, privateDataPermission: 'UPON_REQUEST', existingPermission: false, allowedPrivateData: 0 },
  'connect-auto': { type: 'connect', ...base, privateDataPermission: 'AUTO', existingPermission: false, allowedPrivateData: 1 | 2 | 4 },
  send: {
    type: 'transaction',
    ...base,
    sourcePublicKey: ACCOUNT.publicKey,
    preview: {},
    transactionMessages: [
      'Transfer note from faucet:',
      USDCX,
      `From, ${ACCOUNT.publicKey}`,
      'Amount, -12.5',
      'Recipient, mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x',
      'Note Type, Private'
    ]
  },
  consume: {
    type: 'consume',
    ...base,
    sourcePublicKey: ACCOUNT.publicKey,
    noteId: '0x399bc0d24a9f7be1c61e07a4d2be5149',
    transactionMessages: ['Consuming note', 'Amount, 0.98', 'Note Type, Private']
  },
  sign: {
    type: 'sign',
    ...base,
    sourcePublicKey: ACCOUNT.publicKey,
    payload: 'c2lnbmluZy1pbnB1dHM=',
    kind: 'signingInputs',
    preview: {},
    messageElements: ['1', '2', '3']
  },
  privateNotes: { type: 'privateNotes', ...base, sourcePublicKey: ACCOUNT.publicKey, preview: {} },
  assets: { type: 'assets', ...base, sourcePublicKey: ACCOUNT.publicKey, preview: {} }
};
const pending = () => new Promise<never>(() => undefined);
const midenContext = {
  ready: true,
  getDAppPayload: async (id: string) => DAPP_PAYLOADS[id],
  confirmDAppPermission: pending,
  confirmDAppTransaction: pending,
  confirmDAppPrivateNotes: pending,
  confirmDAppSign: pending,
  confirmDAppAssets: pending,
  confirmDAppImportPrivateNote: pending,
  confirmDAppConsumableNotes: pending,
  confirmDAppUnlock: pending,
  simulateCustomTransaction: pending
};
export const useMidenContext = () => midenContext;
// A dApp-window frame inside the single file has no address to read ?id= from, so it is told directly.
const frameId = (globalThis as { __DAPP_ID__?: string }).__DAPP_ID__;
const location = { search: frameId ? `?id=${frameId}` : window.location.search, pathname: '/', hash: '', state: null, trigger: 'push' };
export const useLocation = () => location;
export const HistoryAction = { Push: 'push', Replace: 'replace', Pop: 'pop' } as const;
export const fetchTokenMetadata = async (id: string) =>
  assetsMetadata[id as keyof typeof assetsMetadata] ?? assetsMetadata[USDCX];
export * from './auto-stubs';
