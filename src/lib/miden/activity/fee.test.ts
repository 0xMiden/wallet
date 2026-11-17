import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';

import {
  TX_FEE_NOTE_TAG,
  feeFieldsFromResult,
  feePaidFromResult,
  feeTextFromTransaction,
  partitionFeeNote,
  splitExecutedOutputNotes
} from './fee';
import { splitLandedOutputNotes } from './fee-notes';
import { FEE_RESERVE_MULTIPLE } from '../fees/spendable';
import { canonicalFeeSponsorshipNoteId } from '../sdk/fee-sponsorship';
import { installLandedTrapRetirement } from '../sdk/landed-trap-retirement';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

// The fee note is corroborated against the chain's NATIVE faucet, so the suite has to
// say what that is. `bech32-native` is what the helper mock below encodes 'native' to.
let mockNativeAssetId: string | null = 'bech32-native';
let mockVerificationBaseFee: number | null = 10000;
/** A chain that charges, which is the precondition for a fee note existing at all. */
const CHARGING = 10000;
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => mockNativeAssetId,
  getSdkSyncedNativeAssetIdSync: () => mockNativeAssetId,
  cacheScope: () => 'rpc-a|testnet',
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
  getBech32AddressFromAccountId: (id: unknown) => `bech32-${String(id)}`,
  canonicalWalletAccountId: (id: string) => id
}));
jest.mock('../sdk/fee-sponsorship', () => ({ canonicalFeeSponsorshipNoteId: jest.fn(() => 'sponsor') }));

const asset = (amount: bigint, faucet: string) => ({
  amount: () => amount.toString(),
  faucetId: () => faucet
});

const outputNote = (tag: number, assets: ReturnType<typeof asset>[], nfts: unknown[] = []) => ({
  metadata: () => ({ tag: () => ({ asU32: () => tag }) }),
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => nfts })
});

const result = (notes: ReturnType<typeof outputNote>[]) =>
  ({
    executedTransaction: () => ({ outputNotes: () => ({ notes: () => notes }) })
  }) as any;

