/**
 * The rule for a dApp custom (`execute`) transaction: the wallet proposes it only when the effects of its
 * generation-time dry run equal the effects that the user approved, and the spending-limit charge is the
 * generation-time value.
 */
import type { ViewNote } from 'app/confirm/decode';

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
  viewConsumedNotes?: ViewNote[];
  createdNotes?: ViewNote[];
}

/** The decoded result of each dry run, by its bytes. The decoders themselves are covered by `decode.test.ts`. */
const mockViews = new Map<string, TestView>();
const mockRecipients = new Map<string, string[]>();
const mockToHoldingsView = jest.fn();
const mockExecuteApprovalOf = jest.fn();
const bytesOf = (result: { summaryBytes?: string; executedBytes?: string }) =>
  result.summaryBytes ?? result.executedBytes ?? '';

jest.mock('app/confirm/decode', () => {
  const actual = jest.requireActual('app/confirm/decode');
  return {
    ...actual,
    simulatedBytesToView: (result: { summaryBytes?: string; executedBytes?: string }) => mockViews.get(bytesOf(result)),
    simulatedOutputRecipients: (result: { summaryBytes?: string; executedBytes?: string }) =>
      mockRecipients.get(bytesOf(result)),
    toHoldingsView: (view: TestView, introducedNoteIds: readonly string[]) => {
      mockToHoldingsView(view, introducedNoteIds);
      return actual.toHoldingsView(view, introducedNoteIds);
    }
  };
});

jest.mock('./proposal-effect-guard', () => {
  const actual = jest.requireActual('./proposal-effect-guard');
  return {
    ...actual,
    get executeApprovalOf() {
      return mockExecuteApprovalOf.mockImplementation(actual.executeApprovalOf);
    }
  };
});

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

const viewNote = (id: string, amounts: { faucetId: string; amount: bigint }[] = []): ViewNote => ({
  id,
  amounts,
  nfts: []
});

/** By default the request consumes the one note it carries, `0xcarried`, and sends 10 of faucet A in `0xsent`. */
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
  viewConsumedNotes: [viewNote('0xcarried')],
  createdNotes: [viewNote('0xsent', [{ faucetId: 'faucet-a', amount: 10n }])],
  ...overrides
});

/** The approval dry run under `approved`, with the consumed notes the request introduced. */
const approve = (
  approvedView: TestView,
  recipients: string[] = ['0xr1'],
  introducedNoteIds: string[] = ['0xcarried'],
  shape: 'summary' | 'executed' = 'summary'
) => {
  mockViews.set('approved', approvedView);
  mockRecipients.set('approved', recipients);
  const approval = approveCustomSimulation(
    shape === 'summary'
      ? { summaryBytes: 'approved', introducedNoteIds }
      : { executedBytes: 'approved', introducedNoteIds }
  );
  if (approval === undefined) throw new Error('the approval dry run gave no result');
  return approval;
};

/**
 * The approved effects of a row queued before approvals recorded note ids: the spending-limit provenance in their
 * place, and neither id list.
 */
const legacyEffects = (
  approvedView: TestView,
  provenance: { introducedCredit?: { faucetId: string; amount: bigint }[]; introducedCount?: number },
  shape: 'summary' | 'executed' = 'summary'
): IApprovedCustomEffects => {
  const {
    introducedNoteIds: _ids,
    approvedOutputNoteIds: _outputs,
    ...effects
  } = approve(approvedView, ['0xr1'], [], shape).effects;
  return { ...effects, ...provenance };
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
  mockToHoldingsView.mockClear();
  mockExecuteApprovalOf.mockClear();
  mockHasSpendingLimits.mockReset();
  mockHasSpendingLimits.mockResolvedValue(false);
});

