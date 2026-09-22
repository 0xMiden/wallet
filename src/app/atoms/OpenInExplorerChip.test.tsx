import React from 'react';

import { render, screen } from '@testing-library/react';

import useTippy from 'lib/ui/useTippy';

import OpenInExplorerChip from './OpenInExplorerChip';

jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn())
}));

const mockUseTippy = useTippy as jest.Mock;

describe('OpenInExplorerChip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the explorer link with default props', () => {
    render(<OpenInExplorerChip baseUrl="https://explorer.test" hash="0xabc" />);

    const link = screen.getByRole('link');

    // href is composed from baseUrl + hash, opens safely in a new tab.
    expect(link).toHaveAttribute('href', 'https://explorer.test/0xabc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // Default branches: bgShade=100, textShade=600, rounded='sm'.
    expect(link).toHaveClass('bg-gray-100', 'hover:bg-gray-100');
    expect(link).toHaveClass('text-black');
    expect(link).toHaveClass('rounded-sm');
    expect(link).not.toHaveClass('rounded');

    // The tippy ref callback is used on the anchor.
    expect(mockUseTippy).toHaveBeenCalledTimes(1);
    const tippyProps = mockUseTippy.mock.calls[0][0];
    expect(tippyProps).toEqual({
      trigger: 'mouseenter',
      hideOnClick: false,
      content: 'View on block explorer',
      animation: 'shift-away-subtle'
    });

    // Icon is rendered inside the anchor.
    expect(link.querySelector('svg')).toBeInTheDocument();
  });

  it('applies bgShade=200, textShade=500, rounded="base" and a custom className', () => {
    render(
      <OpenInExplorerChip
        baseUrl="https://explorer.test"
        hash="deadbeef"
        bgShade={200}
        textShade={500}
        rounded="base"
        className="custom-class"
      />
    );

    const link = screen.getByRole('link');

    expect(link).toHaveClass('bg-chip-bg', 'hover:bg-gray-100');
    expect(link).toHaveClass('text-text-muted');
    expect(link).toHaveClass('rounded');
    expect(link).not.toHaveClass('rounded-sm');
    expect(link).toHaveClass('custom-class');
  });

  it('applies textShade=700 (black text) branch', () => {
    render(<OpenInExplorerChip baseUrl="https://explorer.test" hash="feedface" textShade={700} />);

    const link = screen.getByRole('link');
    expect(link).toHaveClass('text-black');
  });
});
