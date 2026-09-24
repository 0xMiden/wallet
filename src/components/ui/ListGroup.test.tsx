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

describe('ListGroup surfaces', () => {
  it('draws the fill surface by default, an outline on request, and nothing for plain', () => {
    const { rerender, container } = render(<ListGroup>{[<div key="a" />]}</ListGroup>);
    expect(container.firstChild).toHaveClass('bg-fill', 'rounded-2xl');

    rerender(<ListGroup surface="outline">{[<div key="a" />]}</ListGroup>);
    expect(container.firstChild).toHaveClass('bg-page', 'border', 'border-hairline', 'rounded-2xl');
    expect(container.firstChild).not.toHaveClass('bg-fill');

    rerender(<ListGroup surface="plain">{[<div key="a" />]}</ListGroup>);
    expect(container.firstChild).not.toHaveClass('bg-fill');
    expect(container.firstChild).not.toHaveClass('border');
    // Plain: the rows sit on the page margin and their hairlines run the full width.
    expect(container.firstChild).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
  });
});
