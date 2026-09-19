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
