import { readDeviceSigners } from './useDeviceSigners';

const mockGetAccount = jest.fn();
const mockFindSigner = jest.fn<Promise<string | undefined>, [object, string]>();
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: { getAccount: () => mockGetAccount() } }));
jest.mock('lib/miden/guardian/account', () => ({
  findOwnSignerCommitment: (state: object, key: string) => mockFindSigner(state, key),
  getSignerCommitmentsFromAccount: (state: { signers: string[] }) => state.signers
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: <T>(operation: (hold: object) => Promise<T>) => operation({}),
  assertWasmHoldCurrent: jest.fn()
}));

beforeEach(() => jest.resetAllMocks());

it('hides the recovery key and identifies this device in any slot', async () => {
  mockGetAccount.mockResolvedValue({ signers: ['0x11', '0x22', '0x33', '0x44'] });
  mockFindSigner.mockImplementation(async (_state, key) => (key === 'cold' ? '0x22' : '0x44'));
  await expect(
    readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })
  ).resolves.toEqual([
    { commitment: '0x11', current: false },
    { commitment: '0x33', current: false },
    { commitment: '0x44', current: true }
  ]);
});

it('does not guess which key is the recovery key when it is unavailable', async () => {
  mockGetAccount.mockResolvedValue({ signers: ['0x11'] });
  mockFindSigner.mockResolvedValue(undefined);
  await expect(
    readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })
  ).rejects.toThrow();
  await expect(readDeviceSigners({ publicKey: 'account', hotPublicKey: 'hot' })).rejects.toThrow();
});
