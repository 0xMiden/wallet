import { redeemMainnetAccessCode, type MainnetAccessTarget } from './mainnet-access';

const mockReady = jest.fn<Promise<void>, []>();
const mockAllowed = jest.fn<Promise<boolean>, [string]>();
const mockRegister = jest.fn<Promise<void>, [string, string]>();
const mockFromHex = jest.fn((id: string) => id);
const mockFromBech32 = jest.fn((id: string) => id);

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  MidenClient: { ready: () => mockReady() },
  Address: { fromBech32: (id: string) => ({ accountId: () => mockFromBech32(id) }) },
  AccountId: {
    fromHex: (id: string) => mockFromHex(id),
    fromBech32: (id: string) => mockFromBech32(id)
  }
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (run: () => Promise<string>) => run(),
  getMidenClient: async () => ({
    client: {
      sync: async () => {},
      accounts: {
        isAllowed: mockAllowed,
        register: ({ account, invitationCode }: { account: string; invitationCode: string }) =>
          mockRegister(account, invitationCode)
      }
    }
  })
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://mainnet.example/rpc' }));

const target: MainnetAccessTarget = { accountId: '0x1234', rpcUrl: 'https://mainnet.example/rpc' };
const rejected = (code: string) => Object.assign(new Error('Registration failed'), { code });

describe('mainnet account registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReady.mockResolvedValue();
    mockAllowed.mockResolvedValue(false);
    mockRegister.mockResolvedValue();
  });

  it('sends the exact code and final account ID to the selected node', async () => {
    await expect(redeemMainnetAccessCode(' Code-123 ', target)).resolves.toBe('granted');
    expect(mockReady).toHaveBeenCalledTimes(1);
    expect(mockFromHex).toHaveBeenCalledWith(target.accountId);
    expect(mockRegister).toHaveBeenCalledWith(target.accountId, ' Code-123 ');
  });

  it('accepts a bech32 account ID', async () => {
    await redeemMainnetAccessCode('12345678', { ...target, accountId: 'mm1account' });
    expect(mockFromBech32).toHaveBeenCalledWith('mm1account');
    expect(mockFromHex).not.toHaveBeenCalled();
  });

  it('does not consume a code when the account is already allowed', async () => {
    mockAllowed.mockResolvedValue(true);
    await expect(redeemMainnetAccessCode('12345678', target)).resolves.toBe('granted');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('rejects an empty code without a node call', async () => {
    await expect(redeemMainnetAccessCode('', target)).resolves.toBe('rejected');
    expect(mockReady).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('does not accept a code before the mainnet account is available', async () => {
    await expect(redeemMainnetAccessCode('47291835')).rejects.toThrow(
      'Mainnet registration requires an account ID and RPC URL'
    );
    expect(mockReady).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it.each(['INVITATION_NOT_FOUND', 'INVALID_REGISTRATION_REQUEST', 'ALREADY_REGISTERED'])(
    'shows a refusal for %s',
    async code => {
      mockRegister.mockRejectedValue(rejected(code));
      await expect(redeemMainnetAccessCode('12345678', target)).resolves.toBe('rejected');
    }
  );

  it('accepts the result of a concurrent registration for the same account', async () => {
    mockAllowed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockRegister.mockRejectedValue(rejected('ALREADY_REGISTERED'));
    await expect(redeemMainnetAccessCode('12345678', target)).resolves.toBe('granted');
  });

  it('retries with the same account after a lost response', async () => {
    const failure = new Error('Connection closed');
    mockRegister.mockRejectedValueOnce(failure);
    await expect(redeemMainnetAccessCode('12345678', target)).rejects.toBe(failure);
    mockAllowed.mockResolvedValue(true);
    await expect(redeemMainnetAccessCode('12345678', target)).resolves.toBe('granted');
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('does not treat a funding failure as a rejected code', async () => {
    const failure = rejected('UNAVAILABLE');
    mockRegister.mockRejectedValue(failure);
    await expect(redeemMainnetAccessCode('12345678', target)).rejects.toBe(failure);
  });

  it('does not submit a code after an access check fails', async () => {
    const failure = new Error('Node unavailable');
    mockAllowed.mockRejectedValue(failure);
    await expect(redeemMainnetAccessCode('12345678', target)).rejects.toBe(failure);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('does not submit a code when WASM initialization fails', async () => {
    const failure = new Error('WASM unavailable');
    mockReady.mockRejectedValue(failure);
    await expect(redeemMainnetAccessCode('12345678', target)).rejects.toBe(failure);
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
