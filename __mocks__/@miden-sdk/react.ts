/**
 * Automatic mock for @miden-sdk/react.
 *
 * Prevents WASM initialization (installAccountBech32) when any test file
 * transitively imports @miden-sdk/react via the balance/front module chain.
 *
 * Tests that need specific hook behavior should override with jest.mock()
 * in their own test file.
 */

const noop = () => {};
const noopAsync = async () => {};

export const MidenProvider = ({ children }: any) => children;

export const useMiden = () => ({
  client: null,
  isReady: false,
  runExclusive: async (fn: any) => fn(),
  sync: noopAsync,
  prover: null
});

export const useSyncState = () => ({
  isSyncing: false,
  lastSyncBlock: null,
  lastSyncTime: null,
  error: null
});

export const useSyncControl = () => ({
  pauseSync: noop,
  resumeSync: noop
});

export const useAccount = jest.fn(() => ({
  assets: [],
  isLoading: false,
  refetch: noopAsync
}));

export const useSend = () => ({
  send: noopAsync,
  result: null,
  isLoading: false,
  stage: 'idle',
  error: null,
  reset: noop
});

export const useConsume = () => ({
  consume: noopAsync,
  result: null,
  isLoading: false,
  stage: 'idle',
  error: null,
  reset: noop
});

export const useNotes = () => ({
  notes: [],
  consumableNotes: [],
  noteSummaries: [],
  consumableNoteSummaries: [],
  isLoading: false,
  error: null,
  refetch: noopAsync
});

export const useAssetMetadata = () => ({
  metadata: {},
  isLoading: false
});

export const useTransactionHistory = () => ({
  transactions: [],
  isLoading: false
});

export const useImportNote = () => ({
  importNote: noopAsync,
  isImporting: false,
  error: null,
  reset: noop
});

export const useExportNote = () => ({
  exportNote: noopAsync,
  isExporting: false,
  error: null,
  reset: noop
});

export const useExportStore = () => ({
  exportStore: noopAsync,
  isExporting: false,
  error: null,
  reset: noop
});

export const useImportStore = () => ({
  importStore: noopAsync,
  isImporting: false,
  error: null,
  reset: noop
});

export const useWaitForCommit = () => ({
  waitForCommit: noopAsync
});

export const useMidenClient = () => ({
  client: null,
  isReady: false
});

export const SignerContext = {
  Provider: ({ children }: any) => children,
  Consumer: ({ children }: any) => children?.(null)
};
