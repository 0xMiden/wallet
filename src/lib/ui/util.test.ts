import { clearClipboard, cn } from './util';

const mockClipboardWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

describe('ui utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wipes the clipboard through @capacitor/clipboard and resolves true', async () => {
    mockClipboardWrite.mockResolvedValue(undefined);

    await expect(clearClipboard()).resolves.toBe(true);

    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: '' });
  });

  // The half that matters most: a refused write leaves the secret on the clipboard, so a caller
  // has to be able to tell success from failure instead of the promise merely settling either way.
  it('resolves false and logs when the write rejects, never rejecting itself', async () => {
    mockClipboardWrite.mockRejectedValue(new Error('denied'));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(clearClipboard()).resolves.toBe(false);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('merges conditional and conflicting Tailwind classes', () => {
    expect(cn('px-2 text-sm', false && 'hidden', { block: true }, 'px-4')).toBe('text-sm block px-4');
  });

  it('keeps a type style beside a colour class', () => {
    expect(cn('text-title-page', 'text-ink')).toBe('text-title-page text-ink');
    expect(cn('text-ink', 'text-label')).toBe('text-ink text-label');
  });

  it('lets a type style replace an ad-hoc size, weight, leading and family, and a later size replace it', () => {
    expect(cn('font-heading text-sm font-bold leading-5', 'text-body')).toBe('text-body');
    expect(cn('text-body', 'text-sm')).toBe('text-sm');
    expect(cn('text-caption', 'text-value')).toBe('text-value');
  });

  it('keeps a weight or leading modifier after a type style', () => {
    expect(cn('text-badge', 'font-semibold')).toBe('text-badge font-semibold');
    expect(cn('text-display', 'leading-none')).toBe('text-display leading-none');
  });
});
