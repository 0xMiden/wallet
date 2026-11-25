import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { MIDEN_NAME_REGISTER_SCRIPT_ROOT, MIDEN_NAME_SLOTS } from './config';
import { type Felts4, priceKeyFelts } from './encoding';
import { MidenNameRegistryMismatchError, MidenNameUnsupportedNetworkError } from './errors';
import {
  clearMidenNameQuoteCache,
  fetchMidenNameIssued,
  fetchMidenNameQuote,
  fetchRegistrationNoteState,
  findRegistryDeliveryNoteIds,
  getChainTip
} from './reads';
import { domainCommitment, statusKeyFeltsForLabel } from './sdk-words';
import {
  AccountId,
  AccountStorageRequirements,
  KNOWN_ACCOUNTS,
  NonFungibleAsset,
  NoteId,
  NoteTag,
  ROOT_WORDS,
  RpcClient,
  Word
} from './test-support/fake-sdk';

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(async () => undefined),
  getRpcEndpoint: jest.fn(() => 'endpoint')
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));
jest.mock('lib/epoch/chain', () => ({ getCurrentMidenBlock: jest.fn() }));
jest.mock('lib/miden/sdk/helpers', () => ({ walletAccountIdToSdk: jest.fn() }));

const REGISTRY_HEX = '0x16fb70069eed60110c6207189c8237';
const TOKEN_HEX = '0x4cbdcaffe75f0a317482224dae6436';
const REGISTRY = { prefix: 0xaan, suffix: 0xbbn };
const TOKEN = { prefix: 0xccn, suffix: 0xddn };
const ROOT: Felts4 = [11n, 12n, 13n, 14n];

const mockNetwork = jest.mocked(getEffectiveNetworkName);
const mockTip = jest.mocked(getCurrentMidenBlock);
const mockWalletId = jest.requireMock<{ walletAccountIdToSdk: jest.Mock<AccountId, [string]> }>(
  'lib/miden/sdk/helpers'
).walletAccountIdToSdk;

interface FakeNoteStatus {
  status: string;
  attemptCount: number;
  lastError: string | undefined;
}

function hexOf(felts: Felts4): string {
  return new Word(BigUint64Array.from(felts)).toHex();
}

/** Fake on-chain state of the registry. */
let mapEntries: Map<string, Map<string, bigint[]>>;
let slotValues: Map<string, bigint[]>;
let tooManyEntries: Set<string>;
let provenAccountHex: string;

function setEntry(slot: string, key: Felts4, value: bigint[]): void {
  const entries = mapEntries.get(slot) ?? new Map<string, bigint[]>();
  entries.set(hexOf(key), value);
  mapEntries.set(slot, entries);
}

type FakeProof = ReturnType<typeof createFakeProof>;
let proofsCreated: FakeProof[] = [];

function createFakeProof(requirements: AccountStorageRequirements) {
  let freed = false;
  const assertLive = (member: string) => {
    if (freed) throw new Error(`AccountProof.${member} called after free()`);
  };
  const proof = {
    accountId: () => {
      assertLive('accountId');
      return { toString: () => provenAccountHex };
    },
    blockNum: () => {
      assertLive('blockNum');
      return 777;
    },
    getStorageSlotValue: (slot: string) => {
      assertLive('getStorageSlotValue');
      const value = slotValues.get(slot);
      return value ? new Word(BigUint64Array.from(value)) : undefined;
    },
    hasStorageMapTooManyEntries: (slot: string) => {
      assertLive('hasStorageMapTooManyEntries');
      return tooManyEntries.has(slot);
    },
    getStorageMapEntries: (slot: string) => {
      assertLive('getStorageMapEntries');
      const request = requirements.slots.find(entry => entry.slot === slot);
      if (!request) return undefined;
      const entries = mapEntries.get(slot) ?? new Map<string, bigint[]>();
      return request.keys.flatMap(key => {
        const value = entries.get(key.toHex());
        return value ? [{ key: () => key, value: () => new Word(BigUint64Array.from(value)) }] : [];
      });
    },
    free: jest.fn(() => {
      freed = true;
    })
  };
  proofsCreated.push(proof);
  return proof;
}

