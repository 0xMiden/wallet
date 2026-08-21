import { AccountId, Address, FungibleAsset, Note } from '@miden-sdk/miden-sdk/lazy';

import {
  accountIdStringToSdk,
  accountRefToSdk,
  buildPswapCreateRequest,
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
    createP2IDENote: jest.fn((...args: any[]) => ({ kind: 'p2ide', args })),
    withAttachments: jest.fn((assets: any, metadata: any, recipient: any, attachments: any) => ({
      kind: 'rebuilt',
      assets,
      metadata,
      recipient,
      attachments
    }))
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

    // `AccountId.fromHex` throws on an uppercase '0X', so a reference that is
    // otherwise perfectly valid would fail to canonicalize and fall back to its
    // raw text — a different account, as far as every comparison downstream is
    // concerned. Only the prefix is lowercased; the digits are left alone.
    it('accepts an uppercase 0X prefix, which the SDK parser rejects', () => {
      accountRefToSdk('0XABCDEF');
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
    /** The SDK's documented maximum fungible asset amount. */
    const MAX_AMOUNT = (1n << 63n) - (1n << 31n);

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

    // The discriminating case: the slot that can fund is NOT the largest. Both
    // slots cover 50, so what the preference actually decides is which CALLBACK
    // FLAG the outgoing asset carries — pick by size instead and the note is
    // built against the wrong vault slot.
    it('prefers the funding slot even when a larger slot exists', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 60n, 'enabled'), vaultAsset(FAUCET_HEX, 500n, 'disabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        50n,
        'Private' as any
      );

      expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 50n);
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

    // Same fallback, slots in DESCENDING order, so the reduce has to keep its
    // running best rather than take the last one it sees.
    it('falls back to the largest slot regardless of vault order', () => {
      buildSendTransactionRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 60n, 'enabled'), vaultAsset(FAUCET_HEX, 10n, 'disabled')) as any,
        sender,
        recipient,
        FAUCET_REF,
        100n,
        'Private' as any
      );

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

    // The SDK's documented ceiling is 2^63 - 2^31, which it enforces itself —
    // but it cannot catch a value at or above 2^64, because wasm-bindgen
    // truncates the BigInt at the boundary BEFORE validation runs: 2^64 arrives
    // as 0 and 2^64 + 50 as 50, building a note for a fraction of the approved
    // amount without error. The amount comes straight from `BigInt(amount)` on
    // a dApp-supplied string. (The mock accepts anything, so only the wallet's
    // own bound is under test here.)
    it.each([MAX_AMOUNT + 1n, 1n << 63n, 1n << 64n, (1n << 64n) + 50n, -1n])(
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

    it('allows the largest amount the SDK accepts', () => {
      expect(() =>
        buildSendTransactionRequest(
          accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
          sender,
          recipient,
          FAUCET_REF,
          MAX_AMOUNT,
          'Public' as any
        )
      ).not.toThrow();
    });
  });

  /**
   * The PSWAP API takes a faucet id and an amount rather than an asset, and the
   * Rust side builds the offered asset with the constructor that always yields
   * the Disabled callback flag — so unlike the send paths there is no argument
   * to pass better, and offering a callback-ENABLED asset addressed an empty
   * vault slot and was rejected by the kernel.
   *
   * `buildPswapCreateRequest` re-emits the note the SDK built with only its
   * assets replaced. That the rest is carried over verbatim is what makes it a
   * substitution: verified against the real SDK, rebuilding with the same asset
   * reproduces the note id exactly.
   */
  describe('buildPswapCreateRequest', () => {
    const FAUCET_REF = '0xfaucet';
    const FAUCET_HEX = 'accountId-0xfaucet';
    const MAX_AMOUNT = (1n << 63n) - (1n << 31n);

    /** A PSWAP-create request as `newPswapCreateTransactionRequest` returns it. */
    const referenceRequest = (note: unknown) => ({ expectedOutputOwnNotes: () => [note] }) as any;

    const referenceNote = () => ({
      metadata: () => 'sdk-metadata',
      recipient: () => 'sdk-recipient',
      attachments: () => ['sdk-attachment']
    });

    const rebuilt = () => (Note.withAttachments as jest.Mock).mock.calls[0]!;

    it('offers the asset from the slot the creator actually holds, flag included', () => {
      buildPswapCreateRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        referenceRequest(referenceNote()),
        FAUCET_REF,
        100n
      );

      expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
      expect(FungibleAsset).not.toHaveBeenCalled();
      expect(rebuilt()[0].assets).toEqual([
        { kind: 'vault-key-asset', key: `vaultKey-${FAUCET_HEX}-enabled`, amount: 100n }
      ]);
    });

    // Everything that identifies the swap. The serial number lives in the
    // recipient, and it IS the order id, so carrying these over unchanged is what
    // keeps lineage lookup, cancel-by-order and settlement matching working.
    it('carries the SDK note\u2019s metadata, recipient and attachments over untouched', () => {
      buildPswapCreateRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        referenceRequest(referenceNote()),
        FAUCET_REF,
        100n
      );

      const [, metadata, recipient, attachments] = rebuilt();
      expect(metadata).toBe('sdk-metadata');
      expect(recipient).toBe('sdk-recipient');
      expect(attachments).toEqual(['sdk-attachment']);
    });

    // A faucet issuing callback-enabled assets occupies a separate slot per
    // variant, so picking by vault order could offer from a slot too small to
    // cover the amount and be rejected for insufficient funds while the other
    // slot covered it.
    it('prefers the slot that can fund the offer when the faucet occupies two', () => {
      buildPswapCreateRequest(
        accountHolding(vaultAsset(FAUCET_HEX, 10n, 'disabled'), vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
        referenceRequest(referenceNote()),
        FAUCET_REF,
        100n
      );

      expect(FungibleAsset.fromVaultKey).toHaveBeenCalledWith(`vaultKey-${FAUCET_HEX}-enabled`, 100n);
    });

    it('still builds a request when the vault shows nothing from that faucet', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation();

      try {
        const request = buildPswapCreateRequest(
          accountHolding(vaultAsset('accountId-0xother', 500n, 'enabled')) as any,
          referenceRequest(referenceNote()),
          FAUCET_REF,
          100n
        );

        expect(request).toBeDefined();
        expect(FungibleAsset).toHaveBeenCalledWith({ toString: expect.any(Function) }, 100n);
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects an amount outside the representable range', () => {
      expect(() =>
        buildPswapCreateRequest(
          accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
          referenceRequest(referenceNote()),
          FAUCET_REF,
          MAX_AMOUNT + 1n
        )
      ).toThrow('outside the representable range');
      expect(Note.withAttachments).not.toHaveBeenCalled();
    });

    // Rather than indexing into nothing and reporting a property access on
    // undefined from somewhere deeper.
    it('names the cause when the reference request carries no own output note', () => {
      expect(() =>
        buildPswapCreateRequest(
          accountHolding(vaultAsset(FAUCET_HEX, 500n, 'enabled')) as any,
          referenceRequest(undefined),
          FAUCET_REF,
          100n
        )
      ).toThrow('carried no own output note');
    });
  });
});
