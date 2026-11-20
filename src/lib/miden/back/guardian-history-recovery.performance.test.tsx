import React from 'react';

import { act, cleanup, render } from '@testing-library/react';
import type { DeltaObject, HistoryEntry, HistoryPage, Signer } from '@openzeppelin/guardian-client';
import type { Transaction } from 'dexie';
import { SWRConfig } from 'swr';

import { PageActiveContext } from 'app/layouts/page-active';
import History from 'app/templates/history/History';
import { fetchGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import { MidenContextProvider } from 'lib/miden/front/client';
import { clearGuardianHistoryCheckpoints, readGuardianHistoryState } from 'lib/miden/guardian/history-storage';
import { transactions } from 'lib/miden/repo';
import type { GuardianSummary } from 'lib/miden/sdk/guardian-history';
import { WalletMessageType, WalletStatus, type WalletAccount } from 'lib/shared/types';
import { WalletStoreProvider } from 'lib/store/WalletStoreProvider';
import { WalletType } from 'screens/onboarding/types';

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: () => false,
  hasExtensionRuntime: () => false,
  isMobile: () => false,
  isDesktop: () => false
}));
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, mockStorage.get(key)])),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        mockStorage.set(key, value);
        if (key === 'guardian_history_recovery_v1' && mockHarness) mockHarness.observeCheckpoints(value);
      }
    },
    remove: async (keys: string[]) => {
      for (const key of keys) mockStorage.delete(key);
    }
  })
}));
jest.mock('lib/intercom', () => ({
  ...jest.requireActual('lib/intercom/types'),
  createIntercomClient: () => mockIntercom,
  IntercomClient: class {
    request = (request: { type: WalletMessageType }) => mockIntercom.request(request);
    subscribe = () => () => undefined;
  }
}));
jest.mock('lib/intercom/client', () => ({ createIntercomClient: () => mockIntercom }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://synthetic-node.invalid',
  provenBadgeNetwork: () => 'testnet'
}));
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  getGuardianEndpointsForNetwork: () => mockHarness.operators
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  cacheScope: () => 'synthetic-node|testnet',
  getNativeAssetIdSync: () => 'synthetic-native',
  getNativeAssetId: async () => 'synthetic-native',
  onNativeAssetChanged: () => () => undefined
}));
jest.mock('lib/remote-config/runtime', () => {
  const fixtures = jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>(
    'lib/epoch/testing/bridge-config'
  );
  return fixtures.remoteConfigRuntimeMock(() => fixtures.TEST_BRIDGE_CONFIG_SNAPSHOT);
});
jest.mock('lib/miden/metadata/utils', () => ({
  ...jest.requireActual('lib/miden/metadata/utils'),
  getTokenMetadata: async () => ({ symbol: 'SYN', name: 'Synthetic', decimals: 0 })
}));
jest.mock('lib/miden/guardian/account', () => ({
  ...jest.requireActual('lib/miden/guardian/account'),
  getSignerDetailsFromAccount: async () => ({ commitment: 'synthetic-signer' }),
  resolveGuardianEndpoint: () => 'https://current.synthetic.invalid'
}));
jest.mock('lib/miden/guardian/native-http', () => ({
  ...jest.requireActual('lib/miden/guardian/native-http'),
  registerGuardianOrigin: () => undefined
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (left: string, right: string) => left === right
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (operation: (hold: object) => Promise<unknown>) => mockHarness.lock(operation),
  getCurrentWasmLockHold: () => mockHarness.hold,
  assertWasmHoldCurrent: (hold: object) => {
    if (hold !== mockHarness.hold) throw new Error('Synthetic WASM hold lost');
  }
}));
jest.mock('lib/miden/guardian/signer', () => ({
  WalletSigner: class {
    readonly scheme = 'ecdsa';
    constructor(readonly publicKey: string, readonly commitment: string) {}
    signRequest = async () => mockHarness.authenticate();
    signAccountIdWithTimestamp = async () => mockHarness.authenticate();
    signCommitment = async () => mockHarness.authenticate();
  }
}));
jest.mock('@openzeppelin/guardian-client', () => ({
  ...jest.requireActual('@openzeppelin/guardian-client'),
  GuardianHttpError: class extends Error {},
  GuardianHttpClient: class {
    private signer?: Signer;
    constructor(private readonly endpoint: string) {}
    setSigner(signer: Signer) {
      this.signer = signer;
    }
    getState = async () => ({ createdAt: '2026-01-01T00:00:00Z' });
    getDeltaProposals = async () => [];
    getDeltaHistory = async (_account: string, options: { cursor?: string }): Promise<HistoryPage> =>
      mockHarness.page(this.endpoint, options.cursor);
    getDelta = async (accountId: string, nonce: number): Promise<DeltaObject> => {
      const signer = this.signer;
      if (!signer) throw new Error('Synthetic client has no installed signer');
      return mockHarness.delta(this.endpoint, nonce, async () =>
        signer.signAccountIdWithTimestamp(accountId, Math.floor(Date.now() / 1000))
      );
    };
  }
}));
jest.mock('./miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: async () => ({}),
    drainPrivateNoteTransport: async () => undefined,
    importRecoveryNoteBytes: async () => ({ imported: 0, failures: 0 }),
    resolveRecoveryScanRange: async () => ({ startBlock: 0, latestBlock: 0 }),
    recoverPublicNotesRange: async () => ({ imported: 0, failures: 0 }),
    decodeGuardianHistory: (encoded: string) => mockHarness.decode(Number(encoded)),
    importGuardianHistoryP2ideNotes: (_encoded: string, _account: string, id?: string) => mockHarness.importNote(id),
    getGuardianResultCommitment: () => mockHarness.commitment()
  }
}));
jest.mock('./sync-manager', () => ({ doSync: async () => undefined }));
jest.mock('./store', () => ({
  store: { getState: () => ({ vault: mockHarness.locked ? null : mockVault }) },
  accountsUpdated: () => undefined
}));
jest.mock('./guardian-history-recovery', () => {
  const actual = jest.requireActual<typeof import('./guardian-history-recovery')>('./guardian-history-recovery');
  return {
    ...actual,
    recoverGuardianHistory: async (...args: Parameters<typeof actual.recoverGuardianHistory>) => {
      mockHarness.historyRuns++;
      mockHarness.logical = 0;
      const result = await actual.recoverGuardianHistory(...args);
      mockHarness.directResults.push(result);
      mockHarness.stamp('t_direct_recovery_return');
      return result;
    }
  };
});

