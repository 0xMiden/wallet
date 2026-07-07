import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { hapticLight } from 'lib/mobile/haptics';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import useTippy from 'lib/ui/useTippy';

import CopyButton from './CopyButton';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/analytics', () => ({
  AnalyticsEventCategory: { ButtonPress: 'ButtonPress' },
  useAnalytics: jest.fn()
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: jest.fn()
}));

jest.mock('lib/ui/useTippy', () => ({
  __esModule: true,
  default: jest.fn(() => jest.fn())
}));

const mockUseAnalytics = useAnalytics as jest.Mock;
const mockUseCopyToClipboard = useCopyToClipboard as jest.Mock;
const mockUseTippy = useTippy as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

describe('CopyButton', () => {
  const copy = jest.fn();
  const setCopied = jest.fn();
  const trackEvent = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAnalytics.mockReturnValue({ trackEvent });
    mockUseCopyToClipboard.mockReturnValue({
      fieldRef: { current: null },
      copy,
      copied: false,
      setCopied
    });
  });

  it('copies text and tracks clicks when a test id is provided', () => {
    render(
      <CopyButton
        text="secret"
        type="link"
        small
        rounded="base"
        testID="copy-address"
        testIDProperties={{ surface: 'receive' }}
      >
        Copy
      </CopyButton>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(mockHapticLight).toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('copy-address', AnalyticsEventCategory.ButtonPress, {
      surface: 'receive'
    });
    expect(copy).toHaveBeenCalled();
    expect(screen.getByDisplayValue('secret')).toBeInTheDocument();
  });

  it('uses copied tooltip content and clears copied state when hidden', () => {
    mockUseCopyToClipboard.mockReturnValue({
      fieldRef: { current: null },
      copy,
      copied: true,
      setCopied
    });

    render(<CopyButton text="secret">Copy</CopyButton>);

    const tippyProps = mockUseTippy.mock.calls[0][0];
    expect(tippyProps.content).toBe('copiedHash');

    tippyProps.onHidden();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(setCopied).toHaveBeenCalledWith(false);
    expect(trackEvent).not.toHaveBeenCalled();
  });
});