describe('approveCustomSimulation', () => {
  it('records the movement per canonical faucet, the recipients, the note counts and the note ids', () => {
    const approval = approve(
      view({
        outgoing: [
          { faucetId: 'faucet-b', amount: 2n },
          { faucetId: 'faucet-a', amount: 10n },
          { faucetId: 'FAUCET-A', amount: 5n }
        ],
        incoming: [{ faucetId: 'faucet-c', amount: 7n }],
        outgoingNfts: [{ faucetId: 'nft-faucet', assetId: '0xaa' }],
        fee: { faucetId: 'FAUCET-NATIVE', amount: 3n },
        createdNotes: [viewNote('0xsent'), viewNote('0xsent-2')]
      }),
      ['0xr2', '0xr1'],
      ['0xCARRIED', '0xcarried']
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
      introducedNoteIds: ['0xcarried'],
      approvedOutputNoteIds: ['0xsent', '0xsent-2']
    });
  });

  it('measures what leaves from the holdings: a summary consuming a held 1000 X and sending 1050 X', () => {
    const approval = approve(
      view({
        outgoing: [{ faucetId: 'faucet-x', amount: 50n }],
        viewConsumedNotes: [viewNote('0xheld', [{ faucetId: 'faucet-x', amount: 1000n }])],
        createdNotes: [viewNote('0xsent', [{ faucetId: 'faucet-x', amount: 1050n }])]
      }),
      ['0xr1'],
      []
    );

    expect(approval.view.outgoing).toEqual([{ faucetId: 'faucet-x', amount: 1050n }]);
    expect(approval.view.heldNotesSpent).toBe(1);
    expect(approval.signing.approvedOutflow).toEqual([{ faucetId: 'faucet-x', amount: 1050n }]);
    expect(approval.spends).toEqual([{ faucetId: 'faucet-x', amount: 1050n }]);
    // The effects compared at generation stay the dry run's own figures.
    expect(approval.effects.outgoing).toEqual([{ faucetId: 'faucet-x', amount: 50n }]);
  });

  it('measures the dry run holdings once for the sheet, the allowance and the charge', () => {
    const raw = view();
    const approval = approve(raw);
    const measured = mockExecuteApprovalOf.mock.results[0]?.value;

    expect(mockExecuteApprovalOf).toHaveBeenCalledTimes(1);
    expect(mockExecuteApprovalOf).toHaveBeenCalledWith(raw, ['0xcarried']);
    expect(approval.view).toBe(measured.view);
    expect(approval.signing).toBe(measured.signing);
    expect(mockToHoldingsView).toHaveBeenCalledTimes(1);
    expect(approval.spends).toEqual(approval.signing.approvedOutflow);
    expect(approval.spends).not.toBe(approval.signing.approvedOutflow);
  });

  it('does not credit an introduced note again in a summary net outflow', () => {
    const approval = approve(
      view({ viewConsumedNotes: [viewNote('0xcarried', [{ faucetId: 'faucet-a', amount: 4n }])] })
    );

    expect(approval.spends).toEqual([{ faucetId: 'faucet-a', amount: 10n }]);
    expect(approval.signing.approvedOutflow).toEqual([{ faucetId: 'faucet-a', amount: 10n }]);
  });

  it('credits an executed gross outflow with only the notes the request introduced', () => {
    const approval = approve(
      view({
        incoming: [{ faucetId: 'faucet-a', amount: 4n }],
        viewConsumedNotes: [viewNote('0xcarried', [{ faucetId: 'faucet-a', amount: 4n }])]
      }),
      ['0xr1'],
      ['0xcarried'],
      'executed'
    );

    expect(approval.spends).toEqual([{ faucetId: 'faucet-a', amount: 6n }]);
    expect(approval.signing.approvedOutflow).toEqual([{ faucetId: 'faucet-a', amount: 6n }]);
  });

  it('counts every consumed note as held when the dry run gave no introduced ids', () => {
    mockViews.set(
      'approved',
      view({ viewConsumedNotes: [viewNote('0xcarried', [{ faucetId: 'faucet-a', amount: 4n }])] })
    );
    mockRecipients.set('approved', ['0xr1']);

    const approval = approveCustomSimulation({ summaryBytes: 'approved' });

    expect(approval?.effects.introducedNoteIds).toEqual([]);
    expect(approval?.spends).toEqual([{ faucetId: 'faucet-a', amount: 14n }]);
  });

  it('throws for a dry run that spends a held note whose assets cannot be read', () => {
    mockViews.set('approved', view({ viewConsumedNotes: [{ id: '0xheld', amounts: [], nfts: [], opaque: true }] }));
    mockRecipients.set('approved', ['0xr1']);

    expect(() => approveCustomSimulation({ summaryBytes: 'approved', introducedNoteIds: [] })).toThrow(
      'a held note does not list its assets'
    );
  });

  it('throws for a view that does not list its notes', () => {
    const { viewConsumedNotes: _consumed, createdNotes: _created, ...unlisted } = view();
    mockViews.set('approved', unlisted);
    mockRecipients.set('approved', ['0xr1']);

    expect(() => approveCustomSimulation({ summaryBytes: 'approved', introducedNoteIds: ['0xcarried'] })).toThrow(
      'the view does not list the notes it creates'
    );
    expect(mockToHoldingsView).not.toHaveBeenCalled();
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
    const approval = approve(view());
    const dryRun = generate(view());

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, [{ faucetId: 'faucet-a', amount: 1n }])).toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
  });

  it('charges with the note ids the approval recorded, which the generation dry run cannot identify again', () => {
    const executed = view({
      incoming: [{ faucetId: 'faucet-a', amount: 4n }],
      viewConsumedNotes: [viewNote('0xcarried', [{ faucetId: 'faucet-a', amount: 4n }])]
    });
    const approval = approve(executed, ['0xr1'], ['0xcarried'], 'executed');
    mockViews.set('generated', executed);
    mockRecipients.set('generated', ['0xr1']);
    const dryRun = { executedBytes: 'generated' };

    expect(() =>
      assertCustomEffectsApproved(approval.effects, dryRun, [{ faucetId: 'faucet-a', amount: 6n }])
    ).not.toThrow();
    expect(() =>
      assertCustomEffectsApproved(approval.effects, dryRun, [{ faucetId: 'faucet-a', amount: 10n }])
    ).toThrow(new CustomTransactionEffectsChangedError('spentAssetTotals'));
  });

  it('charges a held note at generation as the approval did: 1050 matches, the net 50 does not', () => {
    const spendsHeld = view({
      outgoing: [{ faucetId: 'faucet-x', amount: 50n }],
      viewConsumedNotes: [viewNote('0xheld', [{ faucetId: 'faucet-x', amount: 1000n }])],
      createdNotes: [viewNote('0xsent', [{ faucetId: 'faucet-x', amount: 1050n }])]
    });
    const approval = approve(spendsHeld, ['0xr1'], []);
    const dryRun = generate(spendsHeld);

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, approval.spends, true)).not.toThrow();
    expect(() =>
      assertCustomEffectsApproved(approval.effects, dryRun, [{ faucetId: 'faucet-x', amount: 50n }], true)
    ).toThrow(new CustomTransactionEffectsChangedError('spentAssetTotals'));
  });

  it('refuses a generation dry run whose held note can no longer be measured', () => {
    const approval = approve(view(), ['0xr1'], []);
    const dryRun = generate(view({ viewConsumedNotes: [{ id: '0xcarried', amounts: [], nfts: [], opaque: true }] }));

    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, approval.spends)).toThrow(
      new CustomTransactionEffectsChangedError('spentAssetTotals')
    );
  });

  it('does not treat a measured empty spend as unattributable when a spending limit is configured', () => {
    const approval = approve(view({ outgoing: [], inputNotesConsumed: 0, viewConsumedNotes: [], createdNotes: [] }));
    const dryRun = generate(view({ outgoing: [], inputNotesConsumed: 0, viewConsumedNotes: [], createdNotes: [] }));

    expect(approval.spends).toEqual([]);
    expect(() => assertCustomEffectsApproved(approval.effects, dryRun, [], true)).not.toThrow();
  });

  // A row queued before approvals recorded note ids keeps the charge it was admitted with.
  describe('for a row queued before approvals recorded note ids', () => {
    it('charges a summary its net outflow, without crediting the carried note again', () => {
      const effects = legacyEffects(view(), {
        introducedCredit: [{ faucetId: 'faucet-a', amount: 4n }],
        introducedCount: 1
      });
      const dryRun = generate(view());

      expect(() => assertCustomEffectsApproved(effects, dryRun, [{ faucetId: 'faucet-a', amount: 10n }])).not.toThrow();
    });

    it('charges an executed result its gross outflow less the recorded credit', () => {
      const effects = legacyEffects(
        view(),
        { introducedCredit: [{ faucetId: 'faucet-a', amount: 4n }], introducedCount: 1 },
        'executed'
      );
      mockViews.set('generated', view());
      mockRecipients.set('generated', ['0xr1']);

      expect(() =>
        assertCustomEffectsApproved(effects, { executedBytes: 'generated' }, [{ faucetId: 'faucet-a', amount: 6n }])
      ).not.toThrow();
    });

    it('refuses an unattributable generation spend when a spending limit is configured', () => {
      const effects = legacyEffects(view({ inputNotesConsumed: 2 }), { introducedCount: 0 });
      const dryRun = generate(view({ inputNotesConsumed: 2 }));

      expect(() => assertCustomEffectsApproved(effects, dryRun, [], true)).toThrow(
        new CustomTransactionEffectsChangedError('spentAssetTotals')
      );
      expect(() => assertCustomEffectsApproved(effects, dryRun, undefined, true)).toThrow(
        new CustomTransactionEffectsChangedError('spentAssetTotals')
      );
    });

    it('matches an uncharged row when an unattributable generation spend has no spending limit', () => {
      const effects = legacyEffects(view({ inputNotesConsumed: 2 }), { introducedCount: 0 });
      const dryRun = generate(view({ inputNotesConsumed: 2 }));

      expect(() => assertCustomEffectsApproved(effects, dryRun, undefined)).not.toThrow();
      expect(() => assertCustomEffectsApproved(effects, dryRun, [])).not.toThrow();
    });
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
  const charged = [{ faucetId: 'faucet-a', amount: 10n }];
  /** A row queued before approvals recorded note ids, whose summary consumed a note it did not introduce. */
  const unattributable = (): IApprovedCustomEffects => legacyEffects(view(), { introducedCount: 0 });

  it('checks the hold around the dry run and accepts the approved effects', async () => {
    const effects = approvedEffects();
    const { access, checked } = checkAccess(async () => generate(view()));

    await verifyPreparedCustomRequest(access, effects, charged);

    expect(mockHasSpendingLimits).toHaveBeenCalledWith('account-a');
    expect(checked).toEqual(['before the custom request effects check', 'after the custom request effects dry run']);
  });

  it('refuses an unattributable generation spend when the account has a spending limit', async () => {
    const effects = unattributable();
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
    const effects = unattributable();
    const { access } = checkAccess(async () => generate(view()));

    await expect(verifyPreparedCustomRequest(access, effects, undefined)).resolves.toBeUndefined();
    await expect(verifyPreparedCustomRequest(access, effects, [])).resolves.toBeUndefined();
  });

  it('refuses effects that are not the approved ones', async () => {
    const effects = approvedEffects();
    const { access } = checkAccess(async () => generate(view({ outgoing: [{ faucetId: 'faucet-a', amount: 99n }] })));

    await expect(verifyPreparedCustomRequest(access, effects, charged)).rejects.toThrow(
      new CustomTransactionEffectsChangedError('outgoing')
    );
  });

  it('stops after the dry run when the hold was taken away during it', async () => {
    const effects = approvedEffects();
    const { access } = checkAccess(async hold => {
      hold.lost = true;
      return generate(view());
    });

    await expect(verifyPreparedCustomRequest(access, effects, charged)).rejects.toThrow(
      'operation abandoned after the custom request effects dry run'
    );
  });
});
