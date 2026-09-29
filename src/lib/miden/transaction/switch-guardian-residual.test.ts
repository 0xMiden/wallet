import { clearLocalStateNotSaved, findUnsavedSwitchRow } from './switch-guardian-residual';

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
      previousGuardianEndpoint: OLD
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
