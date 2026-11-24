import { isDesktop } from 'lib/platform';

import { setWindowContentProtected } from './content-protection';

const mockInvoke = jest.fn();

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args)
}));

jest.mock('lib/platform', () => ({
  isDesktop: jest.fn()
}));

const mockIsDesktop = jest.mocked(isDesktop);

describe('setWindowContentProtected', () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(undefined);
    mockIsDesktop.mockReturnValue(true);
  });

  it('asks the main window to exclude itself from capture', async () => {
    await setWindowContentProtected(true);
    expect(mockInvoke).toHaveBeenCalledWith('set_content_protection', { enabled: true });
  });

  it('does nothing off desktop', async () => {
    mockIsDesktop.mockReturnValue(false);
    await setWindowContentProtected(true);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('propagates a rejection from the command', async () => {
    mockInvoke.mockRejectedValue(new Error('Main window not found'));
    await expect(setWindowContentProtected(false)).rejects.toThrow('Main window not found');
  });
});