const RECORDS = 1_214;
const CURRENT = 'https://current.synthetic.invalid';
const PREVIOUS = 'https://previous.synthetic.invalid';
const LOCAL_NONCE = 1_190;
const PAYBACK_NONCE = 1_165;
const ORDER_NONCE = 1_164;
const EPOCH = Date.parse('2026-11-20T00:00:00Z');
const wallNow = () => jest.getRealSystemTime();
const mockStorage = new Map<string, unknown>();
const account: WalletAccount = {
  publicKey: 'synthetic-account',
  name: 'Synthetic',
  type: WalletType.Guardian,
  isPublic: false,
  hdIndex: 0,
  coldPublicKey: 'synthetic-cold',
  authScheme: 'ecdsa',
  guardianNoteRecoveryPending: true
};
const mockIntercom = {
  request: async (request: { type: WalletMessageType }) => {
    if (request.type !== WalletMessageType.GetStateRequest) throw new Error(`Unexpected intercom ${request.type}`);
    return {
      type: WalletMessageType.GetStateResponse,
      state: { status: WalletStatus.Ready, accounts: [account], currentAccount: account, networks: [], settings: {} }
    };
  },
  subscribe: () => () => undefined
};
const mockVault = {
  setGuardianNoteRecoveryPending: async (id: string, pending: boolean) => {
    if (id !== account.publicKey || pending) throw new Error('Unexpected synthetic flag write');
    mockHarness.pending = pending;
    mockHarness.notesAtFlagClear = mockHarness.completedNotes.length;
    mockHarness.stamp('t_pending_flag_cleared');
    return [{ ...account, guardianNoteRecoveryPending: pending }];
  }
};

