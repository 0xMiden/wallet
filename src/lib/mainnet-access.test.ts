import { MIDEN_NETWORK_ENDPOINTS, MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import {
  checkMainnetAccessCode,
  checkMainnetAccessCodeBeforeSwitch,
  isMainnetAccountAdmitted,
  redeemMainnetAccessCode,
  type MainnetAccessTarget
} from './mainnet-access';

const mockReady = jest.fn<Promise<void>, []>();
const mockAllowed = jest.fn<Promise<boolean>, [string]>();
const mockRegister = jest.fn<Promise<void>, [string, string]>();
const mockSync = jest.fn<Promise<void>, []>();
const mockLockOptions = jest.fn<void, [unknown]>();
const mockClientBuild = jest.fn<Promise<void>, []>();
let mockLiveHold: object | undefined;
const mockFromHex = jest.fn((id: string) => {
  if (!id.startsWith('0x')) throw new Error(`Invalid hex account: ${id}`);
  return id.toLowerCase();
});
const mockFromBech32 = jest.fn((id: string) => {
  if (id.includes('_') || /^0x/i.test(id)) throw new Error(`Invalid bech32 account: ${id}`);
  return id;
});
// Answers per node: the URL the RpcClient was built for, then the code.
const mockIsValid = jest.fn<Promise<boolean>, [string, string]>();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  MidenClient: { ready: () => mockReady() },
  Address: { fromBech32: (id: string) => ({ accountId: () => mockFromBech32(id) }) },
  AccountId: {
    fromHex: (id: string) => mockFromHex(id),
    fromBech32: (id: string) => mockFromBech32(id)
  },
  Endpoint: class {
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
  },
  RpcClient: class {
    readonly endpoint: { url: string };
    constructor(endpoint: { url: string }) {
      this.endpoint = endpoint;
    }
    isInvitationCodeValid(code: string) {
      return mockIsValid(this.endpoint.url, code);
    }
  }
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: <T>(run: (hold: object) => Promise<T>, options: unknown) => {
    mockLockOptions(options);
    const hold = {};
    mockLiveHold = hold;
    return run(hold);
  },
  assertWasmHoldCurrent: (hold: object, where: string) => {
    if (hold !== mockLiveHold) throw new Error(`operation abandoned ${where}`);
  },
  getMidenClient: async () => {
    await mockClientBuild();
    return {
      client: {
        sync: () => mockSync(),
        accounts: {
          isAllowed: mockAllowed,
          register: ({ account, invitationCode }: { account: string; invitationCode: string }) =>
            mockRegister(account, invitationCode)
        }
      }
    };
  }
}));

let mockEffectiveRpcUrl = 'https://mainnet.example/rpc';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => mockEffectiveRpcUrl }));

const target: MainnetAccessTarget = { accountId: '0x1234', rpcUrl: 'https://mainnet.example/rpc' };
const rejected = (code: string) => Object.assign(new Error('Registration failed'), { code });
// What the watchdog does to a parked hold: the mutex moves on while the callback keeps running.
const evictHold = async () => {
  mockLiveHold = undefined;
};

