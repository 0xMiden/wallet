/**
 * One approval of a dApp custom transaction, read by the three layers that check it: the approval the user sees, the
 * generation check that dry-runs the queued row again, and the signing check of the summary the hot key signs. Each
 * case runs one dry run's summary through the real decoder, the real approval, the real row insert and both real
 * checks, so a layer that measured what leaves differently from the others fails here.
 */
import { TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { summaryBytesToView } from 'app/confirm/decode';

import { CustomTransactionEffectsChangedError } from './constants';
import { approveCustomSimulation, assertCustomEffectsApproved, type ApprovedCustomSimulation } from './custom-effects';
import { requestCustomTransaction } from './initiate';
import { proposalEffectRefusal } from './proposal-effect-guard';
import type { ITransaction } from '../db/types';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  TransactionSummary: { deserialize: jest.fn() }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: jest.fn((id: string | { __faucet: string }) =>
    typeof id === 'string' ? `bech32:${id}` : `bech32:${id.__faucet}`
  ),
  canonicalWalletAccountId: jest.fn((id: string) => id.replace(/^hex:/, ''))
}));
// The chain charges a fee in its native asset, so the kernel's fee note is told apart on every decode.
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: jest.fn(() => 'bech32:usdcx'),
  getVerificationBaseFeeSync: jest.fn(() => 2)
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet'
}));

const mockAdd = jest.fn(async (_row: ITransaction) => undefined);
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { add: mockAdd };
  }
}));
jest.mock('../spending-limits/queue', () => ({
  hasSpendingLimits: jest.fn(async () => true),
  queueOutgoingTransaction: jest.fn(async (transaction: ITransaction) => {
    const repo = jest.requireMock('lib/miden/repo');
    await repo.transactions.add(transaction);
  }),
  queueUnattributableCustomTransaction: jest.fn(async () => {
    throw new Error('an approval measured from holdings is always attributable');
  })
}));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async (fn: () => unknown) => fn(),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => true }));

type Asset = { faucetId: () => { __faucet: string }; amount: () => bigint };
type StubNote = {
  id: () => { toString: () => string };
  assets: () => { fungibleAssets: () => Asset[]; nonFungibleAssets: () => never[] };
  recipientDigest: () => { toHex: () => string };
  metadata?: () => { tag: () => { asU32: () => number } };
};

const fa = (faucet: string, amount: bigint): Asset => ({
  faucetId: () => ({ __faucet: faucet }),
  amount: () => amount
});
const note = (id: string, assets: Asset[]): StubNote => ({
  id: () => ({ toString: () => id }),
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => [] }),
  recipientDigest: () => ({ toHex: () => `recipient-of-${id}` })
});
const feeNote = (amount: bigint): StubNote => ({
  ...note('0xfee', [fa('usdcx', amount)]),
  metadata: () => ({ tag: () => ({ asU32: () => 0xfee }) })
});

/** A Guardian dry run's summary: the NET vault delta, the notes it consumed, and the notes it created. */
const summary = ({ removed, inputs, outputs }: { removed: Asset[]; inputs: StubNote[]; outputs: StubNote[] }) => ({
  accountDelta: () => ({
    id: () => 'acct',
    vault: () => ({
      removedFungibleAssets: () => removed,
      addedFungibleAssets: () => [],
      numAssets: () => removed.length
    }),
    storage: () => ({ isEmpty: () => true })
  }),
  inputNotes: () => ({
    numNotes: () => inputs.length,
    notes: () => inputs.map(input => ({ id: input.id, note: () => input }))
  }),
  outputNotes: () => ({ numNotes: () => outputs.length, notes: () => outputs })
});

const SUMMARY_BYTES = 'c3VtbWFyeQ==';

/** The one dry run every layer reads, whether the approval, the generation check or the proposal decodes it. */
const dryRunGives = (ts: ReturnType<typeof summary>) =>
  jest.mocked(TransactionSummary.deserialize).mockReturnValue(ts as never);

/** The row the approved request is queued as, inserted by the real initiator from the approval. */
const queuedRow = async (approval: ApprovedCustomSimulation): Promise<ITransaction> => {
  await requestCustomTransaction(
    'acct',
    Buffer.from('custom-request').toString('base64'),
    undefined,
    undefined,
    undefined,
    undefined,
    approval.spends,
    undefined,
    'https://dapp.example',
    approval.signing.approvedNftOutflow,
    approval.signing.approvedOutflow,
    approval.effects
  );
  expect(mockAdd).toHaveBeenCalledTimes(1);
  return mockAdd.mock.calls[0]![0];
};