// The leaf's state is module scope and shared by every test in this file, so each read names its own landing.
describe('feePaidFromResult', () => {
  let retire: jest.Mock;
  let restore: () => void;
  beforeEach(() => {
    retire = jest.fn();
    restore = installLandedTrapRetirement(retire);
  });
  afterEach(() => restore());

  it('reads the fee from the TX_FEE output note', () => {
    const fee = feePaidFromResult(
      result([outputNote(0x0, [asset(500n, 'tkn-faucet')]), outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])]),
      'fee-read'
    );
    expect(fee).toEqual({ amount: 163840n, faucetId: 'bech32-native' });
  });

  it('returns undefined when the transaction created no fee note', () => {
    // A zero-fee chain creates none at all, so absence is normal, not an error.
    expect(feePaidFromResult(result([outputNote(0x0, [asset(500n, 'tkn-faucet')])]), 'fee-none')).toBeUndefined();
  });

  it('survives a note whose metadata is unavailable', () => {
    // Reading the fee must never break the caller that is recording the row.
    const broken = { metadata: () => undefined, assets: () => ({ fungibleAssets: () => [] }) };
    expect(() => feePaidFromResult(result([broken as any]), 'fee-broken')).not.toThrow();
    expect(retire).not.toHaveBeenCalled();
  });

  it('reads the fee past a note whose tag read traps, since it runs past submit', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unreadable = {
      metadata: () => {
        throw trap;
      },
      assets: () => ({ fungibleAssets: () => [asset(500n, 'tkn-faucet')], nonFungibleAssets: () => [] })
    };
    expect(
      feePaidFromResult(
        result([unreadable as any, outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])]),
        'fee-past-tag'
      )
    ).toEqual({ amount: 163840n, faucetId: 'bech32-native' });
    warn.mockRestore();
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
    expect(() => feePaidFromResult(result([evicted as any]), 'fee-evicted')).toThrow(WasmClientPoisonedError);
    expect(retire).not.toHaveBeenCalled();
  });

  it('feePaidFromResult answers a trap in a fee check with no fee and retires under its row', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const read = landed(
      executed([fee], () => {
        throw trap;
      })
    );
    expect(feePaidFromResult(read, 'fee-paid')).toBeUndefined();
    expect(retire.mock.calls).toEqual([[trap, 'fee-paid']]);
  });

  it('feePaidFromResult answers a trap in a read after the split with no fee and retires under its row', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    let amountReads = 0;
    // The split's ceiling check reads the amount once, so only the fee figure's own read traps.
    const fee = {
      metadata: () => ({ tag: () => ({ asU32: () => TX_FEE_NOTE_TAG }) }),
      assets: () => ({
        fungibleAssets: () => [
          {
            amount: () => {
              amountReads += 1;
              if (amountReads > 1) throw trap;
              return '163840';
            },
            faucetId: () => 'native'
          }
        ],
        nonFungibleAssets: () => []
      })
    };
    expect(feePaidFromResult(result([fee as any]), 'fee-after-split')).toBeUndefined();
    expect(retire.mock.calls).toEqual([[trap, 'fee-after-split']]);
  });

  it('feeFieldsFromResult retires under the row it records', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const read = landed(
      executed([fee], () => {
        throw trap;
      })
    );
    expect(feeFieldsFromResult(read, 'fee-fields')).toEqual({});
    expect(retire.mock.calls).toEqual([[trap, 'fee-fields']]);
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

  it('rejects a fee-tagged note that also carries an NFT, so the NFT stays on the approval sheet', () => {
    // The fee note is removed from the sheet's totals and note count. A site could otherwise add a
    // fee-tagged note holding one native unit plus the user's NFT and have the NFT erased with it.
    const spoof = outputNote(TX_FEE_NOTE_TAG, [asset(1n, 'native')], [{}]);
    const { feeNote, userNotes } = partitionFeeNote([spoof] as any, native, CHARGING);
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([spoof]);
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

  // Omitting the argument keeps the kernel ceiling; the own-block case already pins that.
  it("returns a fee-tagged native note above the kernel ceiling when the ceiling is 'recorded'", () => {
    const over = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 1n, 'native')]);
    const { feeNote } = partitionFeeNote([over] as any, native, CHARGING, 'recorded');
    expect(feeNote).toBe(over);
  });

  it("leaves both fee-tagged native notes above the kernel ceiling as user notes for a 'recorded' split", () => {
    const a = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 1n, 'native')]);
    const b = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 2n, 'native')]);
    const { feeNote, userNotes } = partitionFeeNote([a, b] as any, native, CHARGING, 'recorded');
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([a, b]);
  });

  it("identifies nothing for a 'recorded' split when the base fee is 0", () => {
    const over = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 1n, 'native')]);
    expect(partitionFeeNote([over] as any, native, 0, 'recorded').feeNote).toBeUndefined();
  });

  it("identifies nothing for a 'recorded' split before the native faucet is known", () => {
    const over = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 1n, 'native')]);
    expect(partitionFeeNote([over] as any, null, CHARGING, 'recorded').feeNote).toBeUndefined();
  });
});

