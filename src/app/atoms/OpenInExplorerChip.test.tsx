import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import useTippy from 'lib/ui/useTippy';

import OpenInExplorerChip from './OpenInExplorerChip';
import { OpenInExplorerChipSelectors } from './OpenInExplorerChip.selectors';

jest.mock('lib/analytics', () => ({
  AnalyticsEventCategory: { ButtonPress: 'ButtonPress' },
  useAnalytics: jest.fn()
}));

jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn())
}));

const mockUseAnalytics = useAnalytics as jest.Mock;
const mockUseTippy = useTippy as jest.Mock;

describe('OpenInExplorerChip', () => {
  const trackEvent = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAnalytics.mockReturnValue({ trackEvent });
  });

  it('renders the explorer link with default props and tracks clicks', () => {
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

    expect(trackEvent).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith(
      OpenInExplorerChipSelectors.ViewOnBlockExplorerLink,
      AnalyticsEventCategory.ButtonPress
    );
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
