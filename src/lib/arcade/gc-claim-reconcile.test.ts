import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { GcClaimContext, GcClaimOperation, gcClaimTransactionId } from './gc-claim-operation';
import { reconcileGcClaim, scanGcClaimHistoryPage } from './gc-claim-reconcile';

// RPC/WASM boundary fixtures only. They exercise verification admission and cursor behavior,
// and deliberately do not claim real hashes, SDK execution, chain submission or runtime acceptance.
class TestWord {
  constructor(readonly values: BigUint64Array) {}
  toHex() {
    return `0x${Array.from(this.values, value => value.toString(16).padStart(16, '0')).join('')}`;
  }
  toU64s() {
    return this.values;
  }
  static fromHex(value: string) {
    return new TestWord(
      new BigUint64Array(
        Array.from({ length: 4 }, (_, index) => BigInt(`0x${value.slice(2 + index * 16, 18 + index * 16)}`))
      )
    );
  }
}
const w = (value: number) => new TestWord(new BigUint64Array([value, value, value, value].map(BigInt)));
const ACCOUNT = `0x${'11'.repeat(15)}`;
const ISSUER = `0x${'22'.repeat(15)}`;
const NATIVE = `0x${'33'.repeat(15)}`;
const GENESIS = w(1).toHex();
const CODE = w(2).toHex();
const REQUEST = w(3).toHex();
const RECEIPT = w(4).toHex();
const REQUEST_NULLIFIER = w(5).toHex();
const RECEIPT_NULLIFIER = w(6).toHex();
const RECIPIENT = w(7).toHex();
const P2ID = w(8).toHex();
const CLAIM_ROOT = w(9).toHex();
const SERIAL = w(10).toHex();
const TX = w(11).toHex();
const blockCommitment = (height: number) => w(height + 100).toHex();
const mockGetHeader = jest.fn();
const mockGetProof = jest.fn();
const mockGetNotes = jest.fn();
const mockGetNullifier = jest.fn();
const mockSync = jest.fn();
const mockFree = jest.fn();
const mockBuild = jest.fn();
jest.mock('./funded-claim-request', () => ({ buildFundedGcClaimRequest: (input: unknown) => mockBuild(input) }));

function account(id: string) {
  return { toString: () => id, prefix: () => ({ asInt: () => 3n }), suffix: () => ({ asInt: () => 2n }) };
}
function tag(id: string) {
  return id === ISSUER ? 77 : 88;
}
class TestAsset {
  constructor(
    readonly issuer: string,
    readonly amountValue: bigint
  ) {}
  amount() {
    return this.amountValue;
  }
  faucetId() {
    return account(this.issuer);
  }
}

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: jest.fn(() => ({
    getBlockHeaderByNumber: mockGetHeader,
    getAccountProof: mockGetProof,
    getNotesById: mockGetNotes,
    getNullifierCommitHeight: mockGetNullifier,
    syncNotes: mockSync,
    getNetworkNoteStatus: async () => ({ status: 'Discarded' }),
    free: mockFree
  })),
  Word: class {
    constructor(values: BigUint64Array) {
      return new TestWord(values);
    }
    static fromHex(value: string) {
      return TestWord.fromHex(value);
    }
  },
  NoteId: { fromHex: (value: string) => ({ toString: () => value }) },
  NoteType: { Public: 1 },
  NoteScript: { p2id: () => ({ root: () => w(8) }) },
  Felt: class {
    constructor(readonly value: bigint) {}
  },
  FeltArray: class {
    constructor(readonly values: unknown[]) {}
  },
  NoteStorage: class {
    constructor(readonly values: unknown) {}
  },
  NoteRecipient: class {
    digest() {
      return w(7);
    }
  },
  FungibleAsset: { fromVaultEntry: () => new TestAsset(ISSUER, 10_000_000n) },
  NetworkAccountTarget: {
    fromAttachment: (attachment: { target: string }) => ({ targetId: () => account(attachment.target) })
  },
  NoteTag: class {
    constructor(readonly value: number) {}
    asU32() {
      return this.value;
    }
    static withAccountTarget(value: { toString(): string }) {
      return { asU32: () => tag(value.toString()) };
    }
  },
  AccountStorageRequirements: class {}
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (id: string) => account(id.toLowerCase()),
  canonicalWalletAccountId: (id: string) => id.toLowerCase()
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: async () => undefined,
  getRpcEndpoint: () => 'https://rpc.testnet.example'
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: GENESIS,
  accountId: ACCOUNT,
  issuerId: ISSUER,
  issuerCodeCommitment: CODE,
  nativeAssetId: NATIVE
};
const operation: GcClaimOperation = {
  version: 1,
  scope: { genesisCommitment: GENESIS, accountId: ACCOUNT, issuerId: ISSUER, approvedWeek: 123 },
  issuerCodeCommitment: CODE,
  nativeAssetId: NATIVE,
  requestNoteId: REQUEST,
  receiptRecipientCommitment: RECIPIENT,
  nativeBudget: 10_000n,
  outgoingNativeAmount: 11_700n,
  approvalExpiresAt: 4_000_000_000,
  reclaimHeight: 200
};
const config = { claimScriptRoot: CLAIM_ROOT, deploymentBlock: 1 };