describe('feeFieldsFromResult', () => {
  it('produces the transaction-row fields when a fee was paid', () => {
    const fields = feeFieldsFromResult(
      result([outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])]),
      'fields-paid'
    );
    // Bech32, so `assetsMetadata` (keyed by bech32) can resolve the fee token and the
    // receipt renders a fee line at all.
    expect(fields).toEqual({ feeAmount: 163840n, feeFaucetId: 'bech32-native' });
  });

  it('produces no fields when there is no result at all', () => {
    // Some completion paths finish without a TransactionResult in hand.
    expect(feeFieldsFromResult(undefined, 'fields-no-result')).toEqual({});
  });

  it('produces no fields at all when no fee was paid', () => {
    // Spread into an update object, so it must add nothing rather than write
    // undefined keys over values another writer may have set.
    expect(feeFieldsFromResult(result([outputNote(0x0, [asset(1n, 'tkn')])]), 'fields-no-fee')).toEqual({});
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

describe("splitExecutedOutputNotes against the transaction's own block", () => {
  const userNote = outputNote(0x0, [asset(500n, 'tkn-faucet')]);
  // Within the ceiling of a base fee of 2 (60), so each case below is decided by which fee source the split reads.
  const taggedNative = outputNote(TX_FEE_NOTE_TAG, [asset(50n, 'native')]);
  const withHeader = (blockHeader: () => unknown, notes = [userNote, taggedNative]) =>
    ({ outputNotes: () => ({ notes: () => notes }), blockHeader }) as any;
  afterEach(() => {
    mockVerificationBaseFee = CHARGING;
  });
  const headerCharging = (fee: number) => () => ({ verificationBaseFee: () => fee });

  it("takes the fee rate from the transaction's own block: a fee-tagged native note on a free block stays a user note although the cache says 2", () => {
    mockVerificationBaseFee = 2;
    const { feeNote, userNotes } = splitExecutedOutputNotes(withHeader(headerCharging(0)));
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([userNote, taggedNative]);
  });

  it('identifies the fee note on a charging block although the cache says 0', () => {
    mockVerificationBaseFee = 0;
    const { feeNote, userNotes } = splitExecutedOutputNotes(withHeader(headerCharging(2)));
    expect(feeNote).toBe(taggedNative);
    expect(userNotes).toEqual([userNote]);
  });

  it('identifies nothing when the header read throws', () => {
    mockVerificationBaseFee = 2;
    const { feeNote, userNotes } = splitExecutedOutputNotes(
      withHeader(() => {
        throw new Error('no header');
      })
    );
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([userNote, taggedNative]);
  });

  it('lets an eviction from the header read through', () => {
    const eviction = new WasmClientPoisonedError('watchdog');
    expect(() =>
      splitExecutedOutputNotes(
        withHeader(() => {
          throw eviction;
        })
      )
    ).toThrow(eviction);
  });

  // The kernel charges at most the base fee times FEE_RESERVE_MULTIPLE, so a larger tagged note is never the fee.
  it('leaves a fee-tagged native note above the kernel ceiling among the user notes', () => {
    const over = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 1n, 'native')]);
    const { feeNote, userNotes } = splitExecutedOutputNotes(withHeader(headerCharging(CHARGING), [userNote, over]));
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([userNote, over]);
  });

  it('still takes a fee-tagged native note at exactly the kernel ceiling', () => {
    const atCeiling = outputNote(TX_FEE_NOTE_TAG, [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE), 'native')]);
    const { feeNote } = splitExecutedOutputNotes(withHeader(headerCharging(CHARGING), [userNote, atCeiling]));
    expect(feeNote).toBe(atCeiling);
  });

  it("measures the ceiling against the transaction's own block fee", () => {
    const over = outputNote(TX_FEE_NOTE_TAG, [asset(61n, 'native')]);
    const { feeNote } = splitExecutedOutputNotes(withHeader(headerCharging(2), [userNote, over]));
    expect(feeNote).toBeUndefined();
  });

  it('keeps the realm cache for an object without a header', () => {
    mockVerificationBaseFee = 2;
    const { feeNote } = splitExecutedOutputNotes({
      outputNotes: () => ({ notes: () => [userNote, taggedNative] })
    } as any);
    expect(feeNote).toBe(taggedNative);
  });
});

type FeeRead = 'tag' | 'faucet' | 'amount';
const FEE_READS: FeeRead[] = ['tag', 'faucet', 'amount'];

// A fee-tagged native note whose `where` read throws `failure`, so each fee check is reached in turn.
const trapping = (where: FeeRead, failure: unknown) => {
  const fail = () => {
    throw failure;
  };
  return {
    metadata: () => ({ tag: where === 'tag' ? fail : () => ({ asU32: () => TX_FEE_NOTE_TAG }) }),
    assets: () => ({
      fungibleAssets: () => [
        { amount: where === 'amount' ? fail : () => '163840', faucetId: where === 'faucet' ? fail : () => 'native' }
      ],
      nonFungibleAssets: () => []
    })
  };
};

const executed = (notes: unknown[], blockHeader?: () => { verificationBaseFee: () => number }) =>
  ({ outputNotes: () => ({ notes: () => notes }), ...(blockHeader ? { blockHeader } : {}) }) as any;

const landed = (e: unknown) => ({ executedTransaction: () => e }) as any;

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (caught) {
    return caught;
  }
  return undefined;
};

const user = outputNote(0x0, [asset(500n, 'tkn')]);
const poison = new WasmClientPoisonedError('watchdog');

