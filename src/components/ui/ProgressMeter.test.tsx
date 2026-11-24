import React from 'react';

import { render, screen } from '@testing-library/react';

import { ProgressMeter } from './ProgressMeter';

it('reports its value to assistive technology and fills in proportion', () => {
  render(<ProgressMeter value={2} max={6} aria-label="Badges earned" />);
  const meter = screen.getByRole('progressbar', { name: 'Badges earned' });
  expect(meter).toHaveAttribute('aria-valuemin', '0');
  expect(meter).toHaveAttribute('aria-valuemax', '6');
  expect(meter).toHaveAttribute('aria-valuenow', '2');
  expect(meter.querySelector('[data-slot="bar"]')).toHaveStyle({ width: `${(2 / 6) * 100}%` });
});

it('draws an empty bar at zero', () => {
  render(<ProgressMeter value={0} max={6} aria-label="Badges earned" />);
  expect(screen.getByRole('progressbar').querySelector('[data-slot="bar"]')).toHaveStyle({ width: '0%' });
});

it.each([
  [-1, 6, '0', '0%'],
  [9, 6, '6', '100%'],
  [3, 0, '0', '0%']
])('clamps value %d of %d into range', (value, max, now, width) => {
  render(<ProgressMeter value={value} max={max} aria-label="Progress" />);
  const meter = screen.getByRole('progressbar');
  expect(meter).toHaveAttribute('aria-valuenow', now);
  expect(meter.querySelector('[data-slot="bar"]')).toHaveStyle({ width });
});