const timestamp = (nonce: number) => new Date(EPOCH - (RECORDS - nonce) * 1_000).toISOString();
const rowId = (nonce: number) => `guardian-history:testnet:synthetic-account:synthetic-commitment-${nonce}`;
const headKey = `completed-${rowId(RECORDS)}`;
const historyEntry = (nonce: number): HistoryEntry => ({
  nonce,
  status: 'canonical',
  timestamp: timestamp(nonce),
  newCommitment: `synthetic-commitment-${nonce}`,
  inputNotes: [],
  outputNotes: [],
  decodeWarnings: []
});
const canonicalDelta = (nonce: number): DeltaObject => ({
  accountId: account.publicKey,
  nonce,
  prevCommitment: `synthetic-commitment-${nonce - 1}`,
  newCommitment: `synthetic-commitment-${nonce}`,
  deltaPayload: { txSummary: { data: String(nonce) }, signatures: [] },
  status: { status: 'canonical', timestamp: timestamp(nonce) },
  metadata: {
    proposal: {
      proposalType:
        nonce === ORDER_NONCE ? 'swap' : nonce === PAYBACK_NONCE || nonce % 7 === 0 ? 'consume_notes' : 'p2id'
    }
  }
});
function summary(nonce: number): GuardianSummary {
  const consume = nonce === PAYBACK_NONCE || (nonce !== ORDER_NONCE && nonce % 7 === 0);
  return {
    accountId: account.publicKey,
    inputNotes: consume
      ? [{
          id: `synthetic-input-${nonce}`,
          visibility: 'public',
          sender: 'synthetic-sender',
          assets: [{ faucetId: nonce === PAYBACK_NONCE ? 'synthetic-requested' : 'synthetic-asset', amount: '7' }],
          swap: nonce === PAYBACK_NONCE ? { orderId: '77' } : undefined
        }]
      : [],
    outputNotes: [0, 1].map(index => ({
      id: `synthetic-output-${nonce}-${index}`,
      visibility: 'public',
      recipient: 'synthetic-recipient',
      assets: consume ? [] : [{ faucetId: 'synthetic-asset', amount: '7' }],
      swap: nonce === ORDER_NONCE && index === 0
        ? { orderId: '77', requestedAsset: { faucetId: 'synthetic-requested', amount: '14' } }
        : undefined
    }))
  };
}

interface Stamp {
  fakeMs: number;
  wallMs: number;
}
type HistoryResult = Awaited<ReturnType<typeof import('./guardian-history-recovery').recoverGuardianHistory>>;
class SyntheticHistory {
  readonly operators: string[];
  readonly nonces = Array.from({ length: RECORDS }, (_, index) => RECORDS - index);
  readonly due = new Map<() => void, number>();
  readonly releases = new Set<() => void>();
  readonly events: Record<string, Stamp> = {};
  readonly completedNotes: string[] = [];
  readonly requested: Array<{ endpoint: string; nonce: number }> = [];
  readonly decoded: number[] = [];
  readonly directResults: HistoryResult[] = [];
  readonly checkpointSnapshots: Array<{ operator: string; cursor?: string; completed: boolean; notes: number }> = [];
  historyRuns = 0;
  pending = true;
  locked = false;
  hold: object | null = null;
  raw = 0;
  peakRaw = 0;
  activeWasm = 0;
  peakWasm = 0;
  consumers = 0;
  peakConsumers = 0;
  logical = 0;
  peakLogical = 0;
  pageCount = 0;
  rawEntries = 0;
  commits = 0;
  inserts = 0;
  uniqueRows = 0;
  notesAtFlagClear = -1;
  authCalls = 0;
  commitmentCalls = 0;
  cancelling = false;
  pauseNote: string | undefined;
  pauseReached = false;
  pausedImport: (() => void) | undefined;
  private chain = Promise.resolve();
  private readonly startFake = Date.now();
  private readonly startWall = wallNow();