// The lock retires a trapped client only when the trap reaches it, so a fee check must not answer it.
describe('a trap or a kill in a fee check', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');

  it.each(FEE_READS)('splitExecutedOutputNotes rethrows a trap from the %s read as that same object', where => {
    expect(thrownBy(() => splitExecutedOutputNotes(executed([user, trapping(where, trap)])))).toBe(trap);
  });

  it('rethrows a trap from the header read as that same object', () => {
    const header = () => {
      throw trap;
    };
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    expect(thrownBy(() => splitExecutedOutputNotes(executed([user, fee], header)))).toBe(trap);
  });

  it('rethrows the eviction a wrapped tag-read failure carries, as the eviction', () => {
    const wrapped = trapping('tag', new Error('wrapped', { cause: poison }));
    expect(thrownBy(() => splitExecutedOutputNotes(executed([user, wrapped])))).toBe(poison);
  });

  it('still identifies nothing when a fee check fails with an ordinary error', () => {
    const broken = trapping('tag', new TypeError('no accessor'));
    expect(splitExecutedOutputNotes(executed([user, broken]))).toEqual({
      feeNote: undefined,
      userNotes: [user, broken]
    });
  });
});

describe('splitLandedOutputNotes', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  let retire: jest.Mock;
  let restore: () => void;
  beforeEach(() => {
    retire = jest.fn();
    restore = installLandedTrapRetirement(retire);
  });
  afterEach(() => restore());

  it.each(FEE_READS)(
    'identifies no fee note when the %s read traps, keeps every note, and retires under its row',
    where => {
      const trapped = trapping(where, trap);
      expect(splitLandedOutputNotes(landed(executed([user, trapped])), `split-${where}`)).toEqual({
        feeNote: undefined,
        userNotes: [user, trapped],
        verificationFeeKnown: false
      });
      expect(retire).toHaveBeenCalledTimes(1);
      expect(retire).toHaveBeenCalledWith(trap, `split-${where}`);
    }
  );

  it('identifies no fee note when the header read traps', () => {
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const { feeNote, userNotes } = splitLandedOutputNotes(
      landed(
        executed([user, fee], () => {
          throw trap;
        })
      ),
      'split-header'
    );
    expect(feeNote).toBeUndefined();
    expect(userNotes).toEqual([user, fee]);
    expect(retire.mock.calls).toEqual([[trap, 'split-header']]);
  });

  it('retires once per row however many reads of it trap', () => {
    // Every read of a landed result builds its objects again, so each read traps with a new object.
    const fee = outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const freshHeaderTrap = () => {
      throw new WebAssembly.RuntimeError('unreachable');
    };
    splitLandedOutputNotes(landed(executed([user, fee], freshHeaderTrap)), 'split-twice');
    splitLandedOutputNotes(landed(executed([user, fee], freshHeaderTrap)), 'split-twice');
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('separates the fee note as splitExecutedOutputNotes does when nothing traps', () => {
    const same = executed([user, outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')])], () => ({
      verificationBaseFee: () => CHARGING
    }));
    const split = splitLandedOutputNotes(landed(same), 'split-clean');
    expect(split).toEqual({ ...splitExecutedOutputNotes(same), verificationFeeKnown: true });
    expect(split.feeNote).toBeDefined();
    expect(retire).not.toHaveBeenCalled();
  });

  it('lets the eviction a wrapped failure carries through', () => {
    const wrapped = trapping('tag', new Error('wrapped', { cause: poison }));
    expect(thrownBy(() => splitLandedOutputNotes(landed(executed([user, wrapped])), 'split-evicted'))).toBe(poison);
    expect(retire).not.toHaveBeenCalled();
  });

  it('lets a trap from the output-note read itself through', () => {
    const unreadable = {
      outputNotes: () => {
        throw trap;
      }
    };
    expect(thrownBy(() => splitLandedOutputNotes(landed(unreadable), 'split-unreadable'))).toBe(trap);
    expect(retire).not.toHaveBeenCalled();
  });

  it('lets a trap from the executed-transaction read itself through', () => {
    const undecodable = {
      executedTransaction: () => {
        throw trap;
      }
    };
    expect(thrownBy(() => splitLandedOutputNotes(undecodable as any, 'split-undecodable'))).toBe(trap);
    expect(retire).not.toHaveBeenCalled();
  });

  // A trap answers only the check that threw it, so a fee note the other checks identified is still split out (it would
  // otherwise become a caller's first user note: a swap's order note, a private send's relayed note), unless the note
  // that trapped cannot be ruled out as a second candidate, which leaves no note the fee, as two candidates do.
  describe('answers a trap per check', () => {
    const kernelFee = () => outputNote(TX_FEE_NOTE_TAG, [asset(163840n, 'native')]);
    const untagged = (failure: unknown) => ({
      metadata: () => {
        throw failure;
      },
      assets: () => ({ fungibleAssets: () => [asset(500n, 'tkn')], nonFungibleAssets: () => [] })
    });
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it.each([['before'], ['after']])('splits out the fee note when a note %s it traps in its tag read', order => {
      const fee = kernelFee();
      const trapped = untagged(trap);
      const notes = order === 'before' ? [trapped, fee] : [fee, trapped];
      expect(splitLandedOutputNotes(landed(executed(notes)), `per-check-tag-${order}`)).toEqual({
        feeNote: fee,
        userNotes: [trapped],
        verificationFeeKnown: false
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.any(String), [trap]);
    });

    it('warns once, naming both traps, when two notes trap', () => {
      const other = new WebAssembly.RuntimeError('unreachable');
      const fee = kernelFee();
      const first = untagged(trap);
      const second = untagged(other);
      expect(splitLandedOutputNotes(landed(executed([first, fee, second])), 'per-check-two-traps')).toEqual({
        feeNote: fee,
        userNotes: [first, second],
        verificationFeeKnown: false
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.any(String), [trap, other]);
    });

    // Two candidates mean neither is the fee, so a tagged note that cannot be ruled out keeps the split ambiguous.
    it.each(['faucet', 'amount'] as const)(
      'identifies no fee note when a second fee-tagged note traps in its %s read',
      where => {
        const fee = kernelFee();
        const second = trapping(where, trap);
        expect(splitLandedOutputNotes(landed(executed([fee, second])), `per-check-second-${where}`)).toEqual({
          feeNote: undefined,
          userNotes: [fee, second],
          verificationFeeKnown: false
        });
      }
    );

    it('logs nothing when no check traps', () => {
      splitLandedOutputNotes(
        landed(executed([user, untagged(new TypeError('no accessor')), kernelFee()])),
        'per-check-none'
      );
      expect(warn).not.toHaveBeenCalled();
    });

    // A trapped tag is unknown, not absent: a native note within the ceiling may be a second fee-tagged candidate.
    it.each([['before'], ['after']])(
      'identifies no fee note when a native note within the ceiling %s the fee note traps in its tag read',
      order => {
        const fee = kernelFee();
        const unknownTag = trapping('tag', trap);
        const notes = order === 'before' ? [unknownTag, fee] : [fee, unknownTag];
        expect(splitLandedOutputNotes(landed(executed(notes)), `per-check-unknown-tag-${order}`)).toEqual({
          feeNote: undefined,
          userNotes: notes,
          verificationFeeKnown: false
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.any(String), [trap]);
      }
    );

    it.each(['faucet', 'amount'] as const)(
      'identifies no fee note when a note traps in its tag read and then in its %s read',
      second => {
        const other = new WebAssembly.RuntimeError('unreachable');
        const fail = (failure: unknown) => () => {
          throw failure;
        };
        const fee = kernelFee();
        const twice = {
          metadata: () => ({ tag: fail(trap) }),
          assets: () => ({
            fungibleAssets: () => [
              {
                amount: second === 'amount' ? fail(other) : () => '163840',
                faucetId: second === 'faucet' ? fail(other) : () => 'native'
              }
            ],
            nonFungibleAssets: () => []
          })
        };
        expect(splitLandedOutputNotes(landed(executed([twice, fee])), `per-check-tag-then-${second}`)).toEqual({
          feeNote: undefined,
          userNotes: [twice, fee],
          verificationFeeKnown: false
        });
        expect(warn).toHaveBeenCalledTimes(1);
      }
    );

    it('splits out the fee note beside a native note whose tag traps and whose amount is over the ceiling', () => {
      const fee = kernelFee();
      const overCeiling = {
        metadata: () => ({
          tag: () => {
            throw trap;
          }
        }),
        assets: () => ({
          fungibleAssets: () => [asset(BigInt(CHARGING * FEE_RESERVE_MULTIPLE) + 1n, 'native')],
          nonFungibleAssets: () => []
        })
      };
      expect(splitLandedOutputNotes(landed(executed([overCeiling, fee])), 'per-check-over-ceiling')).toEqual({
        feeNote: fee,
        userNotes: [overCeiling],
        verificationFeeKnown: false
      });
      expect(warn).toHaveBeenCalledWith(expect.any(String), [trap]);
    });
  });
});

describe('reviewed USDCx completed fee total', () => {
  const tx = (maximum = '300'): ITransaction => ({
    id: 'usdcx-row', type: 'bridged-send', accountId: 'acct', amount: 100n,
    faucetId: 'bech32-native', approvedOutputNoteIds: ['burn'],
    status: ITransactionStatus.GeneratingTransaction, initiatedAt: 0, displayIcon: 'DEFAULT',
    extraInputs: { provider: 'usdcx', usdcxBurn: {
      noteId: 'burn', destinationDomain: 6, phase: 'pending',
      networkFeeBudget: {
        faucetId: 'bech32-native', maxAmount: maximum,
        scope: '0eab4363008ac48565a556005f9429c4a85838ec79dc00c463d15dcbb4c14c5c'
      }
    } }
  });
  const named = (id: string, amount: bigint, tag = 0) => ({
    ...outputNote(tag, [asset(amount, 'native')]), id: () => ({ toString: () => id })
  });
  const burn = named('burn', 100n);
  const companion = named('sponsor', 119n);
  const kernel = named('kernel', 119n, TX_FEE_NOTE_TAG);
  beforeEach(() => {
    mockNativeAssetId = 'bech32-native';
    mockVerificationBaseFee = 7;
    jest.mocked(canonicalFeeSponsorshipNoteId).mockReset().mockReturnValue('sponsor');
  });

  it('records the actually paid verification plus canonical sponsorship fee', () => {
    expect(feeFieldsFromResult(result([burn, companion, kernel]), 'total', tx())).toEqual({
      feeAmount: 238n, feeFaucetId: 'bech32-native'
    });
  });

  it('records a companion alone only when the kernel fee is known zero', () => {
    mockVerificationBaseFee = 0;
    expect(feePaidFromResult(result([burn, companion]), 'zero-kernel', tx())).toEqual({
      amount: 119n, faucetId: 'bech32-native'
    });
  });

  it('does not report a partial total when the ordinary fee is ambiguous', () => {
    const ambiguous = result([burn, companion, kernel, named('kernel-two', 126n, TX_FEE_NOTE_TAG)]);
    expect(feeFieldsFromResult(ambiguous, 'unknown-total', tx())).toEqual({});
    expect(canonicalFeeSponsorshipNoteId).not.toHaveBeenCalled();
  });

  it.each(['237', '0002'])('omits an unvalidated landed total for budget %s without failing the row', maximum => {
    expect(feeFieldsFromResult(result([burn, companion, kernel]), `budget-${maximum}`, tx(maximum))).toEqual({});
  });

  it('retires a companion reconstruction trap once and leaves completed bookkeeping non-replayable', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const retire = jest.fn();
    const restore = installLandedTrapRetirement(retire);
    const execution = result([burn, companion, kernel]);
    jest.mocked(canonicalFeeSponsorshipNoteId).mockImplementation(() => { throw trap; });
    try {
      expect(feeFieldsFromResult(execution, 'total-trap', tx())).toEqual({});
      expect(feeFieldsFromResult(execution, 'total-trap', tx())).toEqual({});
      expect(retire.mock.calls).toEqual([[trap, 'total-trap']]);
    } finally { restore(); }
  });

  it('still propagates eviction instead of answering for a stopped pipeline', () => {
    jest.mocked(canonicalFeeSponsorshipNoteId).mockImplementation(() => { throw poison; });
    expect(thrownBy(() => feePaidFromResult(result([burn, companion, kernel]), 'total-evicted', tx()))).toBe(poison);
  });
});
