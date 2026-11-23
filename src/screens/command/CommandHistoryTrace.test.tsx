import React from 'react';

import { render } from '@testing-library/react';

import { CommandHistoryTrace } from './CommandHistoryTrace';

let mockReducedMotion: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReducedMotion
}));

afterEach(() => {
  mockReducedMotion = false;
});

it('sweeps only the selected-range stroke; reduced or unknown motion keeps the same geometry static', () => {
  const points = [
    { x: 0, y: 20, bucket: 1, run: 0 },
    { x: 25, y: 40, bucket: 2, run: 0 },
    { x: 80, y: 10, bucket: 3, run: 1 }
  ];
  const { container, rerender } = render(<CommandHistoryTrace points={points} />);
  expect(container.querySelector('[data-command-chart-sweep]')).toBeNull();
  rerender(<CommandHistoryTrace points={points} reveal />);
  expect(container.querySelector('[data-command-chart-sweep]')).toBeInTheDocument();
  const path = container.querySelector('[data-command-chart-area]')?.getAttribute('d');
  mockReducedMotion = true;
  rerender(<CommandHistoryTrace points={points} reveal />);
  expect(container.querySelector('[data-command-chart-sweep]')).toBeNull();
  expect(container.querySelector('[data-command-chart-area]')).toHaveAttribute('d', path);
  expect(container.querySelectorAll('circle')).toHaveLength(3);
  mockReducedMotion = null;
  rerender(<CommandHistoryTrace points={points} reveal />);
  expect(container.querySelector('[data-command-chart-sweep]')).toBeNull();
});

it('shades continuous runs independently and leaves isolated observations unconnected', () => {
  const points = [0, 0, 1, 2, 2].map((run, index) => ({
    x: index * 20,
    y: 10 + index * 10,
    bucket: index,
    run
  }));
  const { container } = render(<CommandHistoryTrace points={points} />);
  expect(container.querySelector('[data-command-chart-area]')).toHaveAttribute(
    'd',
    'M 0 100 L 0 10 L 20 20 L 20 100 Z M 60 100 L 60 40 L 80 50 L 80 100 Z'
  );
  expect(container.querySelectorAll('circle')).toHaveLength(5);
});