  constructor(readonly overlap: boolean) {
    this.operators = overlap ? [CURRENT, PREVIOUS] : [CURRENT];
    this.stamp('t_start');
  }
  stamp(event: string) {
    this.events[event] = { fakeMs: Date.now() - this.startFake, wallMs: wallNow() - this.startWall };
  }
  observeCheckpoints(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const checkpoints: unknown = Reflect.get(value, 'checkpoints');
    if (!checkpoints || typeof checkpoints !== 'object') return;
    const rows: unknown[] = Object.values(checkpoints);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const operator: unknown = Reflect.get(row, 'operator');
      const cursor: unknown = Reflect.get(row, 'cursor');
      if (typeof operator !== 'string') continue;
      this.checkpointSnapshots.push({
        operator,
        cursor: typeof cursor === 'string' ? cursor : undefined,
        completed: Reflect.get(row, 'completed') === true,
        notes: this.completedNotes.length
      });
    }
    if (rows.length === this.operators.length && rows.every(row =>
      row !== null && typeof row === 'object' && Reflect.get(row, 'completed') === true
    )) this.stamp('t_all_checkpoints_done');
  }
  async delay(ms: number) {
    if (this.cancelling) return;
    const deadline = Date.now() + ms;
    await new Promise<void>(resolve => {
      const release = () => {
        clearTimeout(timer);
        this.releases.delete(release);
        this.due.delete(release);
        resolve();
      };
      const timer = setTimeout(release, ms);
      this.releases.add(release);
      this.due.set(release, deadline);
    });
  }
  async lock<T>(operation: (hold: object) => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    const hold = {};
    this.hold = hold;
    try {
      return await operation(hold);
    } finally {
      this.hold = null;
      release();
    }
  }
  private async wasm(ms: number) {
    this.activeWasm++;
    this.peakWasm = Math.max(this.peakWasm, this.activeWasm);
    try {
      await this.delay(ms);
    } finally {
      this.activeWasm--;
    }
  }
  async authenticate() {
    this.authCalls++;
    await this.wasm(5);
    return 'synthetic-signature';
  }
  async page(endpoint: string, cursor?: string): Promise<HistoryPage> {
    const nonces = this.overlap && endpoint === CURRENT ? this.nonces.slice(0, 22) : this.nonces;
    const offset = cursor === undefined ? 0 : Number(cursor);
    const page = nonces.slice(offset, offset + 50);
    this.pageCount++;
    this.rawEntries += page.length;
    return {
      entries: page.map(historyEntry),
      nextCursor: offset + 50 < nonces.length ? String(offset + 50) : undefined
    };
  }
  async delta(endpoint: string, nonce: number, authenticate: () => Promise<string>) {
    this.requested.push({ endpoint, nonce });
    this.raw++;
    this.logical++;
    this.peakRaw = Math.max(this.peakRaw, this.raw);
    this.peakLogical = Math.max(this.peakLogical, this.logical);
    try {
      await authenticate();
      await this.delay(100);
      return canonicalDelta(nonce);
    } finally {
      this.raw--;
    }
  }
  private async consume<T>(ms: number, result: () => T): Promise<T> {
    this.consumers++;
    this.peakConsumers = Math.max(this.peakConsumers, this.consumers);
    try {
      return await this.lock(async () => {
        await this.wasm(ms);
        return result();
      });
    } finally {
      this.consumers--;
    }
  }
  async decode(nonce: number) {
    this.decoded.push(nonce);
    this.logical--;
    return this.consume(5, () => summary(nonce));
  }
  async importNote(id?: string) {
    if (!id) throw new Error('Missing synthetic output id');
    if (id === this.pauseNote && !this.cancelling) {
      this.pauseReached = true;
      await new Promise<void>(resolve => {
        const release = () => {
          this.releases.delete(release);
          this.pausedImport = undefined;
          resolve();
        };
        this.pausedImport = release;
        this.releases.add(release);
      });
    }
    await this.consume(50, () => undefined);
    this.completedNotes.push(id);
    this.stamp('t_all_notes_done');
  }
  async commitment() {
    this.commitmentCalls++;
    return this.consume(5, () => `synthetic-commitment-${LOCAL_NONCE}`);
  }
  cancel() {
    this.cancelling = true;
    this.locked = true;
    for (const release of [...this.releases]) release();
  }
}
let mockHarness: SyntheticHistory;

