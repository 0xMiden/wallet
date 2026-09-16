import { FungibleAsset, Note } from '@miden-sdk/miden-sdk/lazy';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';

import { buildEpochCollateralRequestBytes } from './collateral-note';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  // `randomFeeSalt` builds the declared fee-conversion salt from these; it used to run
  // inside the (mocked-away) fee-auth helper, so the SDK mock never needed them.
  Felt: jest.fn((v: any) => ({ v })),
  Word: { newFromFelts: jest.fn((felts: any) => ({ kind: 'word', felts })) },
  AccountId: {
    fromHex: jest.fn((hex: any) => ({ toString: () => `accountId-${hex}` }))
  },
  Address: {
    fromBech32: jest.fn((str: any) => ({ accountId: () => ({ toString: () => `accountId-${str}` }) })),
    fromAccountId: jest.fn((id: any) => ({ toBech32: () => `bech32-${id}` }))
  },
  NetworkId: { testnet: jest.fn(() => 'testnet'), devnet: jest.fn(() => 'devnet') },
  FungibleAsset: Object.assign(
    jest.fn((faucetId: any, amount: any) => ({ kind: 'ctor-asset', faucetId, amount })),
    { fromVaultKey: jest.fn((key: any, amount: any) => ({ kind: 'vault-key-asset', key, amount })) }
  ),
  Note: {
    createP2IDNote: jest.fn((...args: any[]) => ({ kind: 'p2id', args })),
    createP2IDENote: jest.fn((...args: any[]) => ({ kind: 'p2ide', args }))
  },
  NoteAssets: jest.fn(function (this: any, assets: any) {
    this.assets = assets;
  }),
  NoteAttachment: jest.fn(function (this: any, felts: any) {
    this.felts = felts;
  }),
  NoteArray: jest.fn(function (this: any, notes: any) {
    this.notes = notes;
  }),
  NoteType: { Private: 'Private', Public: 'Public' },
  TransactionRequestBuilder: jest.fn(function (this: any) {
    this.withOwnOutputNotes = (notes: any) => {
      this.ownOutputNotes = notes;
      return this;
    };
    this.withFeeConversionSalt = (salt: any) => {
      this.feeSalt = salt;
      return this;
    };
    this.build = () => ({ serialize: () => new Uint8Array([1, 2, 3]) });
  })
}));

// The lock hands its callback a HOLD, and the builder re-checks ownership after
// the account read (#788 follow-up). Model both here: a hold-less pass-through
// would make `assertWasmHoldCurrent` throw on the happy path, and a mock with no
// way to revoke ownership could not exercise the eviction guard at all.
let currentWasmHold: object | null = null;
const revokeWasmHold = () => {
  currentWasmHold = null;
};

jest.mock('lib/miden/sdk/miden-client', () => ({
  getCurrentWasmLockHold: () => currentWasmHold,
  // Re-implements the real comparison against the mock's current hold — a no-op
  // here would make the eviction test below vacuously green.
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new Error(`operation abandoned ${where}`);
  },
  withWasmClientLock: async (fn: (hold: object) => unknown) => {
    const hold = { mock: 'wasm-lock-hold' };
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (currentWasmHold === hold) currentWasmHold = null;
    }
  }
}));

jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: jest.fn() }
}));

jest.mock('./chain', () => ({
  getCurrentMidenBlock: jest.fn(async () => 1000)
}));

const mockGetAccount = midenClientProxy.getAccount as jest.Mock;

/** One fungible slot, as `account.vault().fungibleAssets()` returns it. */
const vaultAsset = (faucetHex: string, amount: bigint, flag: string) => ({
  faucetId: () => ({ toString: () => faucetHex }),
  amount: () => amount,
  vaultKey: () => `vaultKey-${faucetHex}-${flag}`
});

const accountHolding = (...assets: ReturnType<typeof vaultAsset>[]) => ({
  vault: () => ({ fungibleAssets: () => assets })
});

const SENDER = '0xsender';
const FAUCET = '0xfaucet';
const FAUCET_HEX = 'accountId-0xfaucet';

const build = (overrides: Partial<Parameters<typeof buildEpochCollateralRequestBytes>[0]> = {}) =>
  buildEpochCollateralRequestBytes({
    senderAccountId: SENDER,
    allocatorId: '0xallocator',
    faucetId: FAUCET,
    amount: 100n,
    recallBlocks: 2016,
    bindingAttachmentFelts: [1n, 2n, 3n],
    ...overrides
  });

