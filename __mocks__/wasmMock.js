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
  // #784: the guardian leaf decodes a proposal's base64 chain anchor before
  // pinning executeRequest to it. Present here so a suite that gives a proposal
  // a `chainAnchor` gets a legible mock assertion instead of "Cannot read
  // properties of undefined (reading 'deserialize')". Suites that assert on the
  // decode override this with their own spy.
  ChainAnchor: {
    deserialize: jest.fn(bytes => ({ __anchorFromBytes: Array.from(bytes), free: jest.fn() }))
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
    // Written by miden-client's apply_transaction: our own consuming tx was
    // submitted and applied locally, block not committed yet.
    ProcessingAuthenticated: 'ProcessingAuthenticated',
    ProcessingUnauthenticated: 'ProcessingUnauthenticated',
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
  // AssetCallbackFlag enum — the flag `buildSendTransactionRequest` derives from
  // a vault key, and that `lib/agglayer/b2agg` sets explicitly.
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
