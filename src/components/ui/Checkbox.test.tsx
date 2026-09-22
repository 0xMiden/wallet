import React, { useState } from 'react';

import { createEvent, fireEvent, render, screen } from '@testing-library/react';

import { reducedMotionTransition, springs, tabBarMotion } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

import { CheckboxIndicator, CheckboxRow } from './Checkbox';

let mockReduce = false;

// motion.* render as plain elements that surface their animate target, transition and press.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(
      (
        {
          initial: _initial,
          animate,
          transition,
          whileTap,
          children,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode },
        ref: React.Ref<Element>
      ) =>
        ReactActual.createElement(
          tag,
          {
            ref,
            'data-animate': JSON.stringify(animate),
            'data-transition': JSON.stringify(transition),
            'data-while-tap': JSON.stringify(whileTap),
            ...props
          },
          children
        )
    );
  return {
    ...jest.requireActual('framer-motion'),
    motion: { span: make('span'), button: make('button'), path: make('path') },
    useReducedMotion: () => mockReduce
  };
});

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn() }));

const mockHaptic = jest.mocked(hapticSelection);

const slot = (root: ParentNode, name: string) => root.querySelector(`[data-slot="${name}"]`);
const animateOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-animate') ?? '{}');
const transitionOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-transition') ?? '{}');

const Row: React.FC<{ initial?: boolean; onChange?: (v: boolean) => void; disabled?: boolean }> = ({
  initial = false,
  onChange,
  disabled
}) => {
  const [checked, setChecked] = useState(initial);
  return (
    <CheckboxRow
      checked={checked}
      onCheckedChange={v => {
        setChecked(v);
        onChange?.(v);
      }}
      title="Test tokens are not money"
      description="They have no value."
      disabled={disabled}
      data-testid="row"
    />
  );
};

beforeEach(() => {
  mockReduce = false;
  mockHaptic.mockClear();
});

describe('CheckboxIndicator', () => {
  it('draws the 22px, 6px-radius box, decorative', () => {
    const { container } = render(<CheckboxIndicator checked={false} />);
    const box = slot(container, 'checkbox-indicator');
    expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(box).toHaveClass('size-5.5', 'rounded-full', 'bg-page', 'ring-hairline');
  });

  it('fills on the snappy spring and draws the check on the tab-bar spring when checked', () => {
    const { container, rerender } = render(<CheckboxIndicator checked={false} />);
    expect(animateOf(slot(container, 'checkbox-fill'))).toEqual({ scale: 0, opacity: 0 });
    expect(animateOf(slot(container, 'checkbox-check'))).toEqual({ pathLength: 0, opacity: 0 });

    rerender(<CheckboxIndicator checked />);
    expect(animateOf(slot(container, 'checkbox-fill'))).toEqual({ scale: 1, opacity: 1 });
    expect(animateOf(slot(container, 'checkbox-check'))).toEqual({ pathLength: 1, opacity: 1 });
    expect(transitionOf(slot(container, 'checkbox-fill'))).toEqual(springs.snappy);
    expect(transitionOf(slot(container, 'checkbox-check'))).toEqual(tabBarMotion.highlight);
    expect(slot(container, 'checkbox-fill')).toHaveClass('bg-accent-primary');
  });

  it('is instant under reduced motion', () => {
    mockReduce = true;
    const { container } = render(<CheckboxIndicator checked />);
    expect(transitionOf(slot(container, 'checkbox-fill'))).toEqual(reducedMotionTransition);
    expect(transitionOf(slot(container, 'checkbox-check'))).toEqual(reducedMotionTransition);
  });
});

describe('CheckboxRow', () => {
  it('is one checkbox named by its title and described by its description', () => {
    render(<Row />);
    const box = screen.getByRole('checkbox', { name: 'Test tokens are not money' });
    expect(box).toHaveAccessibleDescription('They have no value.');
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(box).toHaveClass('focus-visible:ring-accent-primary', 'min-h-16');
  });

  it('toggles on a tap anywhere on the row, with the selection haptic each time', () => {
    const onChange = jest.fn();
    render(<Row onChange={onChange} />);
    const box = screen.getByRole('checkbox');

    fireEvent.click(screen.getByText('They have no value.'));
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(slot(box, 'checkbox-indicator')).toHaveAttribute('data-state', 'checked');

    fireEvent.click(box);
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(mockHaptic).toHaveBeenCalledTimes(2);
  });

  it('toggles on Enter without submitting, and is a native button so Space clicks it', () => {
    render(<Row />);
    const box = screen.getByRole('checkbox');
    expect(box.tagName).toBe('BUTTON');
    expect(box).toHaveAttribute('type', 'button');
    // The suppression is the point of the handler, so it is what gets asserted: a button already
    // activates on Enter, and jsdom does not perform that default, so a test that only watches
    // `aria-checked` stays green with the preventDefault deleted - while a real browser would
    // toggle twice and Enter would do nothing at all.
    const enter = createEvent.keyDown(box, { key: 'Enter' });
    fireEvent(box, enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(box, { key: 'a' });
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  // What the browser actually does: keydown, and then the activation click only if nothing stopped
  // it. Replaying both unconditionally would fail on correct code too.
  it('toggles once when the browser follows Enter with its activation click', () => {
    const onChange = jest.fn();
    render(<Row onChange={onChange} />);
    const box = screen.getByRole('checkbox');

    const enter = createEvent.keyDown(box, { key: 'Enter' });
    fireEvent(box, enter);
    if (!enter.defaultPrevented) fireEvent.click(box);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('dips its content on the tab-bar press, and not under reduced motion', () => {
    const { unmount } = render(<Row />);
    const content = screen.getByRole('checkbox').firstElementChild;
    expect(JSON.parse(content?.getAttribute('data-while-tap') ?? '{}')).toEqual({
      scale: tabBarMotion.pressScale,
      transition: tabBarMotion.press
    });
    unmount();
    mockReduce = true;
    render(<Row />);
    expect(screen.getByRole('checkbox').firstElementChild).not.toHaveAttribute('data-while-tap');
  });

  it('does nothing while disabled', () => {
    const onChange = jest.fn();
    render(<Row onChange={onChange} disabled />);
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(mockHaptic).not.toHaveBeenCalled();
  });
});