class PublicFixture {
  sender: string;
  scriptRoot: string;
  recipientDigest: string;
  serial = SERIAL;
  fields: bigint[];
  assetsList: TestAsset[];
  validPath = true;
  constructor(
    readonly id: string,
    readonly height: number,
    readonly request: boolean
  ) {
    this.sender = request ? ACCOUNT : ISSUER;
    this.scriptRoot = request ? CLAIM_ROOT : P2ID;
    this.recipientDigest = request ? w(12).toHex() : RECIPIENT;
    this.fields = request
      ? [
          ...Array.from(w(8).values),
          ...Array.from(w(10).values),
          777n,
          0n,
          0n,
          0n,
          10_000_000n,
          0n,
          0n,
          0n,
          88n,
          0n,
          0n,
          0n,
          2n,
          3n,
          123n,
          4_000_000_000n,
          ...Array.from(w(2).values),
          200n,
          1n,
          0n,
          0n,
          ...Array.from(w(1).values)
        ]
      : [2n, 3n, 123n, 4_000_000_000n];
    this.assetsList = request
      ? [new TestAsset(NATIVE, 10_000n)]
      : [new TestAsset(ISSUER, 10_000_000n), new TestAsset(NATIVE, 8_400n)];
  }
  body() {
    return {
      id: () => ({ toString: () => this.id }),
      commitment: () => TestWord.fromHex(this.id),
      metadata: () => this.metadata(),
      script: () => ({ root: () => TestWord.fromHex(this.scriptRoot), serialize: () => new Uint8Array([9]) }),
      recipient: () => ({
        digest: () => TestWord.fromHex(this.recipientDigest),
        serialNum: () => TestWord.fromHex(this.serial),
        storage: () => ({ items: () => this.fields.map(value => ({ asInt: () => value })) })
      }),
      assets: () => ({ fungibleAssets: () => this.assetsList, nonFungibleAssets: () => [] }),
      nullifier: () => TestWord.fromHex(this.request ? REQUEST_NULLIFIER : RECEIPT_NULLIFIER),
      attachments: () => (this.request ? [{ target: ISSUER }] : []),
      isNetworkNote: () => this.request,
      serialize: () => new Uint8Array(this.request ? [1, Number(TestWord.fromHex(this.serial).values[0])] : [2])
    };
  }
  metadata() {
    return {
      sender: () => account(this.sender),
      noteType: () => 1,
      tag: () => ({ asU32: () => (this.request ? 77 : 88) })
    };
  }
  fetched() {
    return {
      noteId: { toString: () => this.id },
      note: this.body(),
      metadata: this.metadata(),
      noteType: 1,
      inclusionProof: {
        location: () => ({ blockNum: () => this.height, blockNoteTreeIndex: () => 1 }),
        notePath: () => ({ verify: () => this.validPath })
      }
    };
  }
  committed() {
    return {
      noteId: () => ({ toString: () => this.id }),
      sender: () => account(this.sender),
      tag: () => (this.request ? 77 : 88)
    };
  }
}

let requestNote: PublicFixture;
let receiptNote: PublicFixture;
let nullifierHeights: Map<string, number>;
let notes: Map<string, PublicFixture>;
let syncNotes: PublicFixture[];
let tip: number;

