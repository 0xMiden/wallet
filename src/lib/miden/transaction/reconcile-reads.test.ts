import { __resetCadenceForTests, createNodeReads, observedCadenceMs, observeTip, ZERO_WORD } from './reconcile-reads';

const mockClient = {
  getBlockHeaderByNumber: jest.fn(),
  getAccountProof: jest.fn(),
  getNotesById: jest.fn(),
  getNullifierCommitHeight: jest.fn()
};
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: jest.fn(() => mockClient),
  NoteId: { fromHex: (hex: string) => ({ hex }) },
  Word: { fromHex: (hex: string) => ({ hex }) }
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(async () => {}),
  getRpcEndpoint: jest.fn(() => 'endpoint')
}));
jest.mock('../sdk/helpers', () => ({ accountRefToSdk: (id: string) => ({ id }) }));
let mockRpcUrl = 'https://rpc.a';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => mockRpcUrl }));

const UPPER = `0x${'AB'.repeat(32)}`;
const LOWER = UPPER.toLowerCase();
const CD = `0x${'cd'.repeat(32)}`;
const ACCOUNT_HEX = `0x${'ab'.repeat(15)}`;
const word = (hex: string) => ({ toHex: () => hex });
const proof = (block: number, commitment: string, nonce?: bigint) => ({
  blockNum: () => block,
  accountCommitment: () => word(commitment),
  accountHeader: () => (nonce === undefined ? undefined : { nonce: () => ({ asInt: () => nonce }) })
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetCadenceForTests();
  mockRpcUrl = 'https://rpc.a';
});

// A test that fails before its clock spy is restored would hand its queued times to the next test.
afterEach(() => jest.restoreAllMocks());

describe('createNodeReads (#1081)', () => {
  it('builds one RpcClient for the pass, on the effective endpoint, and makes every read on it', async () => {
    const { RpcClient } = jest.requireMock('@miden-sdk/miden-sdk/lazy');
    const reads = await createNodeReads();
    mockClient.getBlockHeaderByNumber.mockResolvedValueOnce({ commitment: () => word(UPPER) });
    mockClient.getNullifierCommitHeight.mockResolvedValueOnce(undefined);
    await reads.blockCommitment(5);
    await reads.nullifierHeight(LOWER, 10, 15_000);
    expect(RpcClient).toHaveBeenCalledTimes(1);
    expect(RpcClient).toHaveBeenCalledWith('endpoint');
  });

  // Review Focus 1: node reads come back lower case whatever the SDK's text case.
  it('reads a header commitment lower-cased, and undefined on failure', async () => {
    const reads = await createNodeReads();
    mockClient.getBlockHeaderByNumber.mockResolvedValueOnce({ commitment: () => word(UPPER) });
    expect(await reads.blockCommitment(5)).toBe(LOWER);
    expect(mockClient.getBlockHeaderByNumber).toHaveBeenCalledWith(5, false);
    mockClient.getBlockHeaderByNumber.mockRejectedValueOnce(new Error('unreachable'));
    expect(await reads.blockCommitment(5)).toBeUndefined();
  });

  it('reads the account at a block or the tip, with its nonce when a header exists', async () => {
    const reads = await createNodeReads();
    mockClient.getAccountProof.mockResolvedValueOnce(proof(90, UPPER, 7n));
    expect(await reads.account('acct', undefined, 15_000)).toEqual({
      ok: true,
      state: { blockNum: 90, commitment: LOWER, nonce: '7' }
    });
    expect(mockClient.getAccountProof).toHaveBeenLastCalledWith({ id: 'acct' }, null, null);
    mockClient.getAccountProof.mockResolvedValueOnce(proof(80, UPPER));
    expect(await reads.account('acct', 80, 15_000)).toEqual({ ok: true, state: { blockNum: 80, commitment: LOWER } });
    expect(mockClient.getAccountProof).toHaveBeenLastCalledWith({ id: 'acct' }, null, 80);
  });

  it('reads a non-inclusion witness as an absent account, never as a commitment', async () => {
    const reads = await createNodeReads();
    mockClient.getAccountProof.mockResolvedValueOnce(proof(90, ZERO_WORD));
    expect(await reads.account('acct', undefined, 15_000)).toEqual({ ok: true, state: { blockNum: 90 } });
  });

  it('tells a pruned block from any other failure', async () => {
    const reads = await createNodeReads();
    mockClient.getAccountProof.mockRejectedValueOnce(new Error('block 12 has been pruned'));
    expect(await reads.account('acct', 12, 15_000)).toEqual({ ok: false, pruned: true, timedOut: false });
    mockClient.getAccountProof.mockRejectedValueOnce(new Error('connection reset'));
    expect(await reads.account('acct', 12, 15_000)).toEqual({ ok: false, pruned: false, timedOut: false });
  });

  // A public account's read asks the node for its details, and the node answers an absent one with an error.
  it('reads an account the node reports not found at a block as absent at that block', async () => {
    const reads = await createNodeReads();
    mockClient.getAccountProof.mockRejectedValueOnce(
      new Error(`grpc request failed for get_account: account ${ACCOUNT_HEX} not found at block 123`)
    );
    expect(await reads.account('acct', 123, 15_000)).toEqual({ ok: true, state: { blockNum: 123 } });
    mockClient.getAccountProof.mockRejectedValueOnce(new Error('block 123 has been pruned'));
    expect(await reads.account('acct', 123, 15_000)).toEqual({ ok: false, pruned: true, timedOut: false });
  });

  it('dates each note by its inclusion block, keyed by its lower-cased id; a missing note is just absent', async () => {
    const reads = await createNodeReads();
    mockClient.getNotesById.mockResolvedValueOnce([
      { noteId: { toString: () => UPPER }, inclusionProof: { location: () => ({ blockNum: () => 44 }) } }
    ]);
    const notes = await reads.noteInclusions([LOWER, CD], 15_000);
    expect(notes).toEqual(new Map([[LOWER, 44]]));
    expect(mockClient.getNotesById).toHaveBeenCalledWith([{ hex: LOWER }, { hex: CD }]);
    mockClient.getNotesById.mockRejectedValueOnce(new Error('x'));
    expect(await reads.noteInclusions([LOWER], 15_000)).toBeUndefined();
  });

  it('reads a nullifier height: a number when spent, null when not, undefined on failure', async () => {
    const reads = await createNodeReads();
    mockClient.getNullifierCommitHeight.mockResolvedValueOnce(33);
    expect(await reads.nullifierHeight(LOWER, 10, 15_000)).toBe(33);
    expect(mockClient.getNullifierCommitHeight).toHaveBeenCalledWith({ hex: LOWER }, 10);
    mockClient.getNullifierCommitHeight.mockResolvedValueOnce(undefined);
    expect(await reads.nullifierHeight(LOWER, 10, 15_000)).toBeNull();
    mockClient.getNullifierCommitHeight.mockRejectedValueOnce(new Error('x'));
    expect(await reads.nullifierHeight(LOWER, 10, 15_000)).toBeUndefined();
  });

  it('bounds every read by its timeout, with no retry', async () => {
    jest.useFakeTimers();
    try {
      const reads = await createNodeReads();
      mockClient.getAccountProof.mockImplementation(() => new Promise(() => {}));
      const read = reads.account('acct', undefined, 2_000);
      await jest.advanceTimersByTimeAsync(4_001);
      await expect(read).resolves.toEqual({ ok: false, pruned: false, timedOut: true });
      expect(mockClient.getAccountProof).toHaveBeenCalledTimes(1);
    } finally {
      mockClient.getAccountProof.mockReset();
      jest.useRealTimers();
    }
  });
});

