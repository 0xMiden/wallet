/**
 * The rule for a dApp custom (`execute`) transaction: the wallet proposes it only when the effects of its
 * generation-time dry run equal the effects that the user approved, and the spending-limit charge is the
 * generation-time value.
 */
import { CustomTransactionEffectsChangedError } from './constants';
import {
  approveCustomSimulation,
  assertCustomEffectsApproved,
  customEffectsCheckAccess,
  customEffectsDifference,
  verifyPreparedCustomRequest,
  type CustomEffectsCheckAccess
} from './custom-effects';
import type { IApprovedCustomEffects } from '../db/types';
import type { CustomDryRunBytes } from '../sdk/custom-dry-run';

interface TestView {
  outgoing: { faucetId: string; amount: bigint }[];
  incoming: { faucetId: string; amount: bigint }[];
  outgoingNfts: { faucetId: string; assetId: string }[];
  incomingNfts: { faucetId: string; assetId: string }[];
  unlistedAssets: number;
  inputNotesConsumed: number;
  outputNotesCreated: number;
  fee?: { faucetId: string; amount: bigint };
  storageChanged: boolean;
}

/** The decoded result of each dry run, by its bytes. The decoders themselves are covered by `decode.test.ts`. */
const mockViews = new Map<string, TestView>();
const mockRecipients = new Map<string, string[]>();
const bytesOf = (result: { summaryBytes?: string; executedBytes?: string }) =>
  result.summaryBytes ?? result.executedBytes ?? '';

jest.mock('app/confirm/decode', () => ({
  ...jest.requireActual('app/confirm/decode'),
  simulatedBytesToView: (result: { summaryBytes?: string; executedBytes?: string }) => mockViews.get(bytesOf(result)),
  simulatedOutputRecipients: (result: { summaryBytes?: string; executedBytes?: string }) =>
    mockRecipients.get(bytesOf(result))
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  // Canonical spelling for the test faucets: an upper-case spelling is the same faucet.
  canonicalWalletAccountId: (id: string) => id.toLowerCase(),
  accountRefToSdk: (id: string) => ({ toString: () => `hex:${id}` })
}));

