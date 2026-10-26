import { findFailedHotKeyRotations, markRotationCompleted } from './hot-key-rotation-residual';
import { ITransactionStatus } from '../db/types';

interface MockRow {
  id: string;
  type: string;
  accountId: string;
  status: ITransactionStatus;
  initiatedAt: number;
  extraInputs: Record<string, unknown>;
  restoredFromBackup?: boolean;
  displayMessage?: string;
  displayIcon?: string;
  completedAt?: number;
  stage?: string;
  error?: string;
  rawError?: string;
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

const rotationRow = (id: string, initiatedAt: number, overrides: Partial<MockRow> = {}): MockRow => ({
  id,
  type: 'replace-hot-key',
  accountId: 'acc-1',
  status: ITransactionStatus.Failed,
  initiatedAt,
  extraInputs: { newHotPublicKey: `key-${id}` },
  ...overrides
});

beforeEach(() => {
  mockRows.length = 0;
});

describe('findFailedHotKeyRotations (#1233)', () => {
  it("returns only this account's Failed rotations that name a new key, newest first", async () => {
    mockRows.push(
      rotationRow('older', 100),
      rotationRow('newer', 200),
      rotationRow('completed', 300, { status: ITransactionStatus.Completed }),
      rotationRow('no-key', 400, { extraInputs: {} }),
      rotationRow('other-account', 500, { accountId: 'acc-2' }),
      rotationRow('switch', 600, { type: 'switch-guardian' }),
      rotationRow('restored', 700, { restoredFromBackup: true })
    );

    await expect(findFailedHotKeyRotations('acc-1_suffix')).resolves.toEqual([
      { id: 'newer', newHotPublicKey: 'key-newer' },
      { id: 'older', newHotPublicKey: 'key-older' }
    ]);
  });

  it('skips a rotation the node discarded (#1233)', async () => {
    mockRows.push(
      rotationRow('row-discarded', 100, { extraInputs: { newHotPublicKey: 'k-discarded', nodeDiscarded: true } }),
      rotationRow('row-open', 200, { extraInputs: { newHotPublicKey: 'k-open' } })
    );

    await expect(findFailedHotKeyRotations('acc-1')).resolves.toEqual([{ id: 'row-open', newHotPublicKey: 'k-open' }]);
  });
});

describe('markRotationCompleted (#1233)', () => {
  it('turns that Failed rotation Completed, as completion writes it minus the result fields', async () => {
    mockRows.push(
      rotationRow('rot', 100, {
        displayMessage: 'Failed',
        displayIcon: 'FAILED',
        error: 'Guardian replace-hot-key 0xtx was submitted, but the node has not confirmed it; not completing it.',
        rawError: 'raw'
      })
    );

    await markRotationCompleted('rot');

    const row = mockRows[0]!;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Everyday key rotated');
    expect(row.displayIcon).toBe('DEFAULT');
    expect(row.stage).toBe('complete');
    expect(row.completedAt).toEqual(expect.any(Number));
    expect(row).not.toHaveProperty('error');
    expect(row).not.toHaveProperty('rawError');
  });

  it('leaves a Completed rotation and a switch row with those ids untouched', async () => {
    const completed = rotationRow('done', 100, { status: ITransactionStatus.Completed, displayMessage: 'kept' });
    const switchRow = rotationRow('switch', 100, { type: 'switch-guardian', displayIcon: 'FAILED', error: 'kept' });
    mockRows.push(completed, switchRow);
    const before = mockRows.map(row => ({ ...row }));

    await markRotationCompleted('done');
    await markRotationCompleted('switch');

    expect(mockRows).toEqual(before);
  });
});
