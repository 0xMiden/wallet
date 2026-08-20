import { AccountId, Address, FungibleAsset, Note } from '@miden-sdk/miden-sdk/lazy';

import {
  accountIdStringToSdk,
  accountRefToSdk,
  buildSendTransactionRequest,
  getBech32AddressFromAccountId,
  sameWalletAccountId,
  walletAccountIdToSdk
} from './helpers';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: {
    fromHex: jest.fn((hex: any) => ({ toString: () => `accountId-${hex}` }))
  },
  Address: {
    fromAccountId: jest.fn((id: any) => ({
      toBech32: () => `bech32-${id}`
    })),
    fromBech32: jest.fn((str: any) => ({
      accountId: () => `accountId-${str}`
    }))
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
  NoteAttachment: jest.fn(function (this: any) {
    this.empty = true;
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
    this.build = () => ({ kind: 'request', ownOutputNotes: this.ownOutputNotes });
  })
}));

/** A vault entry: one fungible asset slot as `account.vault().fungibleAssets()` returns it. */
const vaultAsset = (faucetHex: string, amount: bigint, flag: string) => ({
  faucetId: () => ({ toString: () => faucetHex }),
  amount: () => amount,
  vaultKey: () => `vaultKey-${faucetHex}-${flag}`
});

const accountHolding = (...assets: ReturnType<typeof vaultAsset>[]) => ({
  vault: () => ({ fungibleAssets: () => assets })
});

jest.mock('lib/miden-chain/constants', () => ({
  getNetworkId: jest.fn(() => 'testnet')
}));

