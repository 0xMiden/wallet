import React from 'react';

import { render } from '@testing-library/react';

import { CommandHistoryTrace } from './CommandHistoryTrace';

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