interface Backend {
  recovery: typeof import('./guardian-recovery');
  repo: typeof import('../repo');
  dispose: () => void;
}
function freshBackend(): Backend {
  let recovery!: typeof import('./guardian-recovery');
  let repo!: typeof import('../repo');
  jest.isolateModules(() => {
    repo = jest.requireActual<typeof import('../repo')>('../repo');
    recovery = jest.requireActual<typeof import('./guardian-recovery')>('./guardian-recovery');
  });
  const seen = new WeakSet<Transaction>();
  const watch = (transaction: Transaction) => {
    if (seen.has(transaction)) return;
    seen.add(transaction);
    transaction.on('complete', () => {
      mockHarness.commits++;
      mockHarness.stamp('t_last_row');
    });
  };
  const creating = (_key: string, row: ITransaction, transaction: Transaction) => {
    watch(transaction);
    transaction.on('complete', () => {
      mockHarness.inserts++;
      if (row.id === rowId(RECORDS) && !mockHarness.events.t_first_persisted_recent_row) {
        mockHarness.stamp('t_first_persisted_recent_row');
      }
    });
  };
  const updating = (_changes: object, _key: string, _row: ITransaction, transaction: Transaction) => watch(transaction);
  repo.transactions.hook('creating', creating);
  repo.transactions.hook('updating', updating);
  return {
    recovery,
    repo,
    dispose: () => {
      repo.transactions.hook('creating').unsubscribe(creating);
      repo.transactions.hook('updating').unsubscribe(updating);
      repo.db.close();
    }
  };
}

async function pump(done: () => boolean, limit = 400_000) {
  const start = Date.now();
  let idle = 0;
  while (!done() && Date.now() - start <= limit) {
    await act(async () => { await jest.advanceTimersByTimeAsync(0); });
    if (done()) return;
    const due = Math.min(...mockHarness.due.values());
    if (Number.isFinite(due)) {
      idle = 0;
      await act(async () => { await jest.advanceTimersByTimeAsync(Math.max(0, due - Date.now())); });
    } else if (++idle > 2_000) {
      throw new Error(`Synthetic barrier not reached: ${JSON.stringify({
        events: mockHarness.events,
        raw: mockHarness.raw,
        notes: mockHarness.completedNotes.length
      })}`);
    }
  }
  if (!done()) throw new Error('Synthetic fake-clock safety ceiling exceeded');
}

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;
const mockUnexpectedFetch = jest.fn(async () => { throw new Error('Unexpected live fetch in synthetic recovery'); });
beforeAll(() => {
  globalThis.fetch = mockUnexpectedFetch;
  window.matchMedia = (media: string): MediaQueryList => ({
    matches: true,
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  });
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});
afterEach(() => { cleanup(); jest.useRealTimers(); });

