import fc from 'fast-check';

import { summaryToView } from 'app/confirm/decode';
import { getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';

import { proposalEffectRefusal } from './proposal-effect-guard';
import { ITransaction, ITransactionStatus } from '../db/types';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ TransactionSummary: { deserialize: jest.fn() } }));
// Same doubles as proposal-effect-guard.test.ts: the decoder spells a faucet `bech32:x`, `hex:` is the other spelling.
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: string | { __faucet: string }) =>
    typeof id === 'string' ? `bech32:${id}` : `bech32:${id.__faucet}`
  ),
  canonicalWalletAccountId: jest.fn((id: string) => id.replace(/^hex:/, ''))
}));
jest.mock('lib/miden/sdk/nft-asset', () => ({
  toNft: jest.fn((a: { __nft: unknown }) => a.__nft),
  nftKey: jest.fn((a: { __key: string }) => a.__key)
}));
jest.mock('lib/shared/helpers', () => ({ b64ToU8: jest.fn(() => new Uint8Array([1])) }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => 'bech32:usdcx'),
  getVerificationBaseFeeSync: jest.fn(() => 2),
  getVerificationBaseFee: jest.fn(async () => 2),
  refreshVerificationBaseFee: jest.fn(async () => 2),
  isVerificationBaseFeeKnownAbsent: jest.fn(() => false)
}));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: jest.fn(async (fn: (h: object) => unknown) => fn({})) }));
jest.mock('lib/i18n/core', () => ({ getMessage: jest.fn((key: string) => key) }));

const NATIVE = 'usdcx';
const FAUCETS = [NATIVE, 'fA', 'fB'] as const;
const FEE_TAG = 0xfee;

type Fungible = { faucet: string; amount: bigint };
type Note = { fungible: Fungible[]; nfts: string[]; tag: number };

/**
 * One transaction that respects asset conservation: what the consumed notes bring and what the vault gives up is
 * exactly what the created notes carry, plus the kernel's fee when the chain charges one. `feeTagged` is a created note
 * that also wears the fee tag on one native asset.
 */
interface World {
  inputs: Note[];
  outputs: Note[];
  feeTagged?: bigint;
  ownedNfts: string[];
  fee: { mode: 'charged'; amount: bigint } | { mode: 'unknown'; amount: bigint } | { mode: 'free' };
  unlisted: number;
}

const amount = fc.bigInt({ min: 1n, max: 1_000n });
const fungibles = fc.array(fc.record({ faucet: fc.constantFrom(...FAUCETS), amount }), { maxLength: 2 });
const tag = fc.oneof(fc.constant(FEE_TAG), fc.integer({ min: 0, max: 0xffff }));

const world: fc.Arbitrary<World> = fc
  .record({
    inputs: fc.array(fc.record({ fungible: fungibles, nft: fc.boolean(), tag }), { maxLength: 3 }),
    ownedNfts: fc.constantFrom<string[]>([], ['own-1'], ['own-1', 'own-2']),
    outputs: fc.array(fc.record({ fungible: fungibles, nftPick: fc.nat(), sendsNft: fc.boolean(), tag }), {
      maxLength: 3
    }),
    feeTagged: fc.option(fc.bigInt({ min: 1n, max: 100n }), { nil: undefined }),
    fee: fc.oneof(
      fc.record({ mode: fc.constant('charged' as const), amount: fc.bigInt({ min: 1n, max: 5n }) }),
      fc.record({ mode: fc.constant('unknown' as const), amount: fc.bigInt({ min: 1n, max: 5n }) }),
      fc.record({ mode: fc.constant('free' as const) })
    ),
    unlisted: fc.oneof({ weight: 9, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.constant(1) })
  })
  .map(raw => {
    const inputs: Note[] = raw.inputs.map((n, i) => ({
      fungible: n.fungible,
      nfts: n.nft ? [`in-${i}`] : [],
      tag: n.tag
    }));
    // Every NFT leaves at most once, from the vault or from a consumed note.
    const pool = [...raw.ownedNfts, ...inputs.flatMap(n => n.nfts)];
    const outputs: Note[] = raw.outputs.map(n => {
      const nfts = n.sendsNft && pool.length > 0 ? pool.splice(n.nftPick % pool.length, 1) : [];
      return { fungible: n.fungible, nfts, tag: n.tag };
    });
    return {
      inputs,
      outputs,
      feeTagged: raw.feeTagged,
      ownedNfts: raw.ownedNfts,
      fee: raw.fee,
      unlisted: raw.unlisted
    };
  });

