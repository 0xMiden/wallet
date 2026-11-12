/** @jest-environment node */
import {
  readMainnetFaucetMetadata,
  readMainnetMidenBlock,
  verifyMainnetMidenNoteInclusion
} from '../playwright/e2e/helpers/mainnet-miden-read';

const mockHeader = jest.fn();
const mockDetails = jest.fn();
const mockFaucet = jest.fn();
const mockRpc = jest.fn();
const mockNotes = jest.fn();
const noteId = `0x${'a'.repeat(64)}`;
const senderHex = '0x593c167bec26769178dcbd1f9bcb40';
const nodeRoot = { chainHeaderRoot: true };
const mockPath = jest.fn();
jest.mock('@miden-sdk/miden-sdk', () => ({
  Endpoint: jest.fn().mockImplementation(url => ({ url })),
  AccountId: { fromHex: (value: string) => value },
  NoteId: { fromHex: (value: string) => value },
  Word: { fromHex: (value: string) => value },
  RpcClient: jest.fn().mockImplementation(endpoint => {
    mockRpc(endpoint);
    return { getBlockHeaderByNumber: mockHeader, getAccountDetails: mockDetails, getNotesById: mockNotes };
  }),
  BasicFungibleFaucetComponent: { fromAccountStorage: (storage: unknown) => mockFaucet(storage) }
}));

const rpcUrl = 'https://rpc.mainnet.miden.io';
const faucetId = '0xe69e6ca6e39df1b10c1e5399399feb';
beforeEach(() => {
  jest.clearAllMocks();
  mockHeader.mockResolvedValue({ blockNum: () => 813623, noteRoot: () => nodeRoot });
  mockPath.mockImplementation((index, leaf, root) => index === 5n && leaf === noteId && root === nodeRoot);
  mockNotes.mockResolvedValue([
    {
      noteId: { toString: () => noteId },
      metadata: { sender: () => ({ toString: () => senderHex }) },
      inclusionProof: {
        location: () => ({ blockNum: () => 813623, blockNoteTreeIndex: () => 5 }),
        notePath: () => ({ verify: mockPath })
      }
    }
  ]);
  mockDetails.mockResolvedValue({ account: () => ({ storage: () => 'public-faucet-storage' }) });
  mockFaucet.mockReturnValue({ symbol: () => ({ toString: () => 'USDCX' }), decimals: () => 6 });
});

it('verifies the exact note, sender and inclusion path against the actual canonical node header, never a provider label', async () => {
  await expect(verifyMainnetMidenNoteInclusion(rpcUrl, noteId, 813623, senderHex)).resolves.toBeUndefined();
  expect(mockHeader).toHaveBeenCalledWith(813623);
  expect(mockNotes).toHaveBeenCalledWith([noteId]);
  expect(mockPath).toHaveBeenCalledWith(5n, noteId, nodeRoot);
});
it('rejects a note not proven under the actual node header root', async () => {
  mockPath.mockReturnValue(false);
  await expect(verifyMainnetMidenNoteInclusion(rpcUrl, noteId, 813623, senderHex)).rejects.toThrow();
});
it('refuses a different provider sender even when the note ID is syntactically valid', async () => {
  await expect(verifyMainnetMidenNoteInclusion(rpcUrl, noteId, 813623, `0x${'11'.repeat(15)}`)).rejects.toThrow();
});
it('does not substitute the current header for the requested note block', async () => {
  mockHeader.mockResolvedValue({ blockNum: () => 813624, noteRoot: () => nodeRoot });
  await expect(verifyMainnetMidenNoteInclusion(rpcUrl, noteId, 813623, senderHex)).rejects.toThrow();
});
it('does not accept a missing note response as settlement', async () => {
  mockNotes.mockResolvedValue([]);
  await expect(verifyMainnetMidenNoteInclusion(rpcUrl, noteId, 813623, senderHex)).rejects.toThrow();
});
it('reads a live header using the native Node RPC client, without a wallet or browser WASM initialization', async () => {
  await expect(readMainnetMidenBlock(rpcUrl)).resolves.toBe(813623);
  expect(mockRpc).toHaveBeenCalledWith({ url: rpcUrl });
  expect(mockHeader).toHaveBeenCalledWith(undefined);
});
it('resolves the exact public faucet storage through the native Node SDK', async () => {
  await expect(readMainnetFaucetMetadata(faucetId, rpcUrl)).resolves.toEqual({ symbol: 'USDCX', decimals: 6 });
  expect(mockDetails).toHaveBeenCalledWith(faucetId);
  expect(mockFaucet).toHaveBeenCalledWith('public-faucet-storage');
});
it.each([0, -1, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an unusable chain height %s', async value => {
  mockHeader.mockResolvedValue({ blockNum: () => value });
  await expect(readMainnetMidenBlock(rpcUrl)).rejects.toThrow(/height/i);
});
it('does not guess metadata for an account without public state', async () => {
  mockDetails.mockResolvedValue({ account: () => null });
  await expect(readMainnetFaucetMetadata(faucetId, rpcUrl)).rejects.toThrow(/public.*state/i);
  expect(mockFaucet).not.toHaveBeenCalled();
});
it('preserves provider failures rather than substituting metadata', async () => {
  mockDetails.mockRejectedValue(new Error('RPC offline'));
  await expect(readMainnetFaucetMetadata(faucetId, rpcUrl)).rejects.toThrow('RPC offline');
});
it('refuses invalid faucet identities before contacting the RPC', async () => {
  await expect(readMainnetFaucetMetadata('USDCX', rpcUrl)).rejects.toThrow(/faucet/i);
  expect(mockRpc).not.toHaveBeenCalled();
});
it.each([
  'http://rpc.mainnet.miden.io',
  'https://user:password@rpc.mainnet.miden.io',
  'https://rpc.mainnet.miden.io?key=secret'
])('refuses credential-bearing or non-TLS RPC URLs: %s', async url => {
  await expect(readMainnetMidenBlock(url)).rejects.toThrow(/RPC/i);
  await expect(readMainnetFaucetMetadata(faucetId, url)).rejects.toThrow(/RPC/i);
  expect(mockRpc).not.toHaveBeenCalled();
});
