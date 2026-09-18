import React from 'react';

import { render, screen } from '@testing-library/react';

import { ListGroup } from './ListGroup';

it('holds its rows on the shared fill with 16px corners', () => {
  render(
    <ListGroup data-testid="group" className="mt-2">
      <div data-testid="row" />
    </ListGroup>
  );

  const group = screen.getByTestId('group');
  expect(group).toHaveClass('bg-fill', 'rounded-2xl', 'overflow-hidden', 'flex-col', 'mt-2');
  expect(screen.getByTestId('row').parentElement).toBe(group);
});
