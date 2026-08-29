import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { CustomProposalFeeAuthError, ensureCustomProposalFeeAuth } from './guardian-fee-auth';

/**
 * A request is modelled as JSON so that serialization is deterministic and the
 * round-trip PROOF in `ensureCustomProposalFeeAuth` is actually exercised: a
 * request whose only content is own output notes re-emits byte-identically,
 * while one carrying anything else (`inputNotes` here, standing in for the input
 * notes and custom scripts a dApp request can hold and the SDK's readers cannot
 * see) does not — which is the case that must be refused rather than re-emitted.
 */
interface FakeRequest {
  ownNotes: string[];
  authArg?: string;
  inputNotes?: string[];
}

const encode = (request: FakeRequest): Uint8Array =>
  Uint8Array.from(JSON.stringify(request), character => character.charCodeAt(0));

const decode = (bytes: Uint8Array): FakeRequest => JSON.parse(String.fromCharCode(...Array.from(bytes))) as FakeRequest;

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteArray: jest.fn(function (this: any, notes: any) {
    this.notes = notes;
  }),
  TransactionRequest: {
    deserialize: jest.fn((bytes: Uint8Array) => {
      const parsed = JSON.parse(String.fromCharCode(...Array.from(bytes)));
      return {
        authArg: () => parsed.authArg,
        expectedOutputOwnNotes: () => parsed.ownNotes,
        // Deliberately unreadable from the request, exactly as in the SDK: the
        // rebuild cannot carry it forward, which is what the byte comparison
        // exists to catch.
        serialize: () => bytes
      };
    })
  },
  TransactionRequestBuilder: jest.fn(function (this: any) {
    const state: { ownNotes: string[]; authArg?: string } = { ownNotes: [] };
    this.withOwnOutputNotes = (noteArray: any) => {
      state.ownNotes = noteArray.notes;
      return this;
    };
    this.withAuthArg = (authArg: any) => {
      state.authArg = authArg;
      return this;
    };
    this.extendAdviceMap = () => this;
    this.build = () => ({
      serialize: () =>
        encode(
          state.authArg === undefined
            ? { ownNotes: state.ownNotes }
            : { ownNotes: state.ownNotes, authArg: state.authArg }
        )
    });
  })
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  resolveAuthArg: jest.fn(() => ({ authArg: 'commitment', adviceMap: { preimage: true } }))
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: jest.fn((ref: string) => ref),
  randomFeeSalt: jest.fn(() => 'salt')
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: jest.fn(async (fn: (hold: object) => unknown) => fn({ mock: 'hold' }))
}));

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(),
  getVerificationBaseFee: jest.fn()
}));

const mockBaseFee = getVerificationBaseFee as jest.Mock;
const mockNativeAssetId = getNativeAssetId as jest.Mock;

describe('ensureCustomProposalFeeAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNativeAssetId.mockResolvedValue('mtst1feefaucet');
  });

  it('commits fee conversion info into a pre-built request, preserving its notes', async () => {
    // The P0 this exists for: `buildEpochCollateralRequestBytes`,
    // `initiateB2AggBridge` and `buildPswapCreateRequest` all emit a bare
    // own-output-note request at QUEUE time, and `createCustomProposal` injects
    // nothing — so on a fee-charging chain the kernel aborted at
    // `creating-proposal` with ERR_FEE_CONVERSION_INFO_MISSING.
    mockBaseFee.mockResolvedValue(10000);
    const original = encode({ ownNotes: ['collateral-note'] });

    const annotated = await ensureCustomProposalFeeAuth(original);

    expect(decode(annotated).authArg).toBe('commitment');
    // The note must survive verbatim: its serial number IS the note id (and, for
    // a swap, the order id), so re-emitting a different one would register a
    // second, divergent order.
    expect(decode(annotated).ownNotes).toEqual(['collateral-note']);
  });

  it('leaves a zero-fee chain byte-for-byte untouched', async () => {
    // A MISSING commitment only aborts when there is a non-zero fee to pay, so
    // there is nothing to fix here — and every guardian CI workflow pins
    // `verification-base-fee: '0'`, which is the entire reason this class of
    // failure went unnoticed. Not rebuilding keeps those runs unaffected.
    mockBaseFee.mockResolvedValue(0);
    const original = encode({ ownNotes: ['note'] });

    expect(await ensureCustomProposalFeeAuth(original)).toBe(original);
  });

  it('fails open when the fee has not been discovered', async () => {
    // Same policy as `isWorthClaiming`: refusing a transaction over a failed RPC
    // read is worse than letting the kernel answer.
    mockBaseFee.mockResolvedValue(null);
    const original = encode({ ownNotes: ['note'] });

    expect(await ensureCustomProposalFeeAuth(original)).toBe(original);
  });

  it('does not re-emit a request that already carries an auth arg', async () => {
    // The recallable-send build path sets one, and a retry re-reads its own
    // persisted bytes. Re-emitting would draw a FRESH salt, and the auth arg
    // doubles as the transaction summary salt — so it would invalidate every
    // signature already gathered against this proposal.
    mockBaseFee.mockResolvedValue(10000);
    const original = encode({ ownNotes: ['note'], authArg: 'existing-commitment' });

    expect(await ensureCustomProposalFeeAuth(original)).toBe(original);
  });

  it('refuses a request whose content it cannot prove it preserved', async () => {
    // `TransactionRequest` has no `withAuthArg` and a builder cannot be seeded
    // from a request, so annotating means re-emitting through a builder — and the
    // request's readers do not cover input notes or a custom script. A dApp
    // request carrying either must fail loudly rather than be silently re-emitted
    // as something the user did not approve.
    mockBaseFee.mockResolvedValue(10000);
    const original = encode({ ownNotes: ['note'], inputNotes: ['consumed-note'] });

    await expect(ensureCustomProposalFeeAuth(original)).rejects.toThrow(CustomProposalFeeAuthError);
  });
});
