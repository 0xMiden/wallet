/**
 * `ensureFeeAuthOnRequestBytes` — the annotation that lets a pre-built request pay the fee.
 *
 * WHY THIS FILE EXISTS, AND WHAT ITS FAKE MAY AND MAY NOT CLAIM.
 *
 * The previous attempt at this feature shipped with a test suite that could not fail for
 * either of the two P0s that killed it, because its SDK fake modelled `serialize()` as
 * canonical and idempotent — a property the real SDK does NOT have. The rule that came out
 * of that: when a module's correctness rests on a property of a native dependency, the
 * property must be PROBED against the real dependency, not modelled.
 *
 * So the division of labour here is deliberate:
 *
 *   - The SDK's own behaviour was probed against the shipped wasm, not asserted here. Those
 *     measurements: `withAuthArg` round-trips through serialize/deserialize; it consumes
 *     neither its receiver nor its `Word` argument; `extendAdviceMap` preserves the auth arg;
 *     the advice preimage survives serialization; the annotation adds 32 bytes and preserves
 *     scriptArg, input notes and own output notes; `authArg()` is `undefined` (not a zero
 *     word) on a request built without one; and `Word.toHex()` is `0x` + 64 lowercase hex
 *     digits, so `/^0x0*$/` identifies the empty word exactly.
 *   - THIS file asserts only the module's own decisions — which branch it takes, what it
 *     passes through, what it persists — over a fake that is honest about being one. The
 *     fake below carries a mutable record and does NOT pretend that serialization is
 *     canonical: `serialize()` returns a fresh array every time, so no assertion here can
 *     accidentally depend on byte stability the real SDK does not offer.
 */
import { resolveAuthArg } from '@openzeppelin/miden-multisig-client';

import { ensureFeeAuthOnRequestBytes } from './guardian-fee-auth';
import { getNativeAssetId, getVerificationBaseFee } from '../../miden-chain/native-asset';

/** What a faked request carries. Serialized as JSON so the codec is real, if not the SDK's. */
interface FakeRequest {
  authArg?: string;
  adviceMap?: string;
  payload: string;
}

const encode = (r: FakeRequest): Uint8Array => new TextEncoder().encode(JSON.stringify(r));
const decode = (b: Uint8Array): FakeRequest => JSON.parse(new TextDecoder().decode(b));

const ZERO_WORD = `0x${'0'.repeat(64)}`;

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: {
    deserialize: jest.fn((bytes: Uint8Array) => {
      // Real `deserialize` THROWS on bytes it cannot read; so does this.
      const record: FakeRequest = decode(bytes);
      const build = (r: FakeRequest) => ({
        authArg: () => (r.authArg === undefined ? undefined : { toHex: () => r.authArg }),
        withAuthArg: (word: { toHex: () => string }) => build({ ...r, authArg: word.toHex() }),
        extendAdviceMap: (map: { id: string }) => build({ ...r, adviceMap: map.id }),
        // A FRESH array each call, deliberately: the real serializer is not canonical, and
        // nothing in this suite may lean on identity or byte stability across instances.
        serialize: () => encode(r)
      });
      return build(record);
    })
  }
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  resolveAuthArg: jest.fn(() => ({
    authArg: { toHex: () => '0xc0mm1tment' },
    adviceMap: { id: 'preimage' }
  }))
}));

jest.mock('../../miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(async () => 'mtst1nativefaucet'),
  getVerificationBaseFee: jest.fn(async () => 10000)
}));

jest.mock('../sdk/helpers', () => ({
  accountRefToSdk: jest.fn((id: string) => id),
  randomFeeSalt: jest.fn(() => 'SALT')
}));

const mockedFee = getVerificationBaseFee as jest.MockedFunction<typeof getVerificationBaseFee>;
const mockedFaucet = getNativeAssetId as jest.MockedFunction<typeof getNativeAssetId>;
const mockedResolve = resolveAuthArg as unknown as jest.Mock;

const plain = () => encode({ payload: 'the-request' });