beforeEach(() => {
  jest.clearAllMocks();
  tip = 210;
  requestNote = new PublicFixture(REQUEST, 10, true);
  receiptNote = new PublicFixture(RECEIPT, 20, false);
  notes = new Map([
    [REQUEST, requestNote],
    [RECEIPT, receiptNote]
  ]);
  syncNotes = [receiptNote];
  nullifierHeights = new Map([[REQUEST_NULLIFIER, 20]]);
  mockBuild.mockImplementation(() => ({
    requestNoteId: REQUEST,
    requestNullifier: REQUEST_NULLIFIER,
    receiptRecipientCommitment: RECIPIENT,
    requestBytes: new Uint8Array(),
    noteBytes: new Uint8Array([1, 10])
  }));
  mockGetHeader.mockImplementation(async (height?: number) => ({
    blockNum: () => height ?? tip,
    commitment: () => TestWord.fromHex(height === 0 ? GENESIS : blockCommitment(height ?? tip)),
    noteRoot: () => w(90)
  }));
  mockGetProof.mockImplementation(async () => ({
    blockNum: () => tip,
    accountId: () => account(ISSUER),
    accountHeader: () => ({ codeCommitment: () => TestWord.fromHex(CODE) }),
    getStorageSlotValue: () => TestWord.fromHex(GENESIS)
  }));
  mockGetNotes.mockImplementation(async (ids: { toString(): string }[]) =>
    ids.flatMap(id => {
      const found = notes.get(id.toString());
      return found ? [found.fetched()] : [];
    })
  );
  mockGetNullifier.mockImplementation(async (nullifier: TestWord) => nullifierHeights.get(nullifier.toHex()));
  mockSync.mockImplementation(async (from: number, to: number) => ({
    blockTo: () => to,
    notes: () => syncNotes.filter(note => note.height >= from && note.height <= to).map(note => note.committed())
  }));
});

async function completedConsume(
  noteId: string,
  nullifier: string,
  refBlock: number,
  overrides: Partial<ITransaction> = {}
) {
  await Repo.transactions.add({
    id: 'own-consume',
    type: 'consume',
    accountId: ACCOUNT,
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'RECEIVE',
    transactionId: TX,
    noteId,
    noteIds: [noteId],
    submitEvidence: [
      {
        attemptId: 'consume-attempt',
        source: 'pin',
        capturedAt: 1,
        transactionId: TX,
        initialCommitment: w(40).toHex(),
        finalCommitment: w(41).toHex(),
        initialNonce: '2',
        outputNoteIds: [],
        nullifiers: [nullifier],
        refBlock,
        refBlockCommitment: blockCommitment(refBlock),
        expirationBlock: refBlock + 20
      }
    ],
    ...overrides
  });
}

