module.exports = {
  Address: {
    from_string: jest.fn(),
    // Loose stand-in for the SDK's strict bech32 decode: known HRP, bech32
    // charset payload (optionally with a `_…` routing-parameters suffix),
    // plausible length. Tests override per-case when they need specific
    // decode outcomes.
    fromBech32: jest.fn(address => {
      const wellFormed = /^(mm|mtst|mdev|mlcl)1[02-9ac-hj-np-z]+(_[02-9ac-hj-np-z]+)?$/.test(address);
      if (!wellFormed || address.length < 30 || address.length > 100) {
        throw new Error(`invalid bech32 address: ${address}`);
      }
      return {
        accountId: jest.fn(),
        interface: jest.fn(() => 'BasicWallet'),
        toNoteTag: jest.fn()
      };
    })
  },
  Program: {
    fromString: jest.fn()
  },
  RecordPlaintext: {
    fromString: jest.fn()
  },
  // InputNoteState enum values used in transactions.ts
  InputNoteState: {
    ConsumedAuthenticatedLocal: 'ConsumedAuthenticatedLocal',
    ConsumedUnauthenticatedLocal: 'ConsumedUnauthenticatedLocal',
    ConsumedExternal: 'ConsumedExternal',
    Invalid: 'Invalid',
    Committed: 'Committed',
    Expected: 'Expected',
    Unverified: 'Unverified'
  },
  // NoteType enum used in helpers.ts
  NoteType: {
    Private: 'Private',
    Public: 'Public'
  },
  // NoteFilterTypes used in adapter and dapp
  NoteFilterTypes: {
    All: 'All',
    Consumed: 'Consumed',
    Committed: 'Committed',
    Expected: 'Expected',
    Processing: 'Processing'
  },
  // AssetCallbackFlag enum used by resolveHeldFungibleAsset callers
  AssetCallbackFlag: {
    Disabled: 0,
    Enabled: 1
  },
  // Other SDK types
  FungibleAsset: jest.fn(),
  NoteAssets: jest.fn(),
  NoteAttachment: jest.fn(),
  NoteArray: jest.fn(),
  TransactionRequestBuilder: jest.fn(),
  BasicFungibleFaucetComponent: jest.fn(),
  TransactionResult: jest.fn(),
  AccountId: jest.fn(),
  NetworkId: {
    custom: jest.fn(prefix => prefix),
    devnet: jest.fn(() => 'devnet'),
    mainnet: jest.fn(() => 'mainnet'),
    testnet: jest.fn(() => 'testnet')
  },
  NoteFilter: jest.fn(),
  NoteId: jest.fn(),
  Note: jest.fn(),
  AuthSecretKey: jest.fn(),
  SigningInputs: jest.fn(),
  Word: jest.fn(),
  AccountInterface: jest.fn()
};
