module.exports = {
  Address: {
    from_string: jest.fn()
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
  // Other SDK types
  FungibleAsset: jest.fn(),
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