const sum = (notes: Note[], faucet: string) =>
  notes.flatMap(n => n.fungible).reduce((t, a) => (a.faucet === faucet ? t + a.amount : t), 0n);

/** All the notes the transaction creates, the feeTagged one included but not the kernel's fee note. */
const created = (w: World): Note[] =>
  w.feeTagged === undefined
    ? w.outputs
    : [...w.outputs, { fungible: [{ faucet: NATIVE, amount: w.feeTagged }], nfts: [], tag: FEE_TAG }];

/** What actually goes to other parties, beyond the network fee: the oracle every verdict is held to. */
const leaving = (w: World) => ({
  byFaucet: new Map(FAUCETS.map(f => [f, sum(created(w), f) - sum(w.inputs, f)] as const)),
  nfts: created(w)
    .flatMap(n => n.nfts)
    .filter(k => w.ownedNfts.includes(k))
});

const asset = (a: Fungible) => ({ faucetId: () => ({ __faucet: a.faucet }), amount: () => a.amount });
let stubNoteCount = 0;
const stubNoteId = () => ({ toString: () => `stub-note-${++stubNoteCount}` });
const stubNote = (n: Note) => ({
  id: stubNoteId,
  assets: () => ({
    fungibleAssets: () => n.fungible.map(asset),
    nonFungibleAssets: () => n.nfts.map(k => ({ __nft: { faucetId: 'bech32:fN', assetId: k }, __key: k }))
  }),
  metadata: () => ({ tag: () => ({ asU32: () => n.tag }) })
});

/** The summary the SDK would hand over for `w`: a net vault delta, one entry per faucet, and the notes. */
const summaryOf = (w: World) => {
  const feeAmount = w.fee.mode === 'free' ? 0n : w.fee.amount;
  const kernelFee: Note[] =
    w.fee.mode === 'free' ? [] : [{ fungible: [{ faucet: NATIVE, amount: feeAmount }], nfts: [], tag: FEE_TAG }];
  const added: Fungible[] = [];
  const removed: Fungible[] = [];
  for (const faucet of FAUCETS) {
    const net = sum(w.inputs, faucet) - sum(created(w), faucet) - (faucet === NATIVE ? feeAmount : 0n);
    if (net > 0n) added.push({ faucet, amount: net });
    if (net < 0n) removed.push({ faucet, amount: -net });
  }
  const leavingNfts = leaving(w).nfts.length;
  const enteringNfts = w.inputs.flatMap(n => n.nfts).filter(k => !created(w).some(c => c.nfts.includes(k))).length;
  const outputs = [...created(w), ...kernelFee].map(stubNote);
  return {
    accountDelta: () => ({
      id: () => 'acct',
      vault: () => ({
        addedFungibleAssets: () => added.map(asset),
        removedFungibleAssets: () => removed.map(asset),
        numAssets: () => added.length + removed.length + leavingNfts + enteringNfts + w.unlisted
      }),
      storage: () => ({ isEmpty: () => true })
    }),
    inputNotes: () => ({
      numNotes: () => w.inputs.length,
      notes: () => w.inputs.map(n => ({ id: stubNoteId, note: () => stubNote(n) }))
    }),
    outputNotes: () => ({ numNotes: () => outputs.length, notes: () => outputs })
  };
};

const verdict = (w: World, transaction: ITransaction) => {
  jest
    .mocked(getVerificationBaseFeeSync)
    .mockReturnValue(w.fee.mode === 'unknown' ? null : w.fee.mode === 'free' ? 0 : 2);
  return proposalEffectRefusal(transaction, summaryToView(summaryOf(w) as never));
};

const row = (fields: Partial<ITransaction>): ITransaction => ({
  id: 'tx',
  type: 'consume',
  accountId: 'acct',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 0,
  displayIcon: 'DEFAULT',
  ...fields
});

/** An allowance spelled the way stored rows may spell it: either faucet spelling, one amount split into parts. */
const spelledAllowance = (totals: Map<string, bigint>) =>
  fc
    .tuple(
      ...[...totals].map(([faucet, total]) =>
        fc.tuple(fc.constant(faucet), fc.constant(total), fc.boolean(), fc.boolean())
      )
    )
    .map(entries =>
      entries.flatMap(([faucet, total, hex, split]) => {
        const faucetId = `${hex ? 'hex:' : ''}bech32:${faucet}`;
        const half = total / 2n;
        return split && total > 1n
          ? [
              { faucetId, amount: half },
              { faucetId, amount: total - half }
            ]
          : [{ faucetId, amount: total }];
      })
    );

