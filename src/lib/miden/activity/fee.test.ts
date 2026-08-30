import {
  TX_FEE_NOTE_TAG,
  feeFieldsFromResult,
  feePaidFromResult,
  feeTextFromTransaction,
  partitionFeeNote,
  splitExecutedOutputNotes
} from './fee';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

// The fee note is corroborated against the chain's NATIVE faucet, so the suite has to
// say what that is. `bech32-native` is what the helper mock below encodes 'native' to.
let mockNativeAssetId: string | null = 'bech32-native';
let mockVerificationBaseFee: number | null = 10000;
/** A chain that charges, which is the precondition for a fee note existing at all. */
const CHARGING = 10000;
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockNativeAssetId,
  // A fee note only EXISTS on a chain that charges, so the split reads the base fee too.
  getVerificationBaseFeeSync: () => mockVerificationBaseFee
}));

jest.mock('lib/shared/format', () => ({
  // Formatting is another module's concern; this suite pins whether a fee yields
  // text at all, not how the number is rendered.
  formatAmount: (amount: bigint, decimals: number) => (Number(amount) / 10 ** decimals).toString()
}));

// The recorded faucet id must be BECH32, like every other faucet id the wallet
// stores: `assetsMetadata` is keyed by bech32 and the receipt resolves the fee token
// by string equality, so a raw/hex id resolved to the unknown-token placeholder and
// suppressed the fee line entirely. The prefix makes the encoding visible in the
// assertions below -- an id that arrived unencoded would not carry it.
jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: unknown) => `bech32-${String(id)}`
}));

const asset = (amount: bigint, faucet: string) => ({
  amount: () => amount.toString(),
  faucetId: () => faucet
});

const outputNote = (tag: number, assets: ReturnType<typeof asset>[]) => ({
  metadata: () => ({ tag: () => ({ asU32: () => tag }) }),
  assets: () => ({ fungibleAssets: () => assets })
});

const result = (notes: ReturnType<typeof outputNote>[]) =>
  ({
    executedTransaction: () => ({ outputNotes: () => ({ notes: () => notes }) })
  }) as any;

describe('feePaidFromResult', () => {
  it('reads the fee from the TX_FEE output note', () => {
    const fee = feePaidFromResult(
      result([outputNote(0x0, [asset(500n, 'tkn-faucet')]), outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])])
    );
    expect(fee).toEqual({ amount: 163840n, faucetId: 'bech32-native' });
  });

  it('returns undefined when the transaction created no fee note', () => {
    // A zero-fee chain creates none at all, so absence is normal, not an error.
    expect(feePaidFromResult(result([outputNote(0x0, [asset(500n, 'tkn-faucet')])]))).toBeUndefined();
  });

  it('survives a note whose metadata is unavailable', () => {
    // Reading the fee must never break the caller that is recording the row.
    const broken = { metadata: () => undefined, assets: () => ({ fungibleAssets: () => [] }) };
    expect(() => feePaidFromResult(result([broken as any]))).not.toThrow();
  });

  it('propagates an eviction instead of reporting no fee', () => {
    // A missing accessor is absorbed; an EVICTION must not be. Every accessor here
    // borrows from the WASM client's RefCell, so once the mutex has been handed to a
    // successor these reads are touching a client another flow is inside. Swallowed, it
    // returns a plausible "no fee" and lets the caller run its NEXT read on the same
    // evicted client -- the double borrow the poison contract exists to prevent.
    const evicted = {
      metadata: () => {
        throw new WasmClientPoisonedError('watchdog');
      },
      assets: () => ({ fungibleAssets: () => [] })
    };
    expect(() => feePaidFromResult(result([evicted as any]))).toThrow(WasmClientPoisonedError);
  });
});