function fakeProof(requirements: AccountStorageRequirements) {
  return createFakeProof(requirements);
}

const rpc = {
  getAccountProof: jest.fn(async (_id: AccountId, requirements: AccountStorageRequirements) => fakeProof(requirements)),
  getNetworkNoteStatus: jest.fn<Promise<FakeNoteStatus>, [NoteId]>(),
  syncNotes: jest.fn<Promise<ReturnType<typeof syncResult>>, [number, number, NoteTag[]]>(),
  getNotesById: jest.fn<Promise<FakeFetchedNote[]>, [NoteId[]]>(),
  free: jest.fn()
};

beforeEach(() => {
  jest.clearAllMocks();
  proofsCreated = [];
  clearMidenNameQuoteCache();
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  KNOWN_ACCOUNTS.set(REGISTRY_HEX, REGISTRY);
  KNOWN_ACCOUNTS.set(TOKEN_HEX, TOKEN);
  ROOT_WORDS.set(MIDEN_NAME_REGISTER_SCRIPT_ROOT, [...ROOT]);
  RpcClient.mockImplementation(() => rpc);
  rpc.getAccountProof.mockImplementation(async (_id, requirements) => fakeProof(requirements));
  mapEntries = new Map();
  slotValues = new Map([[MIDEN_NAME_SLOTS.commitmentVersion, [1n, 0n, 0n, 0n]]]);
  tooManyEntries = new Set();
  provenAccountHex = REGISTRY_HEX;
  setEntry(MIDEN_NAME_SLOTS.prices, priceKeyFelts(5, TOKEN), [1000n, 0n, 0n, 0n]);
  setEntry(MIDEN_NAME_SLOTS.prices, priceKeyFelts(3, TOKEN), [120_000_000n, 0n, 0n, 0n]);
  slotValues.set(MIDEN_NAME_SLOTS.registerDomainNoteRoot, [...ROOT]);
  setEntry(MIDEN_NAME_SLOTS.feeSchedule, ROOT, [210n, 0n, 0n, 1n]);
});