it('proves linked issuance without fabricating an unavailable issuer transaction ID', async () => {
  const result = await reconcileGcClaim(context, operation, config);
  expect(result.state).toBe('issued');
  expect(result.evidence).toEqual([
    {
      kind: 'issued',
      genesisCommitment: GENESIS,
      blockNumber: 20,
      blockCommitment: blockCommitment(20),
      requestNoteId: REQUEST,
      requestNullifier: REQUEST_NULLIFIER,
      issuerId: ISSUER,
      accountId: ACCOUNT,
      receiptNoteId: RECEIPT,
      receiptRecipientCommitment: RECIPIENT,
      gcAmount: 10_000_000n,
      nativeRefund: 8_400n,
      issuerFee: 1_600n
    }
  ]);
  expect(result.receiptNoteBytes).toEqual(new Uint8Array([2]));
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('keeps issuance pending delivery until an own completed consume matches its on-chain nullifier', async () => {
  nullifierHeights.set(RECEIPT_NULLIFIER, 21);
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('issued');
  await completedConsume(RECEIPT, RECEIPT_NULLIFIER, 20, { status: ITransactionStatus.Unconfirmed });
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('issued');
  await Repo.transactions.update('own-consume', { status: ITransactionStatus.Completed });
  const delivered = await reconcileGcClaim(context, operation, config);
  expect(delivered.state).toBe('delivered');
  expect(delivered.evidence[1]).toMatchObject({
    kind: 'delivered',
    transactionId: TX,
    receiptNullifier: RECEIPT_NULLIFIER,
    blockNumber: 21
  });
});

it('never mistakes network discarded status, missing receipts or absent requests for a safe new claim', async () => {
  notes.delete(REQUEST);
  expect(await reconcileGcClaim(context, operation, config)).toMatchObject({ state: 'pending', evidence: [] });
  notes.set(REQUEST, requestNote);
  syncNotes = [];
  expect(await reconcileGcClaim(context, operation, config)).toMatchObject({ state: 'pending', evidence: [] });
  nullifierHeights.delete(REQUEST_NULLIFIER);
  expect(await reconcileGcClaim(context, operation, config)).toMatchObject({ state: 'reclaimable', evidence: [] });
});

it('proves a reclaim only with the original sender completed consume and a reference at the cutoff', async () => {
  syncNotes = [];
  nullifierHeights.set(REQUEST_NULLIFIER, 201);
  await completedConsume(REQUEST, REQUEST_NULLIFIER, 200);
  const result = await reconcileGcClaim(context, operation, config);
  expect(result.state).toBe('reclaimed');
  expect(result.evidence).toMatchObject([
    { kind: 'reclaimed', transactionId: TX, referenceBlock: 200, blockNumber: 201 }
  ]);
});

it('rejects mismatched request identity, serial binding and invalid inclusion proof', async () => {
  requestNote.validPath = false;
  await expect(reconcileGcClaim(context, operation, config)).rejects.toThrow();
  requestNote.validPath = true;
  requestNote.serial = w(12).toHex();
  await expect(reconcileGcClaim(context, operation, config)).rejects.toThrow();
  requestNote.serial = SERIAL;
  requestNote.fields[32] = 100n;
  await expect(reconcileGcClaim(context, operation, config)).rejects.toThrow();
});

it('rejects receipt over-refunds and does not accept a receipt from another block or recipient', async () => {
  receiptNote.assetsList[1] = new TestAsset(NATIVE, 10_001n);
  await expect(reconcileGcClaim(context, operation, config)).rejects.toThrow();
  receiptNote.assetsList[1] = new TestAsset(NATIVE, 8_400n);
  receiptNote.recipientDigest = w(14).toHex();
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('pending');
  receiptNote.recipientDigest = RECIPIENT;
  syncNotes = [new PublicFixture(RECEIPT, 19, false)];
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('pending');
});

it('requires pinned genesis and issuer code and leaves read errors unresolved', async () => {
  mockGetProof.mockImplementationOnce(async () => ({
    blockNum: () => tip,
    accountId: () => account(ISSUER),
    accountHeader: () => ({ codeCommitment: () => w(14) }),
    getStorageSlotValue: () => TestWord.fromHex(GENESIS)
  }));
  await expect(reconcileGcClaim(context, operation, config)).rejects.toThrow();
  mockGetNotes.mockRejectedValueOnce(new Error('offline'));
  await expect(reconcileGcClaim(context, operation, config)).rejects.toThrow('offline');
});

it('returns bounded historical material without inventing original request fees or executable bytes', async () => {
  syncNotes = [requestNote];
  const first = await scanGcClaimHistoryPage(context, config);
  expect(first.complete).toBe(false);
  expect(first.cursor).toMatchObject({ nextBlock: 129, tipBlock: 210 });
  expect(first.requests).toHaveLength(1);
  expect(first.requests[0]?.material).toMatchObject({
    scope: operation.scope,
    requestNoteId: REQUEST,
    nativeBudget: 10_000n,
    receiptRecipientCommitment: RECIPIENT
  });
  expect(first.requests[0]?.material).not.toHaveProperty('outgoingNativeAmount');
  expect(first.requests[0]?.material).not.toHaveProperty('requestBytes');
  const second = await scanGcClaimHistoryPage(context, config, first.cursor);
  expect(second.complete).toBe(true);
  expect(second.requests).toEqual([]);
  tip = 212;
  const advanced = await scanGcClaimHistoryPage(context, config, second.cursor);
  expect(advanced.complete).toBe(true);
  expect(advanced.cursor).toMatchObject({ nextBlock: 213, tipBlock: 212 });
});

it('recognizes a completed captured ordinary execute reclaim with the exact consumed request nullifier', async () => {
  syncNotes = [];
  nullifierHeights.set(REQUEST_NULLIFIER, 201);
  await completedConsume(REQUEST, REQUEST_NULLIFIER, 200, { type: 'execute', gcReclaimOf: 'original-operation' });
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('reclaimed');
});

it('bounds failed RPC reads and frees its reader only when the abandoned operation settles', async () => {
  jest.useFakeTimers();
  let settle: () => void = () => {
    throw new Error('Read did not start');
  };
  mockGetNotes.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        settle = () => resolve([]);
      })
  );
  const result = reconcileGcClaim(context, operation, config);
  const rejection = result.catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(15_001);
  expect(await rejection).toMatchObject({ message: expect.stringContaining('timed out') });
  expect(mockFree).not.toHaveBeenCalled();
  settle();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('holds recovery pending while a captured reclaim may still submit, even if its local row failed', async () => {
  nullifierHeights.delete(REQUEST_NULLIFIER);
  await completedConsume(REQUEST, REQUEST_NULLIFIER, 200, {
    type: 'execute',
    status: ITransactionStatus.Unconfirmed,
    gcReclaimOf: gcClaimTransactionId(operation.scope)
  });
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('pending');
  await Repo.transactions.update('own-consume', { status: ITransactionStatus.Failed });
  expect((await reconcileGcClaim(context, operation, config)).state).toBe('pending');
});