describe('the observed cadence (#1081)', () => {
  it('is 500 ms until two tip reads exist, then the time per block between them', () => {
    expect(observedCadenceMs()).toBe(500);
    observeTip(100, 10_000);
    expect(observedCadenceMs()).toBe(500);
    observeTip(110, 40_000);
    expect(observedCadenceMs()).toBe(3_000);
    observeTip(110, 50_000);
    expect(observedCadenceMs()).toBe(3_000);
  });

  it('never reads faster than 500 ms a block, whatever two reads measure', () => {
    observeTip(100, 0);
    observeTip(101, 20);
    expect(observedCadenceMs()).toBe(500);
  });

  it('starts over when the tip goes down', () => {
    observeTip(100, 0);
    observeTip(110, 30_000);
    expect(observedCadenceMs()).toBe(3_000);
    observeTip(50, 40_000);
    expect(observedCadenceMs()).toBe(500);
    observeTip(52, 44_000);
    expect(observedCadenceMs()).toBe(2_000);
  });

  it('belongs to the endpoint it was measured on, and starts over on another', () => {
    observeTip(100, 0);
    observeTip(110, 30_000);
    mockRpcUrl = 'https://rpc.b';
    expect(observedCadenceMs()).toBe(500);
    observeTip(112, 40_000);
    expect(observedCadenceMs()).toBe(500);
    observeTip(114, 44_000);
    expect(observedCadenceMs()).toBe(2_000);
    mockRpcUrl = 'https://rpc.a';
    expect(observedCadenceMs()).toBe(500);
  });

  it('measures from tip reads the adapter makes', async () => {
    const reads = await createNodeReads();
    const now = jest.spyOn(performance, 'now');
    now.mockReturnValueOnce(1_000);
    mockClient.getAccountProof.mockResolvedValueOnce(proof(100, UPPER));
    await reads.account('acct', undefined, 15_000);
    now.mockReturnValueOnce(7_000);
    mockClient.getAccountProof.mockResolvedValueOnce(proof(102, UPPER));
    await reads.account('acct', undefined, 15_000);
    expect(observedCadenceMs()).toBe(3_000);
  });

  it('measures from a tip read that finds the account absent', async () => {
    const reads = await createNodeReads();
    const now = jest.spyOn(performance, 'now');
    now.mockReturnValueOnce(1_000);
    mockClient.getAccountProof.mockRejectedValueOnce(
      Object.assign(new Error('grpc request failed for get_account: invalid request parameters'), {
        cause: new Error(`account ${ACCOUNT_HEX} not found at block 100`)
      })
    );
    expect(await reads.account('acct', undefined, 15_000)).toEqual({ ok: true, state: { blockNum: 100 } });
    now.mockReturnValueOnce(7_000);
    mockClient.getAccountProof.mockResolvedValueOnce(proof(102, UPPER));
    await reads.account('acct', undefined, 15_000);
    expect(observedCadenceMs()).toBe(3_000);
  });

  it("credits a pass's tip reads to the endpoint its client was built on", async () => {
    const reads = await createNodeReads();
    mockRpcUrl = 'https://rpc.b';
    const now = jest.spyOn(performance, 'now');
    now.mockReturnValueOnce(1_000);
    mockClient.getAccountProof.mockResolvedValueOnce(proof(100, UPPER));
    await reads.account('acct', undefined, 15_000);
    now.mockReturnValueOnce(7_000);
    mockClient.getAccountProof.mockResolvedValueOnce(proof(102, UPPER));
    await reads.account('acct', undefined, 15_000);
    expect(observedCadenceMs()).toBe(500);
    mockRpcUrl = 'https://rpc.a';
    expect(observedCadenceMs()).toBe(3_000);
  });
});