describe('partitionFeeNote', () => {
  const native = 'bech32-native';

  it('separates the kernel fee note from the notes the user created', () => {
    const user = outputNote(0x0, [asset(500n, 'tkn-faucet')]);
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const { feeNote, userNotes } = partitionFeeNote([user, fee] as any, native, CHARGING);
    expect(feeNote).toBe(fee);
    expect(userNotes).toEqual([user]);
  });

  // Emission order is the KERNEL's business, not ours. Every fixture here put the fee note
  // LAST, which is precisely the assumption the whole bug class rested on: four separate
  // sites indexed [0] and were correct only because the fee note happened not to be there.
  // A fee-note-FIRST case is what fails if someone re-introduces the pattern.
  it('separates the fee note when the kernel emits it FIRST', () => {
    const user = outputNote(0x0, [asset(500n, 'tkn-faucet')]);
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const { feeNote, userNotes } = partitionFeeNote([fee, user] as any, native, CHARGING);
    expect(feeNote).toBe(fee);
    expect(userNotes).toEqual([user]);
    // The pick every caller makes, stated explicitly: index 0 of the SPLIT array is the
    // user's note no matter where the kernel put the fee note.
    expect(userNotes[0]).toBe(user);
  });

  it('splitExecutedOutputNotes yields the user note whichever order the kernel used', () => {
    const user = outputNote(0x0, [asset(500n, 'tkn-faucet')]);
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    for (const order of [
      [user, fee],
      [fee, user]
    ]) {
      const executed = { outputNotes: () => ({ notes: () => order }) };
      const { feeNote, userNotes } = splitExecutedOutputNotes(executed as any);
      expect(feeNote).toBe(fee);
      expect(userNotes).toEqual([user]);
    }
  });

  it('does not mistake an ordinary note for the fee note', () => {
    const user = outputNote(0x0, [asset(1n, 'native')]);
    const { feeNote, userNotes } = partitionFeeNote([user] as any, native, CHARGING);
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([user]);
  });

  it('rejects a fee-tagged note drawn on a NON-native faucet', () => {
    // The tag is a plain u32 anything can set, and a dApp's transaction request reaches
    // the wallet verbatim -- so tag alone would let a website have its own output note
    // recorded as the network fee AND erased from the transaction's amount and note
    // list. A fee is only ever paid in the native asset.
    const spoof = outputNote(TX_FEE_NOTE_TAG, [asset(999n, 'attacker-faucet')]);
    const { feeNote, userNotes } = partitionFeeNote([spoof] as any, native, CHARGING);
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([spoof]);
  });

  it('rejects a fee-tagged note carrying more than one asset', () => {
    const multi = outputNote(TX_FEE_NOTE_TAG, [asset(1n, 'native'), asset(2n, 'other')]);
    expect(partitionFeeNote([multi] as any, native, CHARGING).feeNote).toBeUndefined();
  });

  it('trusts NEITHER note when two candidates appear', () => {
    // The kernel emits one. With two we cannot say which is real, so the fee figure is
    // dropped and both notes stay in the totals -- erring toward showing the user more
    // than they spent rather than hiding a real note of theirs.
    const a = outputNote(TX_FEE_NOTE_TAG, [asset(1n, 'native')]);
    const b = outputNote(TX_FEE_NOTE_TAG, [asset(2n, 'native')]);
    const { feeNote, userNotes } = partitionFeeNote([a, b] as any, native, CHARGING);
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([a, b]);
  });

  it('identifies NOTHING as the fee before the native faucet is discovered', () => {
    // Reversed deliberately. This used to fall back to the tag alone, on the reasoning that
    // the window was a fresh install and nothing in it was attacker-selected. That was wrong
    // once `decode.ts` began calling this for the dApp APPROVAL sheet: the confirm popup is
    // its own JS realm whose sync cache starts empty on every open, the tagged note is
    // supplied by the site asking for approval, and being called the fee REMOVES the note
    // from the sheet's totals. Failing closed costs an inflated amount for one realm-warm;
    // trusting the tag lets a site hide a transfer.
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'anything')]);
    expect(partitionFeeNote([fee] as any, null, 10000).feeNote).toBeUndefined();
  });

  it('identifies NOTHING as the fee on a chain that charges nothing', () => {
    // Structural, not a heuristic: at `verification_base_fee` 0 the kernel emits no fee note,
    // so a note wearing the tag cannot be one. Without this a single native tagged note
    // satisfies every OTHER corroboration on testnet -- no race and no cold cache needed,
    // just a dApp asking a fee-free chain to erase a transfer from the approval sheet.
    const forged = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const split = partitionFeeNote([forged] as any, 'bech32-native', 0);
    expect(split.feeNote).toBeUndefined();
    expect(split.userNotes).toHaveLength(1);
  });

  it('identifies NOTHING as the fee before the base fee is discovered', () => {
    const forged = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    expect(partitionFeeNote([forged] as any, 'bech32-native', null).feeNote).toBeUndefined();
  });
});

describe('feeFieldsFromResult', () => {
  it('produces the transaction-row fields when a fee was paid', () => {
    const fields = feeFieldsFromResult(result([outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])]));
    // Bech32, so `assetsMetadata` (keyed by bech32) can resolve the fee token and the
    // receipt renders a fee line at all.
    expect(fields).toEqual({ feeAmount: 163840n, feeFaucetId: 'bech32-native' });
  });

  it('produces no fields when there is no result at all', () => {
    // Some completion paths finish without a TransactionResult in hand.
    expect(feeFieldsFromResult(undefined)).toEqual({});
  });

  it('produces no fields at all when no fee was paid', () => {
    // Spread into an update object, so it must add nothing rather than write
    // undefined keys over values another writer may have set.
    expect(feeFieldsFromResult(result([outputNote(0x0, [asset(1n, 'tkn')])]))).toEqual({});
  });
});

describe('feeTextFromTransaction', () => {
  it('formats the recorded fee for display', () => {
    expect(feeTextFromTransaction({ feeAmount: 170000n, feeFaucetId: 'native' } as any, 6, 'MIDEN')).toBe('0.17 MIDEN');
  });

  it('renders nothing for a row that recorded no fee', () => {
    // Rows written before fees existed, and every row on a zero-fee chain.
    expect(feeTextFromTransaction({} as any, 6, 'MIDEN')).toBeUndefined();
  });
});
