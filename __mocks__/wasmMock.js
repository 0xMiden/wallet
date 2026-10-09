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
  // The lazy entry's WASM loader. Static classes above are usable only after it
  // resolves in production; the mock has no module to load, so it resolves empty.
  getWasmOrThrow: jest.fn(async () => ({})),
  SigningInputs: jest.fn(),
  Word: Object.assign(jest.fn(), { fromHex: jest.fn(hex => ({ toHex: () => hex, toFelts: () => [] })) }),
  AccountInterface: jest.fn(),
  // Advice-map primitives used by the direct guardian-switch fallback.
  // `hashElements` derives its result from the elements it was given rather than
  // returning a constant: the advice map is keyed by Poseidon2(signerCommitment
  // ‖ txCommitment), so a constant makes the hot and cold entries collide on one
  // key — the exact defect the direct-switch guard exists to catch — and any
  // suite reaching this stub would pass regardless.
  AdviceMap: jest.fn(() => ({ insert: jest.fn() })),
  Felt: jest.fn(),
  FeltArray: jest.fn(elements => ({ elements: elements ?? [] })),
  Poseidon2: {
    hashElements: jest.fn(feltArray => {
      const elements = feltArray?.elements ?? [];
      return { toHex: () => `0x${elements.join('|')}` };
    })
  },
  Signature: { deserialize: jest.fn(bytes => ({ toPreparedSignature: jest.fn(() => [...(bytes ?? [])]) })) }
};