async function fixture(overlap: boolean) {
  mockStorage.clear();
  await transactions.clear();
  await clearGuardianHistoryCheckpoints();
  await transactions.put({
    id: 'synthetic-rich-local',
    accountId: account.publicKey,
    status: ITransactionStatus.Completed,
    type: 'execute',
    initiatedAt: Math.floor(Date.parse(timestamp(LOCAL_NONCE)) / 1000),
    completedAt: Math.floor(Date.parse(timestamp(LOCAL_NONCE)) / 1000),
    displayIcon: 'SEND',
    resultBytes: new Uint8Array([1]),
    extraInputs: { destinationAddress: 'synthetic-destination', retainedLocalDetail: 'rich-local' }
  });
  jest.useFakeTimers({ now: EPOCH, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'performance'] });
  mockHarness = new SyntheticHistory(overlap);
  const backend = freshBackend();
  const observer = new MutationObserver(() => {
    if (!mockHarness.events.t_first_visible_recent_row && document.querySelector(`[data-entry-key="${headKey}"]`)) {
      mockHarness.stamp('t_first_visible_recent_row');
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => {
      view = render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <WalletStoreProvider>
            <MidenContextProvider>
              <PageActiveContext.Provider value={true}>
                <History address={account.publicKey} fullHistory />
              </PageActiveContext.Provider>
            </MidenContextProvider>
          </WalletStoreProvider>
        </SWRConfig>
      );
    });
  } catch (error) {
    observer.disconnect();
    backend.dispose();
    throw error;
  }
  return {
    backend,
    dispose: async () => {
      mockHarness.cancel();
      try {
        await pump(() => mockHarness.raw === 0 && mockHarness.consumers === 0 &&
          mockHarness.directResults.length === mockHarness.historyRuns);
        for (let index = 0; index < 20; index++) {
          await act(async () => { await jest.advanceTimersByTimeAsync(0); });
        }
      } finally {
        try {
          await act(async () => { view?.unmount(); });
        } finally {
          observer.disconnect();
          backend.dispose();
          jest.useRealTimers();
        }
      }
    }
  };
}

async function finish(backend: Backend) {
  await pump(() => !mockHarness.pending);
  await pump(() => mockHarness.directResults.length > 0);
  const state = await readGuardianHistoryState();
  expect(Object.values(state.checkpoints)).toHaveLength(mockHarness.operators.length);
  expect(Object.values(state.checkpoints).every(checkpoint => checkpoint.completed && !checkpoint.failure)).toBe(true);
  expect(mockHarness.directResults.at(-1)).toMatchObject({ deferred: false, sourceFailures: 0, deferredSources: 0 });
  expect(mockHarness.notesAtFlagClear).toBe(mockHarness.completedNotes.length);
  expect(mockHarness.events.t_all_checkpoints_done).toBeDefined();
  expect(mockHarness.events.t_pending_flag_cleared!.fakeMs).toBeGreaterThanOrEqual(
    mockHarness.events.t_all_checkpoints_done!.fakeMs
  );
  expect(mockHarness.events.t_all_checkpoints_done!.fakeMs).toBeGreaterThanOrEqual(
    mockHarness.events.t_all_notes_done!.fakeMs
  );
  expect(mockHarness.inserts).toBe(RECORDS - 1);
  expect(await transactions.count()).toBe(RECORDS);
  expect([...new Set(mockHarness.completedNotes)].sort()).toEqual(
    mockHarness.nonces.flatMap(nonce => [0, 1].map(index => `synthetic-output-${nonce}-${index}`)).sort()
  );
  const rows = await transactions.toArray();
  mockHarness.uniqueRows = rows.length;
  expect(rows.map(row => row.id).sort()).toEqual(
    mockHarness.nonces.map(nonce => nonce === LOCAL_NONCE ? 'synthetic-rich-local' : rowId(nonce)).sort()
  );
  expect(Object.values(state.checkpoints).map(checkpoint => checkpoint.entryCount)).toEqual(
    mockHarness.overlap ? [22, RECORDS] : [RECORDS]
  );
  expect(mockHarness.peakRaw).toBeLessThanOrEqual(4);
  expect(mockHarness.peakLogical).toBeLessThanOrEqual(2);
  expect(mockHarness.peakWasm).toBe(1);
  expect(mockHarness.peakConsumers).toBe(1);
  expect(mockUnexpectedFetch).not.toHaveBeenCalled();
  const local = await transactions.get('synthetic-rich-local');
  expect(local?.extraInputs).toEqual({
    destinationAddress: 'synthetic-destination',
    retainedLocalDetail: 'rich-local'
  });
  expect(local?.recovered).toBeUndefined();
  const order = await transactions.get(rowId(ORDER_NONCE));
  expect(order?.extraInputs.autoConsume).toBe(false);
  expect(order?.extraInputs.settledAt).toBeUndefined();
  expect(order?.extraInputs.expiresAt).toBeUndefined();
  expect((await transactions.get(rowId(PAYBACK_NONCE)))?.extraInputs.swapOrderTxId).toBe(order?.id);
  expect(await backend.repo.transactions.count()).toBe(RECORDS);
}

