import React from 'react';

import { render, screen } from '@testing-library/react';

import { FlowSpinner } from './FlowSpinner';

let mockReduce = false;
jest.mock('framer-motion', () => ({ useReducedMotion: () => mockReduce }));

afterEach(() => {
  mockReduce = false;
});

it('spins the HTML wrapper with a CSS transform animation, in the flow accent', () => {
  render(<FlowSpinner accent="send" size={20} />);
  const spinner = screen.getByTestId('flow-spinner');

  expect(spinner.tagName).toBe('DIV');
  expect(spinner.className).toContain('animate-[spin_0.9s_linear_infinite]');
  expect(spinner).toHaveClass('text-accent-send', 'will-change-transform');
  expect(spinner.querySelector('circle[stroke-linecap="round"]')).not.toBeNull();
});

it('holds still under reduced motion', () => {
  mockReduce = true;
  render(<FlowSpinner accent="brand" size={20} />);

  expect(screen.getByTestId('flow-spinner').className).not.toContain('animate-');
});