describe('fetchMidenNameQuote', () => {
  it('reads status, price, allowlist and fee with ONE account proof', async () => {
    const quote = await fetchMidenNameQuote('zzqxjv9q1kk');

    expect(quote).toEqual({
      label: 'zzqxjv9q1kk',
      available: true,
      priced: true,
      priceBaseUnits: 1000n,
      networkFeeBaseUnits: 210n,
      scriptAllowed: true,
      blockNum: 777
    });
    expect(rpc.getAccountProof).toHaveBeenCalledTimes(1);

    const [id, requirements] = rpc.getAccountProof.mock.calls[0] ?? [];
    expect(id?.toString()).toBe(REGISTRY_HEX);
    const requested = requirements?.slots.map(entry => [entry.slot, entry.keys.map(key => key.toHex())]);
    expect(requested).toEqual([
      [MIDEN_NAME_SLOTS.assetStatus, [hexOf(statusKeyFeltsForLabel('zzqxjv9q1kk', REGISTRY))]],
      [MIDEN_NAME_SLOTS.prices, [hexOf([5n, 0n, TOKEN.suffix, TOKEN.prefix])]],
      [MIDEN_NAME_SLOTS.feeSchedule, [hexOf(ROOT)]]
    ]);
  });

  it('reports a taken name and the price of its length', async () => {
    setEntry(MIDEN_NAME_SLOTS.assetStatus, statusKeyFeltsForLabel('abc', REGISTRY), [1n, 0n, 0n, 0n]);
    const quote = await fetchMidenNameQuote('abc');
    expect(quote.available).toBe(false);
    expect(quote.priceBaseUnits).toBe(120_000_000n);
  });

  it('marks missing and zero price entries as unpriced and unavailable', async () => {
    const missing = await fetchMidenNameQuote('ab');
    expect(missing.priceBaseUnits).toBe(0n);
    expect(missing.priced).toBe(false);
    expect(missing.available).toBe(false);

    setEntry(MIDEN_NAME_SLOTS.prices, priceKeyFelts(2, TOKEN), [0n, 0n, 0n, 0n]);
    clearMidenNameQuoteCache();
    const zero = await fetchMidenNameQuote('ab');
    expect(zero.priceBaseUnits).toBe(0n);
    expect(zero.priced).toBe(false);
    expect(zero.available).toBe(false);
  });

  it('marks the script not allowed when the registration root is missing', async () => {
    slotValues.delete(MIDEN_NAME_SLOTS.registerDomainNoteRoot);
    const quote = await fetchMidenNameQuote('alice');
    expect(quote.scriptAllowed).toBe(false);
    expect(quote.networkFeeBaseUnits).toBe(210n);
  });

  it('marks the script not allowed when the registry has another registration root', async () => {
    slotValues.set(MIDEN_NAME_SLOTS.registerDomainNoteRoot, [99n, 0n, 0n, 0n]);
    const quote = await fetchMidenNameQuote('alice');
    expect(quote.scriptAllowed).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['without the marker', [210n, 0n, 0n, 0n]],
    ['with a non-zero felt 1', [210n, 5n, 0n, 1n]],
    ['with a non-zero felt 2', [210n, 0n, 5n, 1n]]
  ])('marks the script not allowed when the fee entry is %s', async (_name, value) => {
    mapEntries.delete(MIDEN_NAME_SLOTS.feeSchedule);
    if (value) setEntry(MIDEN_NAME_SLOTS.feeSchedule, ROOT, value);
    const quote = await fetchMidenNameQuote('alice');
    expect(quote.scriptAllowed).toBe(false);
    expect(quote.networkFeeBaseUnits).toBe(0n);
  });

  it('refuses a proof for another account', async () => {
    provenAccountHex = '0x0000000000000000000000000000ff';
    await expect(fetchMidenNameQuote('alice')).rejects.toThrow(MidenNameRegistryMismatchError);
  });

  it.each([
    ['an unknown version', [2n, 0n, 0n, 0n]],
    ['no version', undefined]
  ])('refuses %s of commitment_version', async (_name, value) => {
    if (value) {
      slotValues.set(MIDEN_NAME_SLOTS.commitmentVersion, value);
    } else {
      slotValues.delete(MIDEN_NAME_SLOTS.commitmentVersion);
    }
    await expect(fetchMidenNameQuote('alice')).rejects.toThrow(/commitment_version/);
  });

  it('refuses a proof that leaves out map entries', async () => {
    tooManyEntries.add(MIDEN_NAME_SLOTS.assetStatus);
    await expect(fetchMidenNameQuote('alice')).rejects.toThrow(MidenNameRegistryMismatchError);
  });

  it('snapshots slot and map values and frees the AccountProof on success and validation errors', async () => {
    const quote = await fetchMidenNameQuote('alice');
    expect(quote.scriptAllowed).toBe(true);
    expect(proofsCreated).toHaveLength(1);
    expect(proofsCreated[0]?.free).toHaveBeenCalledTimes(1);

    provenAccountHex = '0x0000000000000000000000000000ff';
    await expect(fetchMidenNameQuote('alice', { fresh: true })).rejects.toThrow(MidenNameRegistryMismatchError);
    expect(proofsCreated[1]?.free).toHaveBeenCalledTimes(1);

    provenAccountHex = REGISTRY_HEX;
    slotValues.set(MIDEN_NAME_SLOTS.commitmentVersion, [2n, 0n, 0n, 0n]);
    await expect(fetchMidenNameQuote('alice', { fresh: true })).rejects.toThrow(/commitment_version/);
    expect(proofsCreated[2]?.free).toHaveBeenCalledTimes(1);

    slotValues.set(MIDEN_NAME_SLOTS.commitmentVersion, [1n, 0n, 0n, 0n]);
    tooManyEntries.add(MIDEN_NAME_SLOTS.assetStatus);
    await expect(fetchMidenNameQuote('alice', { fresh: true })).rejects.toThrow(MidenNameRegistryMismatchError);
    expect(proofsCreated[3]?.free).toHaveBeenCalledTimes(1);
  });

  it('builds new wasm arguments for the retry', async () => {
    rpc.getAccountProof.mockRejectedValueOnce(new Error('transport'));
    await fetchMidenNameQuote('alice');
    expect(rpc.getAccountProof).toHaveBeenCalledTimes(2);
    const first = rpc.getAccountProof.mock.calls[0];
    const second = rpc.getAccountProof.mock.calls[1];
    expect(first?.[0]).not.toBe(second?.[0]);
    expect(first?.[1]).not.toBe(second?.[1]);
    expect(first?.[1].slots[0]).not.toBe(second?.[1].slots[0]);
  });

  it('caches a quote for 30 s and bypasses the cache with fresh', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await fetchMidenNameQuote('alice');
    await fetchMidenNameQuote('alice');
    expect(rpc.getAccountProof).toHaveBeenCalledTimes(1);

    await fetchMidenNameQuote('alice', { fresh: true });
    expect(rpc.getAccountProof).toHaveBeenCalledTimes(2);

    now.mockReturnValue(1_000_000 + 30_000);
    await fetchMidenNameQuote('alice');
    expect(rpc.getAccountProof).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });

  it('throws on a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(fetchMidenNameQuote('alice')).rejects.toThrow(MidenNameUnsupportedNetworkError);
    expect(rpc.getAccountProof).not.toHaveBeenCalled();
  });

  it('throws for an invalid label before any RPC', async () => {
    await expect(fetchMidenNameQuote('Al!ce')).rejects.toThrow(/Invalid Miden Name label/);
    expect(rpc.getAccountProof).not.toHaveBeenCalled();
  });
});