const RUNS = { numRuns: 400 };

describe('proposal effect guard: properties over conservation-respecting transactions', () => {
  it('a claim it passes sends nothing of the account to anyone but the network fee', () => {
    fc.assert(
      fc.property(world, w => {
        if (verdict(w, row({ type: 'consume', noteId: 'n' })) !== undefined) return;
        const out = leaving(w);
        for (const [, net] of out.byFaucet) expect(net).toBeLessThanOrEqual(0n);
        expect(out.nfts).toEqual([]);
        expect(w.unlisted).toBe(0);
      }),
      RUNS
    );
  });

  it('a GC purchase it passes pays at most its quoted fill, in the pay asset only', () => {
    fc.assert(
      fc.property(world, fc.bigInt({ min: 0n, max: 1_500n }), (w, fill) => {
        const gcPurchase = {
          saleNoteId: 's',
          sellerAccountId: 'seller',
          payFaucetId: `bech32:${NATIVE}`,
          fillAmount: fill.toString(),
          gcFaucetId: 'bech32:gc',
          expectedAmount: '1'
        };
        if (verdict(w, row({ type: 'consume', extraInputs: { gcPurchase } })) !== undefined) return;
        const out = leaving(w);
        for (const [faucet, net] of out.byFaucet) expect(net).toBeLessThanOrEqual(faucet === NATIVE ? fill : 0n);
        expect(out.nfts).toEqual([]);
      }),
      RUNS
    );
  });

  it('an execute it passes moves no more of any faucet, and no NFT, beyond what was approved', () => {
    const scenario = world.chain(w => {
      const truth = leaving(w);
      // Allowances near the truth, so passes and refusals both occur.
      const nearTruth = fc.tuple(
        ...FAUCETS.map(f =>
          fc
            .bigInt({ min: -3n, max: 3n })
            .map(d => [f, (truth.byFaucet.get(f)! > 0n ? truth.byFaucet.get(f)! : 0n) + d] as const)
        )
      );
      return fc.record({
        w: fc.constant(w),
        totals: nearTruth.chain(pairs => spelledAllowance(new Map(pairs.filter(([, v]) => v > 0n)))),
        nfts: fc.subarray([...truth.nfts, 'own-1', 'own-2']),
        viaFallback: fc.boolean()
      });
    });
    fc.assert(
      fc.property(scenario, ({ w, totals, nfts, viaFallback }) => {
        const transaction = row({
          type: 'execute',
          requestBytes: new Uint8Array([1]),
          ...(viaFallback ? { spentAssetTotals: totals } : { approvedOutflow: totals, approvedNftOutflow: nfts })
        });
        if (verdict(w, transaction) !== undefined) return;
        const approved = new Map<string, bigint>();
        for (const t of totals) {
          const f = t.faucetId.replace(/^hex:bech32:|^bech32:/, '');
          approved.set(f, (approved.get(f) ?? 0n) + t.amount);
        }
        const out = leaving(w);
        for (const [faucet, net] of out.byFaucet) expect(net).toBeLessThanOrEqual(approved.get(faucet) ?? 0n);
        for (const key of out.nfts) expect(viaFallback ? [] : nfts).toContain(key);
      }),
      RUNS
    );
  });

  it('passes a claim of foreign payments when the fee is told apart and nothing else leaves (no over-refusal)', () => {
    const plainClaim = world.filter(
      w =>
        w.fee.mode !== 'unknown' &&
        w.feeTagged === undefined &&
        w.unlisted === 0 &&
        [...leaving(w).byFaucet.values()].every(net => net <= 0n) &&
        leaving(w).nfts.length === 0 &&
        // A created note of the user's that wears the fee tag on a sole native asset makes the fee ambiguous on purpose.
        !w.outputs.some(
          n => n.tag === FEE_TAG && n.nfts.length === 0 && n.fungible.length === 1 && n.fungible[0]!.faucet === NATIVE
        )
    );
    fc.assert(
      fc.property(plainClaim, w => {
        expect(verdict(w, row({ type: 'consume', noteId: 'n' }))).toBeUndefined();
      }),
      RUNS
    );
  });
});