describe('miden sdk helpers', () => {
  beforeEach(() => {
    // Call history only — the factory's implementations must survive.
    jest.clearAllMocks();
  });

  it('converts accountId to bech32', () => {
    const res = getBech32AddressFromAccountId('abc' as any);
    expect(Address.fromAccountId).toHaveBeenCalledWith('abc', 'BasicWallet');
    expect(res).toBe('bech32-abc');
  });

  it('converts a bech32 string back to an AccountId', () => {
    const res = accountIdStringToSdk('mtst1qabc');
    expect(Address.fromBech32).toHaveBeenCalledWith('mtst1qabc');
    expect(res).toBe('accountId-mtst1qabc');
  });

  describe('sameWalletAccountId', () => {
    it('matches a bare bech32 address against a composite `<address>_<suffix>` publicKey', () => {
      // dApp/adapter passes the bare address; WalletAccount.publicKey is composite.
      expect(sameWalletAccountId('mtst1qabc_qr7suffix', 'mtst1qabc')).toBe(true);
      expect(sameWalletAccountId('mtst1qabc', 'mtst1qabc_qr7suffix')).toBe(true);
    });

    it('does not match different accounts', () => {
      expect(sameWalletAccountId('mtst1qabc_x', 'mtst1qdef')).toBe(false);
    });

    it('unifies two different address encodings of the same account via the SDK round-trip', () => {
      // Distinct address strings that resolve to the same on-chain account id must
      // match — the value the SDK canonicalization adds over a plain prefix compare.
      (Address.fromBech32 as jest.Mock)
        .mockReturnValueOnce({ accountId: () => 'same-account-id' })
        .mockReturnValueOnce({ accountId: () => 'same-account-id' });
      expect(sameWalletAccountId('mtst1AAA_suffix', 'mtst1BBB')).toBe(true);
    });

    it('falls back to the address portion when the id cannot be parsed', () => {
      (Address.fromBech32 as jest.Mock).mockImplementationOnce(() => {
        throw new Error('not bech32');
      });
      // First arg fails to parse → falls back to the raw address portion; the
      // second still canonicalizes, so they must NOT coincidentally match.
      expect(sameWalletAccountId('rawid_suffix', 'mtst1qdef')).toBe(false);
    });

    // A bech32-only parser sends hex down the unparseable path, where the id
    // canonicalizes to its own raw text and can never equal the same account in
    // bech32 form — answering "different account" for one that is the same, and
    // misrouting a Guardian account through the non-guardian path.
    it('canonicalizes a hex id instead of falling back to its raw text', () => {
      (Address.fromBech32 as jest.Mock).mockReturnValueOnce({ accountId: () => 'shared-account-id' });
      (AccountId.fromHex as jest.Mock).mockReturnValueOnce('shared-account-id');
      expect(sameWalletAccountId('0xABCDEF', 'mtst1qabc')).toBe(true);
    });
  });

  describe('accountRefToSdk', () => {
    it('parses a 0x-prefixed reference as hex', () => {
      accountRefToSdk('0xABCDEF');
      expect(AccountId.fromHex).toHaveBeenCalledWith('0xABCDEF');
      expect(Address.fromBech32).not.toHaveBeenCalled();
    });

    it('parses anything else as bech32', () => {
      accountRefToSdk('mtst1qabc');
      expect(Address.fromBech32).toHaveBeenCalledWith('mtst1qabc');
      expect(AccountId.fromHex).not.toHaveBeenCalled();
    });
  });

  describe('walletAccountIdToSdk', () => {
    it('strips the composite publicKey suffix', () => {
      walletAccountIdToSdk('mtst1qabc_qr7suffix');
      expect(Address.fromBech32).toHaveBeenCalledWith('mtst1qabc');
    });

    // Must stay at least as permissive as the SDK's own resolveAccountRef, which
    // every id handed to transactions.* goes through — a sender the SDK accepts
    // but this rejects fails the send before it is built.
    it('accepts a hex sender id', () => {
      walletAccountIdToSdk('0xABCDEF');
      expect(AccountId.fromHex).toHaveBeenCalledWith('0xABCDEF');
    });
  });

  describe('buildSendTransactionRequest', () => {
    const sender = { id: 'sender' } as any;
    const recipient = { id: 'recipient' } as any;
    // accountRefToSdk('0xfaucet') resolves through the AccountId.fromHex mock,
    // whose toString is what the vault slots are matched against.
    const FAUCET_REF = '0xfaucet';
    const FAUCET_HEX = 'accountId-0xfaucet';

    it('rebuilds the asset from the held vault key so the callback flag survives', () => {
      const request = buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Private' as any
      );

      expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
      expect(FungibleAsset).not.toHaveBeenCalled();
      expect(request).toEqual({ kind: 'request', ownOutputNotes: expect.anything() });
    });

    // The flag is part of the vault key, so one faucet can occupy two slots.
    // Matching on faucet id alone would take whichever comes first — here the
    // one that cannot fund the note, reproducing the very kernel abort the
    // vault-key derivation exists to prevent.
    it('prefers the slot that can fund the amount when a faucet occupies two', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 10n, 'disabled'), vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Private' as any
      );

      expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
    });

    it('falls back to the largest slot when no single slot covers the amount', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 10n, 'disabled'), vaultAsset(FAUCET_HEX, 60n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Private' as any
      );

      // Largest slot, so the resulting kernel error names the real shortfall.
      expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
    });

    it('ignores slots belonging to a different faucet', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset('accountId-0xother', 900n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Private' as any
      );

      expect(FungibleAsset.fromVaultKey).not.toHaveBeenCalled();
      expect(FungibleAsset).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }), 100n);
    });

    it('constructs the asset directly when the sender account is unavailable', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      buildSendTransactionRequest(undefined, sender, recipient, FAUCET_REF, 100n, 'Private' as any);

      expect(FungibleAsset.fromVaultKey).not.toHaveBeenCalled();
      expect(FungibleAsset).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }), 100n);
      // The fallback reinstates the default Disabled flag, so it must be visible.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sender account unavailable'));
      warn.mockRestore();
    });

    it('builds a plain P2ID when no reclaim height is given', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Public' as any
      );

      expect(Note.createP2IDNote).toHaveBeenCalled();
      expect(Note.createP2IDENote).not.toHaveBeenCalled();
    });

    it('builds a P2IDE carrying the reclaim height when one is given', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Public' as any,
        230
      );

      expect(Note.createP2IDNote).not.toHaveBeenCalled();
      // (sender, target, assets, reclaimHeight, timelockHeight, noteType, attachment)
      expect(Note.createP2IDENote).toHaveBeenCalledWith(
        sender,
        recipient,
        expect.anything(),
        230,
        null,
        'Public',
        expect.anything()
      );
    });

    // Reclaim height 0 is a real height, not "no reclaim" — `!= null`, not falsy.
    it('treats a zero reclaim height as a P2IDE', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Public' as any,
        0
      );

      expect(Note.createP2IDENote).toHaveBeenCalledWith(
        sender,
        recipient,
        expect.anything(),
        0,
        null,
        'Public',
        expect.anything()
      );
      expect(Note.createP2IDNote).not.toHaveBeenCalled();
    });

    // wasm-bindgen truncates a BigInt to u64 before the SDK's own amount
    // validation runs, so 2^64 would arrive as 0 and 2^64 + 50 as 50 — building
    // a note for a fraction of the approved amount instead of failing. The
    // amount reaches here straight from `BigInt(amount)` on a dApp string.
    it.each([1n << 64n, (1n << 64n) + 50n, -1n])(
      'rejects the out-of-range amount %p rather than wrapping it',
      amount => {
        expect(() =>
          buildSendTransactionRequest(
            accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
            sender,
            recipient,
            FAUCET_REF,
            amount,
            'Public' as any
          )
        ).toThrow('outside the representable range');
        expect(Note.createP2IDNote).not.toHaveBeenCalled();
      }
    );

    it('allows the largest representable amount', () => {
      expect(() =>
        buildSendTransactionRequest(
          accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
          sender,
          recipient,
          FAUCET_REF,
          (1n << 64n) - 1n,
          'Public' as any
        )
      ).not.toThrow();
    });
  });
});