describe('fetchMidenNameIssued', () => {
  it('is true when asset_status felt 0 is 1', async () => {
    setEntry(MIDEN_NAME_SLOTS.assetStatus, statusKeyFeltsForLabel('miden', REGISTRY), [1n, 0n, 0n, 0n]);
    await expect(fetchMidenNameIssued('miden')).resolves.toBe(true);
  });

  it('is false when the entry is missing', async () => {
    await expect(fetchMidenNameIssued('free')).resolves.toBe(false);
  });
});

describe('fetchRegistrationNoteState', () => {
  it.each([
    ['Pending', 'pending'],
    ['NullifierInflight', 'inflight'],
    ['Discarded', 'discarded'],
    ['NullifierCommitted', 'consumed'],
    ['SomethingNew', 'unknown']
  ])('maps %s to %s', async (raw, status) => {
    rpc.getNetworkNoteStatus.mockResolvedValue({ status: raw, attemptCount: 2, lastError: undefined });
    await expect(fetchRegistrationNoteState('0xnote')).resolves.toEqual({ status, attemptCount: 2 });
    const noteId = rpc.getNetworkNoteStatus.mock.calls[0]?.[0];
    expect(noteId).toBeInstanceOf(NoteId);
    expect(String(noteId)).toBe('0xnote');
  });

  it('includes the last error', async () => {
    rpc.getNetworkNoteStatus.mockResolvedValue({ status: 'Discarded', attemptCount: 5, lastError: 'taken' });
    await expect(fetchRegistrationNoteState('0xnote')).resolves.toEqual({
      status: 'discarded',
      attemptCount: 5,
      lastError: 'taken'
    });
  });

  it.each([
    'failed to get network note status: grpc request failed for get_network_note_status: Resource Not Found',
    'failed to get network note status: grpc request failed for get_network_note_status: code: Some requested entity was not found'
  ])('reports a note that the node does not know yet as unknown, with no retry (%s)', async message => {
    rpc.getNetworkNoteStatus.mockRejectedValue(new Error(message));
    await expect(fetchRegistrationNoteState('0xnote')).resolves.toEqual({ status: 'unknown', attemptCount: 0 });
    expect(rpc.getNetworkNoteStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    'grpc request failed: unavailable',
    '404 Not Found',
    'failed to get network note status: 404 Not Found',
    'failed to get network note status: route not found',
    'account 0x1234 not found at block 5',
    'grpc request failed: Resource Not Found'
  ])('throws unrelated error "%s" with no retry', async message => {
    rpc.getNetworkNoteStatus.mockRejectedValue(new Error(message));
    await expect(fetchRegistrationNoteState('0xnote')).rejects.toThrow(message);
    expect(rpc.getNetworkNoteStatus).toHaveBeenCalledTimes(1);
  });
});

/** A fetched note: `nfas` undefined = no public body. */
interface FakeFetchedNote {
  noteId: { toString: () => string };
  note?: { assets: () => { nonFungibleAssets: () => NonFungibleAsset[] } };
}

function fetchedNote(id: string, nfas?: NonFungibleAsset[]): FakeFetchedNote {
  return {
    noteId: { toString: () => id },
    ...(nfas ? { note: { assets: () => ({ nonFungibleAssets: () => nfas }) } } : {})
  };
}

function syncResult(blockTo: number, blocks: Array<Array<{ sender: string; id: string }>>) {
  return {
    blockTo: () => blockTo,
    blocks: () =>
      blocks.map(notes => ({
        notes: () =>
          notes.map(note => ({
            sender: () => ({ toString: () => note.sender }),
            noteId: () => ({ toString: () => note.id })
          }))
      }))
  };
}

describe('findRegistryDeliveryNoteIds', () => {
  const ACCOUNT = 'mtst1account';

  beforeEach(() => {
    mockWalletId.mockImplementation(() => new AccountId('0xacc', 1n, 2n));
  });

  it('loops with a cursor until blockTo reaches the end and keeps only registry notes', async () => {
    rpc.syncNotes
      .mockResolvedValueOnce(
        syncResult(164987, [
          [
            { sender: REGISTRY_HEX.toUpperCase().replace('0X', '0x'), id: '0xa' },
            { sender: '0xother', id: '0xb' }
          ]
        ])
      )
      .mockResolvedValueOnce(
        syncResult(165137, [[{ sender: REGISTRY_HEX, id: '0xa' }], [{ sender: REGISTRY_HEX, id: '0xc' }]])
      );

    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 164937, toBlock: 165137 });

    expect(scan).toEqual({ noteIds: ['0xa', '0xc'], scannedTo: 165137 });
    expect(rpc.syncNotes.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [164937, 165137],
      [164988, 165137]
    ]);
    const tags = rpc.syncNotes.mock.calls[0]?.[2];
    expect(tags?.[0]).toBeInstanceOf(NoteTag);
    expect(mockWalletId).toHaveBeenCalledWith(ACCOUNT);
  });

  it('scans to the chain tip when toBlock is not given', async () => {
    mockTip.mockResolvedValue(165337);
    rpc.syncNotes.mockResolvedValueOnce(syncResult(165437, []));
    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 165237 });
    expect(scan).toEqual({ noteIds: [], scannedTo: 165337 });
    expect(rpc.syncNotes).toHaveBeenCalledWith(165237, 165337, expect.any(Array));
  });

  it('returns at once when the range is empty', async () => {
    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 165237, toBlock: 165137 });
    expect(scan).toEqual({ noteIds: [], scannedTo: 165137 });
    expect(rpc.syncNotes).not.toHaveBeenCalled();
  });

  it('starts a delivery scan at the registry creation block', async () => {
    rpc.syncNotes.mockResolvedValueOnce(syncResult(165000, []));
    await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 0, toBlock: 165000 });
    expect(rpc.syncNotes).toHaveBeenCalledWith(164837, 165000, expect.any(Array));
  });

  it('stops when the node does not move the cursor', async () => {
    rpc.syncNotes.mockResolvedValueOnce(syncResult(164936, []));
    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 164937, toBlock: 165137 });
    expect(scan).toEqual({ noteIds: [], scannedTo: 164936 });
    expect(rpc.syncNotes).toHaveBeenCalledTimes(1);
  });

  it('with a label, keeps only the public notes that carry the NFA of that label', async () => {
    const registry = new AccountId(REGISTRY_HEX, REGISTRY.prefix, REGISTRY.suffix);
    const commitment = domainCommitment('alice', REGISTRY);
    const aliceNfa = new NonFungibleAsset(registry, [commitment[0], commitment[1], 7n, 8n]);
    const bobCommitment = domainCommitment('bob', REGISTRY);
    const bobNfa = new NonFungibleAsset(registry, [bobCommitment[0], bobCommitment[1], 7n, 8n]);
    const foreignNfa = new NonFungibleAsset(new AccountId('0xother', 5n, 6n), [commitment[0], commitment[1], 0n, 0n]);
    rpc.syncNotes.mockResolvedValueOnce(
      syncResult(165137, [
        [
          { sender: REGISTRY_HEX, id: '0xbob' },
          { sender: REGISTRY_HEX, id: '0xprivate' },
          { sender: REGISTRY_HEX, id: '0xforeign' },
          { sender: REGISTRY_HEX, id: '0xalice' }
        ]
      ])
    );
    rpc.getNotesById.mockResolvedValueOnce([
      fetchedNote('0xalice', [aliceNfa]),
      fetchedNote('0xbob', [bobNfa]),
      fetchedNote('0xprivate'),
      fetchedNote('0xforeign', [foreignNfa])
    ]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const scan = await findRegistryDeliveryNoteIds({
      accountId: ACCOUNT,
      fromBlock: 164937,
      toBlock: 165137,
      label: 'alice'
    });

    expect(scan).toEqual({ noteIds: ['0xalice'], scannedTo: 165137 });
    const requested = rpc.getNotesById.mock.calls[0]?.[0].map(id => id.toString());
    expect(requested).toEqual(['0xbob', '0xprivate', '0xforeign', '0xalice']);
    // Every NFA that the read touched is freed.
    expect([aliceNfa.freed, bobNfa.freed, foreignNfa.freed]).toEqual([1, 1, 1]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no public body'), { noteId: '0xprivate' });
    warn.mockRestore();
  });

  it('with a label and no note found, does not fetch any note', async () => {
    rpc.syncNotes.mockResolvedValueOnce(syncResult(165137, []));
    const scan = await findRegistryDeliveryNoteIds({
      accountId: ACCOUNT,
      fromBlock: 164937,
      toBlock: 165137,
      label: 'alice'
    });
    expect(scan).toEqual({ noteIds: [], scannedTo: 165137 });
    expect(rpc.getNotesById).not.toHaveBeenCalled();
  });

  it('makes a new note tag for the retry', async () => {
    rpc.syncNotes.mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(syncResult(165137, []));
    await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 164937, toBlock: 165137 });
    expect(rpc.syncNotes.mock.calls[0]?.[2][0]).not.toBe(rpc.syncNotes.mock.calls[1]?.[2][0]);
  });
});