beforeEach(() => {
  jest.clearAllMocks();
  mockedFee.mockResolvedValue(10000);
  mockedFaucet.mockResolvedValue('mtst1nativefaucet');
  mockedResolve.mockReturnValue({ authArg: { toHex: () => '0xc0mm1tment' }, adviceMap: { id: 'preimage' } });
});

describe('ensureFeeAuthOnRequestBytes', () => {
  it('attaches the commitment AND its advice preimage to an unannotated request', async () => {
    const out = await ensureFeeAuthOnRequestBytes(plain());
    // Both halves asserted: a commitment whose preimage never reached the advice map is
    // unopenable at execution time, which fails exactly as if nothing had been attached.
    expect(decode(out)).toEqual({ payload: 'the-request', authArg: '0xc0mm1tment', adviceMap: 'preimage' });
  });

  it('returns bytes that DIFFER from the input, so a caller can tell it annotated', async () => {
    // Every call site decides whether to persist by comparing against the input. If this
    // helper ever returned the input unchanged on the success path, all six would silently
    // stop persisting and the proposal would be built from unannotated bytes.
    const input = plain();
    const out = await ensureFeeAuthOnRequestBytes(input);
    expect(out).not.toBe(input);
    expect(decode(out).authArg).toBe('0xc0mm1tment');
  });

  it('leaves a request that already commits an auth arg untouched', async () => {
    const input = encode({ payload: 'p', authArg: '0xdeadbeef' });
    const out = await ensureFeeAuthOnRequestBytes(input);
    expect(out).toBe(input);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('treats an EMPTY auth arg as uncommitted and annotates it', async () => {
    // The zero word is what a builder handed no auth arg can still serialize. Testing only
    // for `undefined` skipped exactly the requests that needed annotating — that is why the
    // guardian swap kept aborting after the helper was supposedly applied to it.
    const out = await ensureFeeAuthOnRequestBytes(encode({ payload: 'p', authArg: ZERO_WORD }));
    expect(decode(out).authArg).toBe('0xc0mm1tment');
  });

  it('leaves a zero-fee chain byte-for-byte alone', async () => {
    mockedFee.mockResolvedValue(0);
    const input = plain();
    await expect(ensureFeeAuthOnRequestBytes(input)).resolves.toBe(input);
    expect(mockedFaucet).not.toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('still annotates when the fee is not yet discovered, rather than assuming zero', async () => {
    // `null` is "not known yet", which must not collapse into "charges nothing" — that would
    // silently disarm the annotation on a charging chain.
    mockedFee.mockResolvedValue(null);
    expect(decode(await ensureFeeAuthOnRequestBytes(plain())).authArg).toBe('0xc0mm1tment');
  });

  it('passes the bytes through when the chain read fails, instead of failing the transaction', async () => {
    // A transient RPC blip must not take down a dApp `execute` that reached the chain with no
    // header read at all before this helper was inserted into its path.
    mockedFee.mockRejectedValue(new Error('rpc unreachable'));
    const input = plain();
    await expect(ensureFeeAuthOnRequestBytes(input)).resolves.toBe(input);
  });

  it('passes the bytes through when the faucet read fails', async () => {
    mockedFaucet.mockRejectedValue(new Error('rpc unreachable'));
    const input = plain();
    await expect(ensureFeeAuthOnRequestBytes(input)).resolves.toBe(input);
  });

  it('passes undeserializable bytes through unchanged', async () => {
    const input = new Uint8Array([0xff, 0xfe, 0xfd]);
    await expect(ensureFeeAuthOnRequestBytes(input)).resolves.toBe(input);
  });

  it('is idempotent: annotating its own output is a no-op', async () => {
    // The call sites re-run this on every generation attempt, so a second pass must not
    // replace a live commitment with a fresh one — the salt is already baked into the
    // proposal the guardian holds.
    const once = await ensureFeeAuthOnRequestBytes(plain());
    const twice = await ensureFeeAuthOnRequestBytes(once);
    expect(twice).toBe(once);
  });
});
