import React from 'react';

import { render, screen } from '@testing-library/react';

import { WaveDots } from './WaveDots';

const mockReduce = { value: false };
const mockDots: Array<Record<string, any>> = [];

// Capture each dot's motion props: jsdom runs no animation, so the wiring is what can be checked.
jest.mock('framer-motion', () => {
  const R = require('react');
  return {
    useReducedMotion: () => mockReduce.value,
    motion: {
      span: ({ initial, animate, transition, ...props }: any) => {
        mockDots.push({ initial, animate, transition });
        return R.createElement('span', props);
      }
    }
  };
});

// Distinct token values, so the dots can only carry them by reading the shared tokens. Built inside the
// factory: jest.mock is hoisted above the module-scope consts, so the factory cannot read one.
jest.mock('lib/animation', () => {
  const actual = jest.requireActual('lib/animation');
  return {
    ...actual,
    durations: { ...actual.durations, extraSlow: 9, fast: 7 },
    easings: { ...actual.easings, easeInOut: [0.1, 0.2, 0.3, 0.4] },
    reducedMotionTransition: { duration: 0.0042 }
  };
});
const mockedReducedTransition = jest.requireMock('lib/animation').reducedMotionTransition;

beforeEach(() => {
  mockReduce.value = false;
  mockDots.length = 0;
});

it('announces its label and draws three dots', () => {
  render(<WaveDots label="Calculating" />);
  expect(screen.getByRole('status', { name: 'Calculating' })).toBeInTheDocument();
  expect(mockDots).toHaveLength(3);
});

it('starts the wave on mount and plays all three keyframes as a looping tween, one dot after another', () => {
  render(<WaveDots label="Calculating" />);
  mockDots.forEach((dot, index) => {
    // `initial={false}` would skip the mount animation, and the loop would never start.
    expect(dot.initial).not.toBe(false);
    expect(dot.animate.y).toEqual([0, -4, 0]);
    // A spring can only run between two values; a three-keyframe wave needs a tween.
    expect(dot.transition.type).not.toBe('spring');
    expect(dot.transition.repeat).toBe(Infinity);
    expect(dot.transition.delay).toBeCloseTo(index * 0.14);
  });
});

it('holds still under reduced motion, on the shared reduced-motion transition', () => {
  mockReduce.value = true;
  render(<WaveDots label="Calculating" />);
  mockDots.forEach(dot => {
    expect(dot.animate).toEqual({ y: 0 });
    expect(dot.transition).toBe(mockedReducedTransition);
  });
});

it('times the wave with the shared motion tokens', () => {
  render(<WaveDots label="Calculating" />);
  mockDots.forEach(dot => {
    expect(dot.transition.duration).toBe(9);
    expect(dot.transition.repeatDelay).toBe(7);
    expect(dot.transition.ease).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});
