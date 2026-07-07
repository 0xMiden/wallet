import React from 'react';

import { render, screen } from '@testing-library/react';
import tippy from 'tippy.js';

import useTippy from './useTippy';

jest.mock('lib/platform', () => ({
  isExtension: () => true
}));

jest.mock('tippy.js', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    setProps: jest.fn(),
    destroy: jest.fn()
  }))
}));

function Harness({ content }: { content: string }) {
  const ref = useTippy<HTMLButtonElement>({ content, duration: 120, animation: 'fade' });
  return <button ref={ref}>Target</button>;
}

describe('useTippy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates, updates, and destroys an extension-safe tippy instance', () => {
    const instance = { setProps: jest.fn(), destroy: jest.fn() };
    (tippy as jest.Mock).mockReturnValue(instance);

    const { rerender, unmount } = render(<Harness content="Copy" />);

    expect(tippy).toHaveBeenCalledWith(
      screen.getByRole('button', { name: 'Target' }),
      expect.objectContaining({ content: 'Copy', duration: 0, animation: false })
    );

    rerender(<Harness content="Copied" />);

    expect(instance.setProps).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Copied', duration: 0, animation: false })
    );

    unmount();

    expect(instance.destroy).toHaveBeenCalled();
  });
});
