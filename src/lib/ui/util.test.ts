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
});