function measurements(label: string) {
  const events = mockHarness.events;
  const firstPersistedMs = events.t_first_persisted_recent_row?.fakeMs ?? Infinity;
  const firstVisibleMs = events.t_first_visible_recent_row?.fakeMs ?? Infinity;
  const fullCompletionMs = events.t_pending_flag_cleared?.fakeMs ?? Infinity;
  const result = {
    label, events, firstPersistedMs, firstVisibleMs, fullCompletionMs,
    pages: mockHarness.pageCount, rawEntries: mockHarness.rawEntries,
    deltaCalls: mockHarness.requested.length, completedOutputs: mockHarness.completedNotes.length,
    uniqueRows: mockHarness.uniqueRows, preexistingLocalRows: 1, notesAtFlagClear: mockHarness.notesAtFlagClear,
    uniqueOutputs: new Set(mockHarness.completedNotes).size,
    commits: mockHarness.commits, inserts: mockHarness.inserts,
    authCalls: mockHarness.authCalls, commitmentCalls: mockHarness.commitmentCalls,
    peakRaw: mockHarness.peakRaw, peakLogical: mockHarness.peakLogical,
    peakWasmByRealm: { inline: mockHarness.peakWasm }, peakSdkConsumers: mockHarness.peakConsumers,
    headIdentity: rowId(RECORDS), checkpoints: mockHarness.checkpointSnapshots,
    controlledOverheadMs: { page: 0, metadata: 0, signerSetup: 0, commitment: 5, pendingNoteScan: 0 }
  };
  console.info('guardian-history-synthetic', JSON.stringify(result));
  return result;
}