jest.mock('lib/miden/spending-limits/identity', () => ({
  canonicalSpendingLimitIdentity: (id: string) => id.toLowerCase(),
  sameSpendingLimitIdentity: (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
}));

// The check reaches the client only through its access (see `checkAccess` below), so these modules are never called.
jest.mock('lib/miden/sdk/custom-dry-run', () => ({ dryRunPreparedCustomRequest: jest.fn() }));
jest.mock('lib/miden/sdk/miden-client', () => ({ assertWasmHoldCurrent: jest.fn() }));

const mockHasSpendingLimits = jest.fn(async (..._args: unknown[]) => false);
jest.mock('lib/miden/spending-limits/queue', () => ({
  hasSpendingLimits: (...args: unknown[]) => mockHasSpendingLimits(...args)
}));

const view = (overrides: Partial<TestView> = {}): TestView => ({
  outgoing: [{ faucetId: 'faucet-a', amount: 10n }],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  inputNotesConsumed: 1,
  outputNotesCreated: 1,
  fee: { faucetId: 'faucet-native', amount: 3n },
  storageChanged: false,
  ...overrides
});

/** The approval dry run under `approved`, with the given provenance. */
const approve = (
  approvedView: TestView,
  recipients: string[] = ['0xr1'],
  provenance: { introducedCredit?: { faucetId: string; amount: bigint }[]; introducedCount?: number } = {}
) => {
  mockViews.set('approved', approvedView);
  mockRecipients.set('approved', recipients);
  const approval = approveCustomSimulation({ summaryBytes: 'approved', ...provenance });
  if (approval === undefined) throw new Error('the approval dry run gave no result');
  return approval;
};

/** The generation dry run under `generated`. */
const generate = (generatedView: TestView, recipients: string[] = ['0xr1']) => {
  mockViews.set('generated', generatedView);
  mockRecipients.set('generated', recipients);
  return { summaryBytes: 'generated' };
};

beforeEach(() => {
  mockViews.clear();
  mockRecipients.clear();
  mockHasSpendingLimits.mockReset();
  mockHasSpendingLimits.mockResolvedValue(false);
});

describe('approveCustomSimulation', () => {
  it('records the movement per canonical faucet, the recipients, the note counts and the provenance', () => {
    const approval = approve(
      view({
        outgoing: [
          { faucetId: 'faucet-b', amount: 2n },
          { faucetId: 'faucet-a', amount: 10n },
          { faucetId: 'FAUCET-A', amount: 5n }
        ],
        incoming: [{ faucetId: 'faucet-c', amount: 7n }],
        outgoingNfts: [{ faucetId: 'nft-faucet', assetId: '0xaa' }],
        fee: { faucetId: 'FAUCET-NATIVE', amount: 3n }
      }),
      ['0xr2', '0xr1'],
      { introducedCredit: [{ faucetId: 'faucet-a', amount: 4n }], introducedCount: 1 }
    );

    expect(approval.effects).toEqual({
      shape: 'summary',
      outgoing: [
        { faucetId: 'faucet-a', amount: 15n },
        { faucetId: 'faucet-b', amount: 2n }
      ],
      incoming: [{ faucetId: 'faucet-c', amount: 7n }],
      outgoingNfts: ['nft-faucet|0xaa'],
      incomingNfts: [],
      unlistedAssets: 0,
      recipients: ['0xr2', '0xr1'],
      inputNotesConsumed: 1,
      outputNotesCreated: 1,
      fee: { faucetId: 'faucet-native', amount: 3n },
      storageChanged: false,
      introducedCredit: [{ faucetId: 'faucet-a', amount: 4n }],
      introducedCount: 1
    });
  });

  it('charges the net outflow after the credit of the notes the request introduced', () => {
    const approval = approve(view(), ['0xr1'], {
      introducedCredit: [{ faucetId: 'faucet-a', amount: 4n }],
      introducedCount: 1
    });

    expect(approval.spends).toEqual([{ faucetId: 'faucet-a', amount: 6n }]);
  });

  it('gives no charge it cannot attribute when a summary consumed notes the request did not introduce', () => {
    const approval = approve(view({ inputNotesConsumed: 2 }), ['0xr1'], { introducedCount: 1 });

    expect(approval.spends).toBeUndefined();
  });

  it('gives no approval when the dry run gave no result', () => {
    const failed = { error: 'note not found', summaryBytes: undefined };
    expect(approveCustomSimulation(failed)).toBeUndefined();
    expect(approveCustomSimulation({})).toBeUndefined();
  });
});

describe('assertCustomEffectsApproved', () => {
  it('refuses a generation dry run whose fee differs from the approved effects', () => {
    const approval = approve(view());
    const dryRun = generate(view({ fee: { faucetId: 'faucet-native', amount: 9n } }));

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, approval.spends)).toThrow(
      new CustomTransactionEffectsChangedError('fee')
    );
  });

  it.each([
    ['approved fee missing from generation', { faucetId: 'faucet-native', amount: 3n }, undefined],
    ['generation fee missing from approval', undefined, { faucetId: 'faucet-native', amount: 3n }],
    ['fee faucet changed', { faucetId: 'faucet-native', amount: 3n }, { faucetId: 'faucet-other', amount: 3n }],
    ['fee amount changed', { faucetId: 'faucet-native', amount: 3n }, { faucetId: 'faucet-native', amount: 9n }]
  ])('refuses when %s', (_case, approvedFee, generatedFee) => {
    const approval = approve(view({ fee: approvedFee }));
    const dryRun = generate(view({ fee: generatedFee }));

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, approval.spends)).toThrow(
      new CustomTransactionEffectsChangedError('fee')
    );
  });

  it('accepts the same movement in another faucet spelling and another order', () => {
    const approval = approve(
      view({
        outgoing: [
          { faucetId: 'faucet-a', amount: 10n },
          { faucetId: 'faucet-b', amount: 2n }
        ]
      }),
      ['0xr1', '0xr2']
    );
    const dryRun = generate(
      view({
        outgoing: [
          { faucetId: 'faucet-b', amount: 2n },
          { faucetId: 'FAUCET-A', amount: 10n }
        ]
      }),
      ['0xr1', '0xr2']
    );

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, approval.spends)).not.toThrow();
  });

  it.each<[string, Partial<TestView>, string[], string]>([
    ['a different outgoing amount', { outgoing: [{ faucetId: 'faucet-a', amount: 11n }] }, ['0xr1'], 'outgoing'],
    ['another outgoing faucet', { outgoing: [{ faucetId: 'faucet-z', amount: 10n }] }, ['0xr1'], 'outgoing'],
    ['a different incoming amount', { incoming: [{ faucetId: 'faucet-c', amount: 1n }] }, ['0xr1'], 'incoming'],
    ['another recipient', {}, ['0xr9'], 'recipients'],
    ['one more output note', { outputNotesCreated: 2 }, ['0xr1'], 'outputNotesCreated'],
    ['one more input note', { inputNotesConsumed: 2 }, ['0xr1'], 'inputNotesConsumed'],
    ['an NFT that leaves', { outgoingNfts: [{ faucetId: 'nft', assetId: '0x01' }] }, ['0xr1'], 'outgoingNfts'],
    ['a storage change', { storageChanged: true }, ['0xr1'], 'storageChanged'],
    ['an unlisted vault change', { unlistedAssets: 1 }, ['0xr1'], 'unlistedAssets']
  ])('refuses %s', (_name, change, recipients, field) => {
    const approval = approve(view());
    const dryRun = generate(view(change), recipients);

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, approval.spends)).toThrow(
      new CustomTransactionEffectsChangedError(field)
    );
  });

  it('refuses a change of dry-run shape', () => {
    const approval = approve(view());
    mockViews.set('generated', view());
    mockRecipients.set('generated', ['0xr1']);

    expect(() =>
      assertCustomEffectsApproved(approval.effects, { executedBytes: 'generated' }, approval.spends)
    ).toThrow(new CustomTransactionEffectsChangedError('shape'));
  });

  it('refuses a row that has no approved effects', () => {
    const dryRun = generate(view());

    expect(() => assertCustomEffectsApproved(undefined, dryRun, [])).toThrow(CustomTransactionEffectsChangedError);
  });

  it('refuses a generation dry run that gives no result', () => {
    const approval = approve(view());

    expect(() => assertCustomEffectsApproved(approval.effects, {}, approval.spends)).toThrow(
      CustomTransactionEffectsChangedError
    );
  });

  it('refuses when the generation-time spends are not the spends the admission charged', () => {
    const approval = approve(view(), ['0xr1'], { introducedCount: 1 });
    const dryRun = generate(view());

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, [{ faucetId: 'faucet-a', amount: 1n }])).toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
  });

  it('charges with the approval provenance, which the generation dry run cannot identify again', () => {
    const approval = approve(view(), ['0xr1'], {
      introducedCredit: [{ faucetId: 'faucet-a', amount: 4n }],
      introducedCount: 1
    });
    const dryRun = generate(view());

    expect(() =>
      assertCustomEffectsApproved(approval.effects, dryRun, [{ faucetId: 'faucet-a', amount: 6n }])
    ).not.toThrow();
  });

  it('refuses an unattributable generation spend when a spending limit is configured', () => {
    const approval = approve(view({ inputNotesConsumed: 2 }), ['0xr1'], { introducedCount: 0 });
    const dryRun = generate(view({ inputNotesConsumed: 2 }));

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, [], true)).toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, undefined, true)).toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
  });

  it('matches an uncharged row when an unattributable generation spend has no spending limit', () => {
    const approval = approve(view({ inputNotesConsumed: 2 }), ['0xr1'], { introducedCount: 0 });
    const dryRun = generate(view({ inputNotesConsumed: 2 }));

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, undefined)).not.toThrow();
    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, [])).not.toThrow();
  });

  it('does not treat a measured empty spend as unattributable when a spending limit is configured', () => {
    const approval = approve(view({ outgoing: [], inputNotesConsumed: 0 }));
    const dryRun = generate(view({ outgoing: [], inputNotesConsumed: 0 }));

    expect(approval.spends).toEqual([]);
    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, [], true)).not.toThrow();
  });
});

