import { clearLocalStateNotSaved, findUnsavedSwitchRow, markSwitchDeltaPushed } from './switch-guardian-residual';

interface MockRow {
  id: string;
  type: string;
  accountId: string;
  initiatedAt: number;
  extraInputs: Record<string, unknown>;
}

const mockRows: MockRow[] = [];
jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: (predicate: (row: MockRow) => boolean) => ({
      toArray: async () => mockRows.filter(predicate),
      modify: async (fn: (row: MockRow) => void) => {
        mockRows.filter(predicate).forEach(fn);
      }
    }),
    where: (query: { id: string }) => ({
      modify: async (fn: (row: MockRow) => void) => {
        mockRows.filter(row => row.id === query.id).forEach(fn);
      }
    })
  }
}));
jest.mock('../sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => (a.split('_')[0] ?? a) === (b.split('_')[0] ?? b)
}));

const NEW = 'https://new.guardian.test';
const OLD = 'https://old.guardian.test';

const switchRow = (id: string, initiatedAt: number, extraInputs: Record<string, unknown>, accountId = 'acc-1') => ({
  id,
  type: 'switch-guardian',
  accountId,
  initiatedAt,
  extraInputs: { newGuardianEndpoint: NEW, previousGuardianEndpoint: OLD, ...extraInputs }
});

beforeEach(() => {
  mockRows.length = 0;
});

describe('findUnsavedSwitchRow (#1233)', () => {
  it('finds the newest flagged switch to this endpoint for the account, with its previous endpoint', async () => {
    mockRows.push(
      switchRow('older', 100, { localStateNotSaved: true, previousGuardianEndpoint: 'https://older.guardian.test' }),
      switchRow('newer', 200, { localStateNotSaved: true })
    );

    await expect(findUnsavedSwitchRow('acc-1_suffix', NEW)).resolves.toEqual({
      id: 'newer',
      previousGuardianEndpoint: OLD,
      switchedDirectly: false,
      switchProposalId: undefined,
      switchDeltaPushed: false
    });
  });

  it('returns the proposal whose delta the landed push did or did not deliver', async () => {
    mockRows.push(
      switchRow('pushed', 100, { localStateNotSaved: true, switchProposalId: 'prop', switchDeltaPushed: true })
    );

    await expect(findUnsavedSwitchRow('acc-1', NEW)).resolves.toMatchObject({
      switchProposalId: 'prop',
      switchDeltaPushed: true
    });

    mockRows.length = 0;
    mockRows.push(
      switchRow('lost', 100, { localStateNotSaved: true, switchProposalId: 'prop', switchDeltaPushed: false })
    );

    await expect(findUnsavedSwitchRow('acc-1', NEW)).resolves.toMatchObject({
      switchProposalId: 'prop',
      switchDeltaPushed: false
    });
  });

  it('reports a switch that took the direct path', async () => {
    mockRows.push(switchRow('direct', 100, { localStateNotSaved: true, switchedDirectly: true }));

    await expect(findUnsavedSwitchRow('acc-1', NEW)).resolves.toEqual({
      id: 'direct',
      previousGuardianEndpoint: OLD,
      switchedDirectly: true,
      switchProposalId: undefined,
      switchDeltaPushed: false
    });
  });

  it.each([
    ['a switch that saved its state', switchRow('saved', 100, { localStateNotSaved: false })],
    ['another account', switchRow('other', 100, { localStateNotSaved: true }, 'acc-2')],
    [
      'a switch to another endpoint',
      switchRow('elsewhere', 100, { localStateNotSaved: true, newGuardianEndpoint: 'https://third.test' })
    ],
    [
      'a row with no previous endpoint',
      switchRow('legacy', 100, { localStateNotSaved: true, previousGuardianEndpoint: undefined })
    ]
  ])('ignores %s', async (_label, row) => {
    mockRows.push(row);

    await expect(findUnsavedSwitchRow('acc-1', NEW)).resolves.toBeUndefined();
  });
});

describe('markSwitchDeltaPushed (#1233)', () => {
  it('records the re-pushed delta on that row only', async () => {
    mockRows.push(
      switchRow('switch-row', 100, { localStateNotSaved: true, switchProposalId: 'prop', switchDeltaPushed: false }),
      switchRow('other-row', 100, { localStateNotSaved: true, switchProposalId: 'prop', switchDeltaPushed: false })
    );

    await markSwitchDeltaPushed('switch-row');

    expect(mockRows[0]!.extraInputs).toMatchObject({ switchDeltaPushed: true, localStateNotSaved: true });
    expect(mockRows[1]!.extraInputs.switchDeltaPushed).toBe(false);
  });
});

describe('clearLocalStateNotSaved (#1233)', () => {
  it('clears the flag on the matching rows only', async () => {
    mockRows.push(
      switchRow('mine', 100, { localStateNotSaved: true }),
      switchRow('theirs', 100, { localStateNotSaved: true }, 'acc-2')
    );

    await clearLocalStateNotSaved('acc-1', NEW);

    expect(mockRows[0]!.extraInputs).toMatchObject({ localStateNotSaved: false, previousGuardianEndpoint: OLD });
    expect(mockRows[1]!.extraInputs.localStateNotSaved).toBe(true);
  });
});
