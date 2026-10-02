import { undoFailedSetup } from './failed-setup';

const mockClearStorage = jest.fn();
jest.mock('lib/miden/reset', () => ({ clearStorage: (...args: unknown[]) => mockClearStorage(...args) }));

describe('undoFailedSetup', () => {
  beforeEach(() => {
    mockClearStorage.mockReset().mockResolvedValue(undefined);
  });

  it('retires the vault before clearing storage', async () => {
    const order: string[] = [];
    const vault = { retire: jest.fn(() => order.push('retire')) };
    mockClearStorage.mockImplementation(async () => {
      order.push('clear');
    });

    await undoFailedSetup(vault, 'Actions.registerNewWallet');

    expect(order).toEqual(['retire', 'clear']);
  });

  it('clears with clearStorage(false) and no keep argument, so the default keep list applies', async () => {
    await undoFailedSetup({ retire: jest.fn() }, 'Actions.registerNewWallet');

    expect(mockClearStorage).toHaveBeenCalledWith(false);
  });

  it('swallows and logs a failed clear', async () => {
    const clearError = new Error('storage unavailable');
    mockClearStorage.mockRejectedValueOnce(clearError);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(undoFailedSetup({ retire: jest.fn() }, 'Actions.registerImportedWallet')).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Actions.registerImportedWallet] could not undo a failed setup:',
      clearError
    );
    consoleErrorSpy.mockRestore();
  });

  it('still clears storage when no vault was spawned', async () => {
    await undoFailedSetup(undefined, 'Vault.spawn');

    expect(mockClearStorage).toHaveBeenCalledWith(false);
  });
});
