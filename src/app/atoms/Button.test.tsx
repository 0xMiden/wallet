import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { AnalyticsEventCategory } from 'lib/analytics';
import { hapticLight } from 'lib/mobile/haptics';

import { Button } from './Button';

// Mock analytics
const mockTrackEvent = jest.fn();
jest.mock('lib/analytics', () => ({
  useAnalytics: () => ({
    trackEvent: mockTrackEvent
  }),
  AnalyticsEventCategory: {
    ButtonPress: 'ButtonPress'
  }
}));

// Mock haptics
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

describe('Button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders button element', () => {
    render(<Button>Click me</Button>);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('triggers haptic feedback on click', () => {
    render(<Button>Click</Button>);

    fireEvent.click(screen.getByRole('button'));

    expect(hapticLight).toHaveBeenCalled();
  });

  it('calls onClick handler when clicked', () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Click</Button>);

    fireEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('tracks analytics event when testID is provided', () => {
    render(<Button testID="my-button">Click</Button>);

    fireEvent.click(screen.getByRole('button'));

    expect(mockTrackEvent).toHaveBeenCalledWith('my-button', AnalyticsEventCategory.ButtonPress, undefined);
  });

  it('tracks analytics with properties when provided', () => {
    const testIDProperties = { action: 'submit' };
    render(
      <Button testID="submit-button" testIDProperties={testIDProperties}>
        Submit
      </Button>
    );

    fireEvent.click(screen.getByRole('button'));

    expect(mockTrackEvent).toHaveBeenCalledWith('submit-button', AnalyticsEventCategory.ButtonPress, testIDProperties);
  });

  it('does not track analytics when testID is not provided', () => {
    render(<Button>Click</Button>);

    fireEvent.click(screen.getByRole('button'));

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('forwards ref to button element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Click</Button>);

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.tagName).toBe('BUTTON');
  });

  it('passes through native button props', () => {
    render(
      <Button type="submit" disabled className="custom-class">
        Submit
      </Button>
    );

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toBeDisabled();
    expect(button).toHaveClass('custom-class');
  });

  it('does not call onClick if not provided', () => {
    render(<Button>Click</Button>);

    // Should not throw when clicked without an onClick handler.
    const button = screen.getByRole('button');
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});