const generationCheck = (row: ITransaction) => () =>
  assertCustomEffectsApproved(row.approvedEffects, { summaryBytes: SUMMARY_BYTES }, row.spentAssetTotals, true);

const signingCheck = (row: ITransaction) => proposalEffectRefusal(row, summaryBytesToView(SUMMARY_BYTES));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('one approval, measured alike by the approval, the generation check and the signing check', () => {
  it('credits the note the request carried once, at every layer', async () => {
    // The request carries a 50 X note and sends 100 X: 50 X of the account's own leaves, plus the 2 fee.
    dryRunGives(
      summary({
        removed: [fa('fX', 50n), fa('usdcx', 2n)],
        inputs: [note('0xcarried', [fa('fX', 50n)])],
        outputs: [note('0xsent', [fa('fX', 100n)]), feeNote(2n)]
      })
    );

    const approval = approveCustomSimulation({ summaryBytes: SUMMARY_BYTES, introducedNoteIds: ['0xcarried'] });
    if (approval === undefined) throw new Error('the dry run gave no approval');
    const row = await queuedRow(approval);

    expect(approval.view.outgoing).toEqual([{ faucetId: 'bech32:fX', amount: 50n }]);
    expect(row.approvedOutflow).toEqual([{ faucetId: 'bech32:fX', amount: 50n }]);
    expect(row.spentAssetTotals).toEqual([{ faucetId: 'bech32:fX', amount: 50n }]);
    expect(row.approvedEffects).toMatchObject({ introducedNoteIds: ['0xcarried'], approvedOutputNoteIds: ['0xsent'] });
    expect(generationCheck(row)).not.toThrow();
    expect(signingCheck(row)).toBeUndefined();
  });

  it('counts a held note the request spends as leaving, at every layer', async () => {
    // The request consumes a 1000 X note the account already held and sends 1050 X; the vault nets 50 X.
    dryRunGives(
      summary({
        removed: [fa('fX', 50n), fa('usdcx', 2n)],
        inputs: [note('0xheld', [fa('fX', 1000n)])],
        outputs: [note('0xsent', [fa('fX', 1050n)]), feeNote(2n)]
      })
    );

    const approval = approveCustomSimulation({ summaryBytes: SUMMARY_BYTES, introducedNoteIds: [] });
    if (approval === undefined) throw new Error('the dry run gave no approval');
    const row = await queuedRow(approval);

    expect(approval.view.outgoing).toEqual([{ faucetId: 'bech32:fX', amount: 1050n }]);
    expect(approval.view.heldNotesSpent).toBe(1);
    expect(row.approvedOutflow).toEqual([{ faucetId: 'bech32:fX', amount: 1050n }]);
    expect(row.spentAssetTotals).toEqual([{ faucetId: 'bech32:fX', amount: 1050n }]);
    expect(generationCheck(row)).not.toThrow();
    expect(signingCheck(row)).toBeUndefined();

    // The net 50 the vault shows is what each layer refuses to take for the held 1000.
    const netOnly = { ...row, spentAssetTotals: [{ faucetId: 'bech32:fX', amount: 50n }] };
    expect(generationCheck(netOnly)).toThrow(new CustomTransactionEffectsChangedError('spentAssetTotals'));
    expect(signingCheck({ ...row, approvedOutflow: [{ faucetId: 'bech32:fX', amount: 50n }] })).toBe(
      '1050 of bech32:fX leaves (approved 50)'
    );
  });

  it('refuses at signing a note the approval did not show being created', async () => {
    dryRunGives(
      summary({
        removed: [fa('fX', 50n), fa('usdcx', 2n)],
        inputs: [note('0xcarried', [fa('fX', 50n)])],
        outputs: [note('0xsent', [fa('fX', 100n)]), feeNote(2n)]
      })
    );
    const approval = approveCustomSimulation({ summaryBytes: SUMMARY_BYTES, introducedNoteIds: ['0xcarried'] });
    if (approval === undefined) throw new Error('the dry run gave no approval');
    const row = await queuedRow(approval);

    // The proposal sends the same 100 X in a note with another id: another recipient or serial.
    dryRunGives(
      summary({
        removed: [fa('fX', 50n), fa('usdcx', 2n)],
        inputs: [note('0xcarried', [fa('fX', 50n)])],
        outputs: [note('0xelsewhere', [fa('fX', 100n)]), feeNote(2n)]
      })
    );

    expect(signingCheck(row)).toBe('creates a note that was not approved (0xelsewhere)');
  });
});
