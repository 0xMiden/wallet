import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { AnalyticsEventCategory, useAnalytics } from 'lib/analytics';
import { hapticMedium } from 'lib/mobile/haptics';
import { ACCENT_HEX } from 'utils/brand-colors';

import ToggleSwitch from './ToggleSwitch';

// `useAnalytics` and `AnalyticsEventCategory` come from a barrel that pulls in
// SDK-backed modules; mock the analytics surface the component actually uses.
jest.mock('lib/analytics', () => ({
  AnalyticsEventCategory: { Toggle: 'Toggle' },
  useAnalytics: jest.fn()
}));

// Haptics wrap the native Capacitor plugin; stub it so we can assert calls.
jest.mock('lib/mobile/haptics', () => ({
  hapticMedium: jest.fn()
}));

const mockUseAnalytics = useAnalytics as jest.Mock;
const mockHapticMedium = hapticMedium as jest.Mock;

const UNCHECKED_TRACK_COLOR = '#E5E7EB';

/** The outer wrapper is `container.firstChild`; its children are [track, dot, input]. */
const getParts = (container: HTMLElement) => {
  const wrapper = container.firstChild as HTMLElement;
  const [track, dot] = Array.from(wrapper.children) as HTMLElement[];
  const input = screen.getByRole('checkbox') as HTMLInputElement;
  return { wrapper, track, dot, input };
};

describe('ToggleSwitch', () => {
  const trackEvent = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAnalytics.mockReturnValue({ trackEvent });
  });

  it('renders unchecked by default when no `checked` prop is provided', () => {
    const { container } = render(<ToggleSwitch />);
    const { track, dot, input } = getParts(container);

    expect(input).not.toBeChecked();
    expect(track).toHaveStyle({ backgroundColor: UNCHECKED_TRACK_COLOR });
    expect(dot).toHaveStyle({ transform: 'translateX(0)' });
  });

  it('renders unchecked when `checked={false}` is passed explicitly', () => {
    const { container } = render(<ToggleSwitch checked={false} onChange={jest.fn()} />);
    const { track, input } = getParts(container);

    expect(input).not.toBeChecked();
    expect(track).toHaveStyle({ backgroundColor: UNCHECKED_TRACK_COLOR });
  });

  it('renders checked styles (accent track + shifted dot) when `checked` is true', () => {
    const { container } = render(<ToggleSwitch checked onChange={jest.fn()} />);
    const { track, dot, input } = getParts(container);

    expect(input).toBeChecked();
    expect(track).toHaveStyle({ backgroundColor: ACCENT_HEX });
    expect(dot).toHaveStyle({ transform: 'translateX(18px)' });
  });

  it('toggles local state, fires haptics and calls `onChange` on click', () => {
    const onChange = jest.fn();
    const { container } = render(<ToggleSwitch onChange={onChange} />);
    const { input, track } = getParts(container);

    fireEvent.click(input);

    expect(mockHapticMedium).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Local state advanced to checked, repainting the track with the accent color.
    expect(input).toBeChecked();
    expect(track).toHaveStyle({ backgroundColor: ACCENT_HEX });
    // Without a testID, no analytics event is emitted.
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('tracks a Toggle analytics event with properties when a testID is provided', () => {
    const testIDProperties = { surface: 'settings' };
    const { container } = render(<ToggleSwitch testID="haptics-toggle" testIDProperties={testIDProperties} />);
    const { input } = getParts(container);

    fireEvent.click(input);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('haptics-toggle', AnalyticsEventCategory.Toggle, testIDProperties);
  });

  it('works without an `onChange` handler (uncontrolled toggle)', () => {
    // `onChange` is optional; clicking must still flip local state without throwing.
    const { container } = render(<ToggleSwitch />);
    const { input, track } = getParts(container);

    fireEvent.click(input);

    expect(input).toBeChecked();
    expect(track).toHaveStyle({ backgroundColor: ACCENT_HEX });
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('syncs local state to a newly-provided `checked` prop (effect: value branch)', () => {
    const { container, rerender } = render(<ToggleSwitch checked={false} onChange={jest.fn()} />);
    expect(getParts(container).input).not.toBeChecked();

    rerender(<ToggleSwitch checked={true} onChange={jest.fn()} />);

    const { input, track, dot } = getParts(container);
    expect(input).toBeChecked();
    expect(track).toHaveStyle({ backgroundColor: ACCENT_HEX });
    expect(dot).toHaveStyle({ transform: 'translateX(18px)' });
  });

  it('retains prior state when `checked` becomes undefined (effect: fallback branch)', () => {
    const { container, rerender } = render(<ToggleSwitch checked onChange={jest.fn()} />);
    expect(getParts(container).input).toBeChecked();

    // Prop drops to undefined: the effect's `checked ?? prevChecked` keeps the previous value.
    rerender(<ToggleSwitch checked={undefined} onChange={jest.fn()} />);

    expect(getParts(container).input).toBeChecked();
  });

  it('forwards a ref to the underlying checkbox input', () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<ToggleSwitch ref={ref} />);

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toHaveAttribute('type', 'checkbox');
  });

  it('applies `containerClassName`, `className` and spreads remaining props (incl. `errored`)', () => {
    const { container } = render(
      <ToggleSwitch
        containerClassName="my-container"
        className="my-input"
        errored
        id="toggle-id"
        name="toggle-name"
        disabled
      />
    );
    const { wrapper, input } = getParts(container);

    expect(wrapper).toHaveClass('my-container');
    expect(input).toHaveClass('my-input');
    expect(input).toHaveAttribute('id', 'toggle-id');
    expect(input).toHaveAttribute('name', 'toggle-name');
    expect(input).toBeDisabled();
  });
});