describe('mainnet account registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReady.mockResolvedValue();
    mockClientBuild.mockResolvedValue();
    mockAllowed.mockResolvedValue(false);
    mockRegister.mockResolvedValue();
    mockSync.mockResolvedValue();
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

  it('bounds the client hold with the access watchdog under its own label', async () => {
    await redeemMainnetAccessCode('12345678', target);
    expect(mockLockOptions).toHaveBeenCalledWith({ watchdogMs: 60_000, label: 'mainnet-access-redeem' });
  });

  it.each([
    ['register', () => mockRegister.mockReturnValue(new Promise(() => {}))],
    ['sync', () => mockSync.mockReturnValue(new Promise(() => {}))],
    ['access check', () => mockAllowed.mockReturnValue(new Promise(() => {}))]
  ])('races no %s inside the hold, which only the watchdog ends', async (_call, stall) => {
    jest.useFakeTimers();
    try {
      stall();
      const settled = jest.fn();
      redeemMainnetAccessCode('12345678', target).then(settled, settled);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('makes no register call once the watchdog evicts the hold during the sync', async () => {
    mockSync.mockImplementation(evictHold);
    const outcome = await redeemMainnetAccessCode('12345678', target).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(mockRegister).not.toHaveBeenCalled();
    expect(outcome).toEqual(expect.objectContaining({ message: expect.stringContaining('abandoned') }));
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

describe('mainnet account admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReady.mockResolvedValue();
    mockClientBuild.mockResolvedValue();
  });

  it('resolves an account with a 0X prefix before checking admission', async () => {
    mockAllowed.mockResolvedValue(true);
    await expect(isMainnetAccountAdmitted('0XABC')).resolves.toBe(true);
    expect(mockFromHex).toHaveBeenCalledWith('0xABC');
    expect(mockFromBech32).not.toHaveBeenCalled();
    expect(mockAllowed).toHaveBeenCalledWith('0xabc');
  });

  it.each([true, false])('answers whether the node admits the account (%s), with no code', async allowed => {
    mockAllowed.mockResolvedValue(allowed);
    await expect(isMainnetAccountAdmitted('mm1account_qruqqypuyph')).resolves.toBe(allowed);
    expect(mockFromBech32).toHaveBeenCalledWith('mm1account');
    expect(mockAllowed).toHaveBeenCalledWith('mm1account');
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('bounds the client hold with the access watchdog under its own label', async () => {
    mockAllowed.mockResolvedValue(true);
    await isMainnetAccountAdmitted('0x1234');
    expect(mockLockOptions).toHaveBeenCalledWith({ watchdogMs: 60_000, label: 'mainnet-access-admitted' });
  });

  it('makes no access check once the watchdog evicts the hold during the client build', async () => {
    mockAllowed.mockResolvedValue(true);
    mockClientBuild.mockImplementation(evictHold);
    const outcome = await isMainnetAccountAdmitted('0x1234').then(
      () => undefined,
      (error: unknown) => error
    );
    expect(mockAllowed).not.toHaveBeenCalled();
    expect(outcome).toEqual(expect.objectContaining({ message: expect.stringContaining('abandoned') }));
  });

  it('races no access check inside the hold, which only the watchdog ends', async () => {
    jest.useFakeTimers();
    try {
      mockAllowed.mockReturnValue(new Promise(() => {}));
      const settled = jest.fn();
      isMainnetAccountAdmitted('0x1234').then(settled, settled);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('mainnet access code check', () => {
  const MAINNET_RPC = MIDEN_NETWORK_ENDPOINTS.get(MIDEN_NETWORK_NAME.MAINNET);

  beforeEach(() => {
    jest.clearAllMocks();
    mockReady.mockResolvedValue();
    // A wallet still on testnet, whose node enforces no allowlist and accepts every code.
    mockEffectiveRpcUrl = 'https://rpc.testnet.miden.io';
    mockIsValid.mockImplementation(async (url: string) => url !== MAINNET_RPC);
  });

  afterAll(() => {
    mockEffectiveRpcUrl = 'https://mainnet.example/rpc';
  });

  it("asks the wallet's own node by default", async () => {
    await expect(checkMainnetAccessCode('8gKIgL0O6HcU')).resolves.toBe('granted');
    expect(mockIsValid).toHaveBeenCalledWith('https://rpc.testnet.miden.io', '8gKIgL0O6HcU');
  });

  it('asks the mainnet node before a switch, never the test network the wallet is on', async () => {
    await expect(checkMainnetAccessCodeBeforeSwitch('47291835')).resolves.toBe('rejected');
    expect(mockIsValid.mock.calls).toEqual([[MAINNET_RPC, '47291835']]);
  });

  it('grants a code the mainnet node accepts', async () => {
    mockIsValid.mockResolvedValue(true);
    await expect(checkMainnetAccessCodeBeforeSwitch('8gKIgL0O6HcU')).resolves.toBe('granted');
  });

  it('throws when the mainnet node cannot answer, so no failed check reads as an outcome', async () => {
    mockIsValid.mockRejectedValue(new Error('Failed to fetch'));
    await expect(checkMainnetAccessCodeBeforeSwitch('8gKIgL0O6HcU')).rejects.toThrow('Failed to fetch');
  });
});
