import { getCurrentMidenBlock } from 'lib/epoch/chain';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { MIDEN_NAME_REGISTER_SCRIPT_ROOT, MIDEN_NAME_SLOTS } from './config';
import { type Felts4, priceKeyFelts } from './encoding';
import { MidenNameRegistryMismatchError, MidenNameUnsupportedNetworkError } from './errors';
import { REGISTRY_SCRIPT_ROOT_HEX } from './note-script-roots';
import {
  clearMidenNameQuoteCache,
  fetchMidenNameIssued,
  fetchMidenNameQuote,
  fetchRegistrationNoteState,
  fetchRegistryScriptAllowed,
  findRegistryDeliveryNoteIds,
  getChainTip
} from './reads';
import { statusKeyFeltsForLabel } from './sdk-words';
import {
  AccountId,
  AccountStorageRequirements,
  KNOWN_ACCOUNTS,
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

const REGISTRY_HEX = '0xead81800958e7a112d45bdcf852fa6';
const TOKEN_HEX = '0x18101fa522c174b165efd4f70a0385';
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

function fakeProof(requirements: AccountStorageRequirements) {
  return {
    accountId: () => ({ toString: () => provenAccountHex }),
    blockNum: () => 777,
    getStorageSlotValue: (slot: string) => {
      const value = slotValues.get(slot);
      return value ? new Word(BigUint64Array.from(value)) : undefined;
    },
    hasStorageMapTooManyEntries: (slot: string) => tooManyEntries.has(slot),
    getStorageMapEntries: (slot: string) => {
      const request = requirements.slots.find(entry => entry.slot === slot);
      if (!request) return undefined;
      const entries = mapEntries.get(slot) ?? new Map<string, bigint[]>();
      return request.keys.flatMap(key => {
        const value = entries.get(key.toHex());
        return value ? [{ key: () => key, value: () => new Word(BigUint64Array.from(value)) }] : [];
      });
    }
  };
}

const rpc = {
  getAccountProof: jest.fn(async (_id: AccountId, requirements: AccountStorageRequirements) => fakeProof(requirements)),
  getNetworkNoteStatus: jest.fn<Promise<FakeNoteStatus>, [NoteId]>(),
  syncNotes: jest.fn<Promise<ReturnType<typeof syncResult>>, [number, number, NoteTag[]]>()
};

beforeEach(() => {
  jest.clearAllMocks();
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
  setEntry(MIDEN_NAME_SLOTS.prices, priceKeyFelts(5, TOKEN), [20_000_000n, 0n, 0n, 0n]);
  setEntry(MIDEN_NAME_SLOTS.prices, priceKeyFelts(3, TOKEN), [120_000_000n, 0n, 0n, 0n]);
  setEntry(MIDEN_NAME_SLOTS.allowedNoteScripts, ROOT, [1n, 0n, 0n, 0n]);
  setEntry(MIDEN_NAME_SLOTS.feeSchedule, ROOT, [210n, 0n, 0n, 1n]);
});

describe('fetchMidenNameQuote', () => {
  it('reads status, price, allowlist and fee with ONE account proof', async () => {
    const quote = await fetchMidenNameQuote('zzqxjv9q1kk');

    expect(quote).toEqual({
      label: 'zzqxjv9q1kk',
      available: true,
      priceBaseUnits: 20_000_000n,
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
      [MIDEN_NAME_SLOTS.allowedNoteScripts, [hexOf(ROOT)]],
      [MIDEN_NAME_SLOTS.feeSchedule, [hexOf(ROOT)]]
    ]);
  });

  it('reports a taken name and the price of its length', async () => {
    setEntry(MIDEN_NAME_SLOTS.assetStatus, statusKeyFeltsForLabel('abc', REGISTRY), [1n, 0n, 0n, 0n]);
    const quote = await fetchMidenNameQuote('abc');
    expect(quote.available).toBe(false);
    expect(quote.priceBaseUnits).toBe(120_000_000n);
  });

  it('reads a missing price entry as 0', async () => {
    const quote = await fetchMidenNameQuote('ab');
    expect(quote.priceBaseUnits).toBe(0n);
  });

  it('marks the script not allowed when the allowlist entry is missing', async () => {
    mapEntries.delete(MIDEN_NAME_SLOTS.allowedNoteScripts);
    const quote = await fetchMidenNameQuote('alice');
    expect(quote.scriptAllowed).toBe(false);
    expect(quote.networkFeeBaseUnits).toBe(210n);
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

describe('fetchRegistryScriptAllowed', () => {
  const REGISTRY_ROOT: Felts4 = [21n, 22n, 23n, 24n];

  beforeEach(() => {
    ROOT_WORDS.set(REGISTRY_SCRIPT_ROOT_HEX, [...REGISTRY_ROOT]);
  });

  it('is true when allowed_note_scripts felt 0 is 1, with ONE proof of that key only', async () => {
    setEntry(MIDEN_NAME_SLOTS.allowedNoteScripts, REGISTRY_ROOT, [1n, 0n, 0n, 0n]);

    await expect(fetchRegistryScriptAllowed(REGISTRY_SCRIPT_ROOT_HEX)).resolves.toBe(true);

    expect(rpc.getAccountProof).toHaveBeenCalledTimes(1);
    const [id, requirements] = rpc.getAccountProof.mock.calls[0] ?? [];
    expect(id?.toString()).toBe(REGISTRY_HEX);
    expect(requirements?.slots.map(entry => [entry.slot, entry.keys.map(key => key.toHex())])).toEqual([
      [MIDEN_NAME_SLOTS.allowedNoteScripts, [hexOf(REGISTRY_ROOT)]]
    ]);
  });

  it('is false when the entry is missing', async () => {
    await expect(fetchRegistryScriptAllowed(REGISTRY_SCRIPT_ROOT_HEX)).resolves.toBe(false);
  });

  it('is false when felt 0 is not the allowed marker', async () => {
    setEntry(MIDEN_NAME_SLOTS.allowedNoteScripts, REGISTRY_ROOT, [2n, 0n, 0n, 0n]);
    await expect(fetchRegistryScriptAllowed(REGISTRY_SCRIPT_ROOT_HEX)).resolves.toBe(false);
  });

  it('does not read the fee schedule: the registry script has no fee entry check', async () => {
    setEntry(MIDEN_NAME_SLOTS.allowedNoteScripts, REGISTRY_ROOT, [1n, 0n, 0n, 0n]);
    await fetchRegistryScriptAllowed(REGISTRY_SCRIPT_ROOT_HEX);
    const requirements = rpc.getAccountProof.mock.calls[0]?.[1];
    expect(requirements?.slots.map(entry => entry.slot)).not.toContain(MIDEN_NAME_SLOTS.feeSchedule);
  });

  it('throws on a network with no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(fetchRegistryScriptAllowed(REGISTRY_SCRIPT_ROOT_HEX)).rejects.toBeInstanceOf(
      MidenNameUnsupportedNetworkError
    );
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

  it('reports a note that the node does not know yet as unknown, with no retry', async () => {
    rpc.getNetworkNoteStatus.mockRejectedValue(
      new Error(
        'failed to get network note status: grpc request failed for get_network_note_status: Resource Not Found'
      )
    );
    await expect(fetchRegistrationNoteState('0xnote')).resolves.toEqual({ status: 'unknown', attemptCount: 0 });
    expect(rpc.getNetworkNoteStatus).toHaveBeenCalledTimes(1);
  });

  it('throws any other error, with no retry', async () => {
    rpc.getNetworkNoteStatus.mockRejectedValue(new Error('grpc request failed: unavailable'));
    await expect(fetchRegistrationNoteState('0xnote')).rejects.toThrow('unavailable');
    expect(rpc.getNetworkNoteStatus).toHaveBeenCalledTimes(1);
  });
});

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
        syncResult(150, [
          [
            { sender: REGISTRY_HEX.toUpperCase().replace('0X', '0x'), id: '0xa' },
            { sender: '0xother', id: '0xb' }
          ]
        ])
      )
      .mockResolvedValueOnce(
        syncResult(300, [[{ sender: REGISTRY_HEX, id: '0xa' }], [{ sender: REGISTRY_HEX, id: '0xc' }]])
      );

    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 100, toBlock: 300 });

    expect(scan).toEqual({ noteIds: ['0xa', '0xc'], scannedTo: 300 });
    expect(rpc.syncNotes.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [100, 300],
      [151, 300]
    ]);
    const tags = rpc.syncNotes.mock.calls[0]?.[2];
    expect(tags?.[0]).toBeInstanceOf(NoteTag);
    expect(mockWalletId).toHaveBeenCalledWith(ACCOUNT);
  });

  it('scans to the chain tip when toBlock is not given', async () => {
    mockTip.mockResolvedValue(500);
    rpc.syncNotes.mockResolvedValueOnce(syncResult(600, []));
    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 400 });
    expect(scan).toEqual({ noteIds: [], scannedTo: 500 });
    expect(rpc.syncNotes).toHaveBeenCalledWith(400, 500, expect.any(Array));
  });

  it('returns at once when the range is empty', async () => {
    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 400, toBlock: 300 });
    expect(scan).toEqual({ noteIds: [], scannedTo: 300 });
    expect(rpc.syncNotes).not.toHaveBeenCalled();
  });

  it('stops when the node does not move the cursor', async () => {
    rpc.syncNotes.mockResolvedValueOnce(syncResult(99, []));
    const scan = await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 100, toBlock: 300 });
    expect(scan).toEqual({ noteIds: [], scannedTo: 99 });
    expect(rpc.syncNotes).toHaveBeenCalledTimes(1);
  });

  it('makes a new note tag for the retry', async () => {
    rpc.syncNotes.mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(syncResult(300, []));
    await findRegistryDeliveryNoteIds({ accountId: ACCOUNT, fromBlock: 100, toBlock: 300 });
    expect(rpc.syncNotes.mock.calls[0]?.[2][0]).not.toBe(rpc.syncNotes.mock.calls[1]?.[2][0]);
  });
});

describe('getChainTip', () => {
  it('reads the chain head', async () => {
    mockTip.mockResolvedValue(1234);
    await expect(getChainTip()).resolves.toBe(1234);
  });
});