it('benchmarks first visible history and complete recovery for 1214 synthetic records', async () => {
  const samples: ReturnType<typeof measurements>[] = [];
  for (let index = 0; index < 5; index++) {
    const test = await fixture(false);
    try {
      expect(await test.backend.recovery.maybeStartGuardianRecovery(account)).toBe(true);
      await finish(test.backend);
      // The normal SWR poll is allowed to draw the known head, never forced through mutate or a shorter interval.
      if (!mockHarness.events.t_first_visible_recent_row) {
        await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
        await pump(() => Boolean(mockHarness.events.t_first_visible_recent_row));
      }
      expect(mockHarness.pageCount).toBe(25);
      expect(mockHarness.rawEntries).toBe(RECORDS);
      expect(mockHarness.completedNotes).toHaveLength(2_428);
      expect(document.querySelector(`[data-entry-key="${headKey}"]`)).not.toBeNull();
      expect(document.querySelector('[data-entry-key]')?.getAttribute('data-entry-key')).toBe(headKey);
      samples.push(measurements(`A-${index + 1}`));
    } finally {
      await test.dispose();
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
  console.info('guardian-history-synthetic-summary', JSON.stringify({
    samples: samples.length,
    medianFirstVisibleMs: median(samples.map(sample => sample.firstVisibleMs)),
    maxFirstVisibleMs: Math.max(...samples.map(sample => sample.firstVisibleMs)),
    medianFullCompletionMs: median(samples.map(sample => sample.fullCompletionMs)),
    maxFullCompletionMs: Math.max(...samples.map(sample => sample.fullCompletionMs))
  }));
  for (const sample of samples) {
    expect(sample.firstPersistedMs).toBeLessThanOrEqual(200);
    expect(sample.firstVisibleMs).toBeLessThanOrEqual(10_200);
    expect(sample.fullCompletionMs).toBeLessThanOrEqual(203_000);
  }
}, 180_000);

it('completes overlapping synthetic sources without duplicate receipts', async () => {
  const test = await fixture(true);
  try {
    expect(await test.backend.recovery.maybeStartGuardianRecovery(account)).toBe(true);
    await finish(test.backend);
    expect(mockHarness.rawEntries).toBe(1_236);
    expect(mockHarness.completedNotes).toHaveLength(2_472);
    expect(mockHarness.pageCount).toBe(26);
    const head = await transactions.get(rowId(RECORDS));
    expect(head?.recovery?.operators).toEqual([CURRENT, PREVIOUS]);
    measurements('B');
  } finally {
    await test.dispose();
  }
}, 90_000);

it('resumes synthetic history without skipping note completion', async () => {
  const test = await fixture(true);
  let resumed: Backend | undefined;
  try {
    mockHarness.pauseNote = `synthetic-output-${RECORDS}-0`;
    expect(await test.backend.recovery.maybeStartGuardianRecovery(account)).toBe(true);
    await pump(() => mockHarness.pauseReached);
    const headRow = await transactions.get(rowId(RECORDS));
    expect(headRow).toBeDefined();
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    await pump(() => Boolean(mockHarness.events.t_first_visible_recent_row));
    expect(document.querySelector(`[data-entry-key="${headKey}"]`)).not.toBeNull();
    const headSnapshot = await readGuardianHistoryState();
    expect(
      Object.values(headSnapshot.checkpoints).every(checkpoint => !checkpoint.completed && !checkpoint.cursor)
    ).toBe(true);
    expect(mockHarness.pending).toBe(true);
    mockHarness.locked = true;
    mockHarness.pausedImport?.();
    await pump(() => mockHarness.directResults.length === 1);
    await pump(() => mockHarness.raw === 0 && mockHarness.consumers === 0);
    const firstCompletedNotes = mockHarness.completedNotes.length;
    const progress = await fetchGuardianNoteRecoveryProgress(account.publicKey);
    expect(progress?.historyGeneration).toBe(headSnapshot.generation);

    mockHarness.locked = false;
    mockHarness.pauseNote = `synthetic-output-1164-0`;
    mockHarness.pauseReached = false;
    resumed = freshBackend();
    expect(await resumed.recovery.maybeStartGuardianRecovery(account)).toBe(true);
    await pump(() => mockHarness.pauseReached);
    const pageSnapshot = await readGuardianHistoryState();
    const previous = Object.values(pageSnapshot.checkpoints).find(checkpoint => checkpoint.operator === PREVIOUS);
    expect(previous).toMatchObject({ cursor: '50', entryCount: 50, completed: false });
    expect(mockHarness.pending).toBe(true);
    mockHarness.locked = true;
    mockHarness.pausedImport?.();
    await pump(() => mockHarness.directResults.length === 2);
    await pump(() => mockHarness.raw === 0 && mockHarness.consumers === 0);
    const secondCompletedNotes = mockHarness.completedNotes.length;
    resumed.dispose();
    mockHarness.locked = false;
    mockHarness.pauseNote = undefined;
    resumed = freshBackend();
    expect(await resumed.recovery.maybeStartGuardianRecovery(account)).toBe(true);
    await finish(resumed);
    expect((await readGuardianHistoryState()).generation).toBe(headSnapshot.generation);
    // Each stopped first-output call returns once before the guard notices the lock; both are replayed.
    expect(firstCompletedNotes).toBe(1);
    expect(secondCompletedNotes).toBe(146);
    expect(mockHarness.completedNotes).toHaveLength(2_474);
    expect(mockHarness.rawEntries).toBe(1_308);
    expect(mockHarness.pageCount).toBe(28);
    measurements('C');
  } finally {
    try {
      await test.dispose();
    } finally {
      resumed?.recovery.releaseGuardianRecoveriesOnLock();
      resumed?.dispose();
    }
  }
}, 120_000);