describe('getChainTip', () => {
  it('reads the chain head', async () => {
    mockTip.mockResolvedValue(1234);
    await expect(getChainTip()).resolves.toBe(1234);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

describe('RpcClient lifecycle', () => {
  it('frees the client after proof reads succeed or fail', async () => {
    await fetchMidenNameQuote('alice');
    expect(rpc.free).toHaveBeenCalledTimes(1);

    await fetchMidenNameIssued('alice');
    expect(rpc.free).toHaveBeenCalledTimes(2);

    rpc.getAccountProof.mockRejectedValue(new Error('rpc down'));
    await expect(fetchMidenNameQuote('bob')).rejects.toThrow('rpc down');
    expect(rpc.free).toHaveBeenCalledTimes(4);
  });

  it('defers proof client disposal on timeout until underlying attempts settle', async () => {
    jest.useFakeTimers();
    try {
      const attempt1 = deferred<ReturnType<typeof fakeProof>>();
      const attempt2 = deferred<ReturnType<typeof fakeProof>>();
      rpc.getAccountProof.mockReturnValueOnce(attempt1.promise).mockReturnValueOnce(attempt2.promise);

      const outcome = fetchMidenNameQuote('alice').then(
        () => 'resolved',
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(15_000);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toBeInstanceOf(RpcTimeoutError);
      expect(rpc.free).not.toHaveBeenCalled();

      attempt1.reject(new Error('late failure'));
      await flushMicrotasks();
      expect(rpc.free).toHaveBeenCalledTimes(1);

      attempt2.reject(new Error('late failure 2'));
      await flushMicrotasks();
      expect(rpc.free).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('frees the client after note-status reads and defers disposal on timeout', async () => {
    rpc.getNetworkNoteStatus.mockResolvedValueOnce({ status: 'Pending', attemptCount: 0, lastError: undefined });
    await fetchRegistrationNoteState('0xnote');
    expect(rpc.free).toHaveBeenCalledTimes(1);

    rpc.getNetworkNoteStatus.mockRejectedValueOnce(new Error('unavailable'));
    await expect(fetchRegistrationNoteState('0xnote')).rejects.toThrow('unavailable');
    expect(rpc.free).toHaveBeenCalledTimes(2);

    jest.useFakeTimers();
    try {
      const pending = deferred<FakeNoteStatus>();
      rpc.getNetworkNoteStatus.mockReturnValueOnce(pending.promise);
      const outcome = fetchRegistrationNoteState('0xnote').then(
        () => 'resolved',
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toBeInstanceOf(RpcTimeoutError);
      expect(rpc.free).toHaveBeenCalledTimes(2);

      pending.resolve({ status: 'Pending', attemptCount: 1, lastError: undefined });
      await flushMicrotasks();
      expect(rpc.free).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('frees the scan client after delivery scan with notesCarryingLabel, error, and empty range', async () => {
    mockWalletId.mockImplementation(() => new AccountId('0xacc', 1n, 2n));
    rpc.syncNotes.mockResolvedValueOnce(syncResult(165137, [[{ sender: REGISTRY_HEX, id: '0xnote1' }]]));
    rpc.getNotesById.mockResolvedValueOnce([fetchedNote('0xnote1')]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await findRegistryDeliveryNoteIds({
      accountId: 'mtst1account',
      fromBlock: 164937,
      toBlock: 165137,
      label: 'alice'
    });
    expect(rpc.free).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    rpc.syncNotes.mockRejectedValue(new Error('scan down'));
    await expect(
      findRegistryDeliveryNoteIds({ accountId: 'mtst1account', fromBlock: 164937, toBlock: 165137 })
    ).rejects.toThrow('scan down');
    expect(rpc.free).toHaveBeenCalledTimes(2);

    await findRegistryDeliveryNoteIds({ accountId: 'mtst1account', fromBlock: 165237, toBlock: 165137 });
    expect(rpc.free).toHaveBeenCalledTimes(2);
  });

  it('defers delivery-scan client disposal when notesCarryingLabel times out until all attempts settle', async () => {
    jest.useFakeTimers();
    try {
      mockWalletId.mockImplementation(() => new AccountId('0xacc', 1n, 2n));
      rpc.syncNotes.mockResolvedValueOnce(syncResult(165137, [[{ sender: REGISTRY_HEX, id: '0xnote1' }]]));
      const getNotes1 = deferred<FakeFetchedNote[]>();
      const getNotes2 = deferred<FakeFetchedNote[]>();
      rpc.getNotesById.mockReturnValueOnce(getNotes1.promise).mockReturnValueOnce(getNotes2.promise);

      const outcome = findRegistryDeliveryNoteIds({
        accountId: 'mtst1account',
        fromBlock: 164937,
        toBlock: 165137,
        label: 'alice'
      }).then(
        () => 'resolved',
        (error: unknown) => error
      );

      await jest.advanceTimersByTimeAsync(15_000);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toBeInstanceOf(RpcTimeoutError);
      expect(rpc.free).not.toHaveBeenCalled();

      getNotes1.resolve([]);
      await flushMicrotasks();
      expect(rpc.free).not.toHaveBeenCalled();

      getNotes2.resolve([]);
      await flushMicrotasks();
      expect(rpc.free).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
