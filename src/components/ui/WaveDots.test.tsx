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

it('holds still under reduced motion', () => {
  mockReduce.value = true;
  render(<WaveDots label="Calculating" />);
  mockDots.forEach(dot => expect(dot.animate).toEqual({ y: 0 }));
});
