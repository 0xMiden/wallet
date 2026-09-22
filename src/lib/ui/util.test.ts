import { clearClipboard, cn } from './util';

describe('ui utilities', () => {
  it('clears the clipboard', () => {
    const writeText = jest.fn();
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    clearClipboard();

    expect(writeText).toHaveBeenCalledWith('');
  });

  // The stub above returns undefined, not a promise, which is why the implementation awaits
  // inside try/catch rather than chaining .catch onto writeText('') - that would be undefined.catch.

  it('does not throw where the Clipboard API is absent, so a paste handler survives it', async () => {
    const stub = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    delete (window.navigator as { clipboard?: unknown }).clipboard;

    try {
      await expect(clearClipboard()).resolves.toBeUndefined();
    } finally {
      if (stub) Object.defineProperty(window.navigator, 'clipboard', stub);
    }
  });

  // The half that matters most: a browser refusing the write leaves the secret on the clipboard.
  // `clearClipboard` returns its settled promise so that outcome is observable at all.
  it('reports a refused write instead of leaving it unhandled', async () => {
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    const stub = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(clearClipboard()).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      if (stub) Object.defineProperty(window.navigator, 'clipboard', stub);
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
