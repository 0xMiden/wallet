import { MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { buildGcSaleRequest } from './gc-sale-request';
import { GC_SALE_SCRIPT_ROOT } from './pswap-order-note';

const mockBytes = new Uint8Array([7, 2]);
const mockExplicitInput = jest.fn();
const mockBuild = jest.fn(() => ({ serialize: () => mockBytes }));
const mockBuilder = { withExplicitInputNote: mockExplicitInput, build: mockBuild };
const mockFeeBuilder = jest.fn(async (_client: MidenClient, _account: string, _salt: string) => mockBuilder);
const mockProof = { proof: true };
const mockNote = { note: true };
const mockRead = jest.fn(async (_noteId: string, _root: string) => ({
  kind: 'open',
  note: mockNote,
  inclusionProof: mockProof,
  fields: { creator: 'seller', storage: [0n, 0n, 100_000n, 0n] }
}));
const mockAuthenticated = jest.fn((_note: typeof mockNote, _proof: typeof mockProof) => ({ authenticated: true }));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  MidenClient: { create: async () => ({}) },
  Felt: class {
    constructor(public value: bigint) {}
  },
  Word: { newFromFelts: (felts: { value: bigint }[]) => felts.map(felt => felt.value) },
  InputNote: { authenticated: (note: typeof mockNote, proof: typeof mockProof) => mockAuthenticated(note, proof) }
}));
jest.mock('./helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0],
  walletAccountIdToSdk: (id: string) => ({ toString: () => id.split('_')[0] }),
  randomFeeSalt: () => 'salt',
  feeAwareRequestBuilder: (client: MidenClient, account: string, salt: string) => mockFeeBuilder(client, account, salt)
}));
jest.mock('./pswap-order-note', () => ({
  GC_SALE_SCRIPT_ROOT: 'sale-root',
  readPublicPswapNote: (noteId: string, root: string) => mockRead(noteId, root)
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockExplicitInput.mockReturnValue(mockBuilder);
  mockRead.mockResolvedValue({
    kind: 'open',
    note: mockNote,
    inclusionProof: mockProof,
    fields: { creator: 'seller', storage: [0n, 0n, 100_000n, 0n] }
  });
});

const purchase = { noteId: 'sale', fillAmount: 1_000n, creatorAccountId: 'seller' };

it('builds the purchase with fee auth, an authenticated note and an explicit payment', async () => {
  const client = await MidenClient.create({ rpcUrl: 'https://node.test' });
  const assertLive = jest.fn();
  expect(await buildGcSaleRequest(client, 'buyer_suffix', purchase, assertLive)).toBe(mockBytes);
  expect(mockRead).toHaveBeenCalledWith('sale', GC_SALE_SCRIPT_ROOT);
  expect(mockFeeBuilder).toHaveBeenCalledWith(client, 'buyer', 'salt');
  expect(mockAuthenticated).toHaveBeenCalledWith(mockNote, mockProof);
  expect(mockExplicitInput).toHaveBeenCalledWith({ authenticated: true }, [1_000n, 0n, 0n, 0n]);
  expect(assertLive).toHaveBeenCalledTimes(2);
});

it('refuses the buyer’s own sale before it reads the node', async () => {
  const client = await MidenClient.create();
  await expect(buildGcSaleRequest(client, 'seller_suffix', purchase, jest.fn())).rejects.toThrow('own sale');
  expect(mockRead).not.toHaveBeenCalled();
});

it.each([0n, -1n, 100_001n])('refuses an invalid payment of %s', async fillAmount => {
  const client = await MidenClient.create();
  await expect(buildGcSaleRequest(client, 'buyer', { ...purchase, fillAmount }, jest.fn())).rejects.toThrow('payment');
  expect(mockFeeBuilder).not.toHaveBeenCalled();
});

it('checks the minimum fill and clamps it to the remaining request', async () => {
  const client = await MidenClient.create();
  mockRead.mockResolvedValue({
    kind: 'open',
    note: mockNote,
    inclusionProof: mockProof,
    fields: { creator: 'seller', storage: [0n, 0n, 500n, 2_000n] }
  });
  await expect(buildGcSaleRequest(client, 'buyer', { ...purchase, fillAmount: 499n }, jest.fn())).rejects.toThrow(
    'payment'
  );
  expect(await buildGcSaleRequest(client, 'buyer', { ...purchase, fillAmount: 500n }, jest.fn())).toBe(mockBytes);
});

it('refuses a spent note and a different seller', async () => {
  const client = await MidenClient.create();
  mockRead.mockResolvedValueOnce({
    kind: 'spent',
    note: mockNote,
    inclusionProof: mockProof,
    fields: { creator: 'seller', storage: [] }
  });
  await expect(buildGcSaleRequest(client, 'buyer', purchase, jest.fn())).rejects.toThrow('unavailable');
  await expect(
    buildGcSaleRequest(client, 'buyer', { ...purchase, creatorAccountId: 'other' }, jest.fn())
  ).rejects.toThrow('different seller');
  expect(mockFeeBuilder).not.toHaveBeenCalled();
});

it('stops before building when the WASM hold is lost during the fee read', async () => {
  const client = await MidenClient.create();
  const assertLive = jest
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('hold expired');
    });
  await expect(buildGcSaleRequest(client, 'buyer', purchase, assertLive)).rejects.toThrow('hold expired');
  expect(mockExplicitInput).not.toHaveBeenCalled();
});
