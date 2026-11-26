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
  const line = container.querySelector('[data-command-chart-line]');
  const gap = container.querySelector('[data-command-chart-gap-line]');
  expect(line).toHaveAttribute('d', 'M 0 20 L 25 40');
  expect(gap).toHaveAttribute('d', 'M 25 40 L 80 10');
  expect(line?.parentElement).toHaveAttribute('clip-path', expect.stringMatching(/^url\(#/));

  for (const preference of [true, null]) {
    mockReducedMotion = preference;
    rerender(<CommandHistoryTrace points={points} reveal />);
    expect(container.querySelector('[data-command-chart-sweep]')).toBeNull();
    expect(container.querySelector('[data-command-chart-line]')).toHaveAttribute('d', 'M 0 20 L 25 40');
    expect(container.querySelector('[data-command-chart-gap-line]')).toHaveAttribute('d', 'M 25 40 L 80 10');
    expect(container.querySelector('[data-command-chart-line]')?.parentElement).not.toHaveAttribute('clip-path');
    expect(container.querySelectorAll('[data-command-chart-point]')).toHaveLength(3);
  }
});

it('draws separate solid runs with dashed connectors and keeps isolated observation markers', () => {
  const points = [0, 0, 1, 2, 2].map((run, index) => ({
    x: index * 20,
    y: 10 + index * 10,
    bucket: index,
    run
  }));
  const { container } = render(<CommandHistoryTrace points={points} />);
  expect(container.querySelector('[data-command-chart-line]')).toHaveAttribute('d', 'M 0 10 L 20 20 M 60 40 L 80 50');
  const gap = container.querySelector('[data-command-chart-gap-line]');
  expect(gap).toHaveAttribute('d', 'M 20 20 L 40 30 M 40 30 L 60 40');
  expect(gap).toHaveAttribute('stroke-dasharray', '4 4');
  expect(container.querySelectorAll('[data-command-chart-point]')).toHaveLength(5);
  expect(container.querySelector('[data-command-chart-point][data-x="40"]')).toHaveStyle({ left: '40%', top: '30%' });
});
