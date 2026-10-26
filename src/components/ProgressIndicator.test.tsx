import React from 'react';

import { render, screen } from '@testing-library/react';

import { reducedMotionTransition, springs } from 'lib/animation';

import { ProgressIndicator } from './ProgressIndicator';

let mockReduce = false;

// Each segment surfaces what framer would receive, so the width and transition are observable.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  return {
    ...jest.requireActual('framer-motion'),
    useReducedMotion: () => mockReduce,
    motion: {
      div: ({
        animate,
        initial: _initial,
        transition,
        ...rest
      }: Record<string, unknown> & { children?: React.ReactNode }) =>
        ReactActual.createElement('div', {
          'data-testid': 'bar',
          'data-animate': JSON.stringify(animate),
          'data-transition': JSON.stringify(transition),
          ...rest
        })
    }
  };
});

const bars = () => screen.queryAllByTestId('bar');
const widthOf = (bar: HTMLElement) => JSON.parse(bar.getAttribute('data-animate') ?? '{}').width;

beforeEach(() => {
  mockReduce = false;
});

describe('ProgressIndicator', () => {
  it('renders one segment per step', () => {
    render(<ProgressIndicator steps={4} currentStep={1} />);
    expect(bars()).toHaveLength(4);
  });

  it('renders no segments when there are no steps', () => {
    render(<ProgressIndicator steps={0} currentStep={0} />);
    expect(bars()).toHaveLength(0);
  });

  it('fills the done and current steps in accent, wider, and leaves the rest on fill-pressed', () => {
    render(<ProgressIndicator steps={4} currentStep={2} />);
    const [a, b, c, d] = bars();
    [a, b].forEach(bar => {
      expect(bar).toHaveClass('bg-accent-primary');
      expect(widthOf(bar!)).toBe(54);
    });
    [c, d].forEach(bar => {
      expect(bar).toHaveClass('bg-fill-pressed');
      expect(widthOf(bar!)).toBe(42);
    });
  });

  it('moves on the standard spring, instant under reduced motion', () => {
    const { unmount } = render(<ProgressIndicator steps={2} currentStep={1} />);
    expect(JSON.parse(bars()[0]!.getAttribute('data-transition') ?? '{}')).toEqual(springs.standard);
    unmount();

    mockReduce = true;
    render(<ProgressIndicator steps={2} currentStep={1} />);
    expect(JSON.parse(bars()[0]!.getAttribute('data-transition') ?? '{}')).toEqual(reducedMotionTransition);
  });

  it('merges a layout className and forwards attributes', () => {
    const { container } = render(<ProgressIndicator steps={1} currentStep={1} className="opacity-0" aria-hidden />);
    expect(container.firstChild).toHaveClass('flex', 'gap-0.5', 'opacity-0');
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });
});