describe('customEffectsDifference', () => {
  it('names no field for equal effects', () => {
    const approval = approve(view());

    expect(customEffectsDifference(approval.effects, approval.effects)).toBeUndefined();
  });
});

/**
 * A typed client access for the check. `dryRun` gives the generation dry run; the hold stays current until
 * `hold.lost` is set, as an eviction during the dry run does.
 */
const checkAccess = (
  dryRun: (hold: { lost: boolean }) => Promise<CustomDryRunBytes>
): { access: CustomEffectsCheckAccess; checked: string[] } => {
  const hold = { lost: false };
  const checked: string[] = [];
  return {
    checked,
    access: {
      accountId: 'account-a',
      dryRun: () => dryRun(hold),
      assertHoldCurrent: where => {
        checked.push(where);
        if (hold.lost) throw new Error(`operation abandoned ${where}`);
      }
    }
  };
};

describe('customEffectsCheckAccess', () => {
  it('preserves the account for the spending-limit recheck', () => {
    const access = customEffectsCheckAccess(
      {} as Parameters<typeof customEffectsCheckAccess>[0],
      'account-a',
      new Uint8Array(),
      {} as Parameters<typeof customEffectsCheckAccess>[3]
    );

    expect(access.accountId).toBe('account-a');
  });
});