beforeEach(() => {
  jest.clearAllMocks();
});

// The collateral note REMOVES the asset from the sender's vault, so it is subject
// to exactly the callback-flag rule every send is: the flag is part of the vault
// key, and an asset rebuilt from faucet id + amount carries the default Disabled
// flag. This path used to do precisely that, so an Epoch bridge or Earn deposit of
// a callback-enabled collateral asset addressed an empty slot and was rejected by
// the kernel — the whole flow failing at the first note it mints.
describe('the collateral asset is taken from the slot the sender actually holds', () => {
  it('derives it from the vault key, flag included', async () => {
    mockGetAccount.mockResolvedValue(accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')));

    await build();

    expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
    expect(FungibleAsset).not.toHaveBeenCalled();
  });

  // A faucet occupies one slot per callback flag, so both variants can be held at
  // once and matching on faucet id alone takes whichever comes first.
  it('picks the slot that can fund the amount when a faucet occupies two', async () => {
    mockGetAccount.mockResolvedValue(
      accountHolding(vaultAsset(FAUCET_HEX, 10n, 'disabled'), vaultAsset(FAUCET_HEX, 500n, 'enabled'))
    );

    await build();

    expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
  });

  it('reads the sender account by its canonical id', async () => {
    mockGetAccount.mockResolvedValue(accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')));

    await build({ senderAccountId: '0xsender_guardiansuffix' });

    // The composite guardian form names the account in its address part only.
    expect(mockGetAccount).toHaveBeenCalledWith('accountId-0xsender');
  });

  it('still builds a request when the vault shows nothing, rather than blocking the bridge', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetAccount.mockResolvedValue(accountHolding());

    await expect(build()).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(FungibleAsset.fromVaultKey).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does the same when the account cannot be read at all', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetAccount.mockResolvedValue(null);

    await expect(build()).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects an amount the asset type cannot represent', async () => {
    mockGetAccount.mockResolvedValue(accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')));

    await expect(build({ amount: 1n << 64n })).rejects.toThrow(/outside the representable range/);
  });
});

// #788 follow-up: an eviction during the account read hands the mutex to a
// successor without stopping this callback, and the very next step reads
// `vault().fungibleAssets()` on the returned account — a WASM call on an object
// borrowed from the client's RefCell, i.e. the double borrow, not a stale read.
// Everything in this hold is write PREP (nothing is submitted), so aborting is
// always safe.
describe('the build is abandoned when the WASM lock hold is evicted', () => {
  it('during the account read: neither the vault nor the note is touched', async () => {
    mockGetAccount.mockImplementation(async () => {
      revokeWasmHold();
      return accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled'));
    });

    await expect(build()).rejects.toThrow('operation abandoned before the collateral vault read');

    expect(FungibleAsset.fromVaultKey).not.toHaveBeenCalled();
    expect(Note.createP2IDENote).not.toHaveBeenCalled();
  });
});

// Guarding the parts of the note the allocator validates, which the asset change
// runs alongside and must not disturb.
describe('the rest of the allocator contract is unchanged', () => {
  beforeEach(() => {
    mockGetAccount.mockResolvedValue(accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')));
  });

  it('addresses the allocator and measures the reclaim window from the fresh head', async () => {
    await build();

    const [sender, allocator, , reclaimAfter, timelock, noteType] = (Note.createP2IDENote as jest.Mock).mock.calls[0];
    expect(sender.toString()).toBe('accountId-0xsender');
    expect(allocator.toString()).toBe('accountId-0xallocator');
    expect(reclaimAfter).toBe(1000 + 2016);
    expect(timelock).toBeNull();
    // Private would be "not found on-chain" to the allocator.
    expect(noteType).toBe('Public');
  });

  it('writes the mandate-binding felts verbatim', async () => {
    await build({ bindingAttachmentFelts: [7n, 8n, 9n] });

    const attachment = (Note.createP2IDENote as jest.Mock).mock.calls[0][6];
    expect(attachment.felts).toEqual(BigUint64Array.from([7n, 8n, 9n]));
  });
});
