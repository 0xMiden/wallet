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

describe('ListGroup options', () => {
  it('renders a list as a ul with the list role WebKit drops from a marker-less ul', () => {
    const { container, rerender } = render(<ListGroup as="ul">{[<li key="a" />]}</ListGroup>);
    expect((container.firstChild as HTMLElement).tagName).toBe('UL');
    expect(container.firstChild).toHaveAttribute('role', 'list');

    rerender(<ListGroup>{[<div key="a" />]}</ListGroup>);
    expect(container.firstChild).not.toHaveAttribute('role');
  });

  it("lets a plain group keep each row's own inset, read from the row's --row-flush-inset", () => {
    const { container } = render(
      <ListGroup surface="plain" insetHairlines>
        {[<div key="a" />]}
      </ListGroup>
    );
    expect(container.firstChild).toHaveClass('[&>*]:px-0', '[&>*]:before:left-[var(--row-flush-inset,0px)]');
    expect(container.firstChild).not.toHaveClass('[&>*]:before:left-0');
  });
});