describe('verifyPreparedCustomRequest', () => {
  const approvedEffects = (): IApprovedCustomEffects => approve(view()).effects;

  it('checks the hold around the dry run and accepts the approved effects', async () => {
    const effects = approvedEffects();
    const { access, checked } = checkAccess(async () => generate(view()));

    // No spending limit, so an unattributable generation spend still matches the empty charge.
    await verifyPreparedCustomRequest(access, effects, []);

    expect(mockHasSpendingLimits).toHaveBeenCalledWith('account-a');
    expect(checked).toEqual(['before the custom request effects check', 'after the custom request effects dry run']);
  });

  it('refuses an unattributable generation spend when the account has a spending limit', async () => {
    const effects = approvedEffects();
    const { access } = checkAccess(async () => generate(view()));
    mockHasSpendingLimits.mockResolvedValue(true);

    await expect(verifyPreparedCustomRequest(access, effects, [])).rejects.toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
    await expect(verifyPreparedCustomRequest(access, effects, undefined)).rejects.toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
  });

  it('accepts an unattributable generation spend when no spending limit is configured', async () => {
    const effects = approvedEffects();
    const { access } = checkAccess(async () => generate(view()));

    await expect(verifyPreparedCustomRequest(access, effects, undefined)).resolves.toBeUndefined();
    await expect(verifyPreparedCustomRequest(access, effects, [])).resolves.toBeUndefined();
  });

  it('refuses effects that are not the approved ones', async () => {
    const effects = approvedEffects();
    const { access } = checkAccess(async () => generate(view({ outgoing: [{ faucetId: 'faucet-a', amount: 99n }] })));

    await expect(verifyPreparedCustomRequest(access, effects, [{ faucetId: 'faucet-a', amount: 10n }])).rejects.toThrow(
      new CustomTransactionEffectsChangedError('outgoing')
    );
  });

  it('stops after the dry run when the hold was taken away during it', async () => {
    const effects = approvedEffects();
    const { access } = checkAccess(async hold => {
      hold.lost = true;
      return generate(view());
    });

    await expect(verifyPreparedCustomRequest(access, effects, [])).rejects.toThrow(
      'operation abandoned after the custom request effects dry run'
    );
  });
});
