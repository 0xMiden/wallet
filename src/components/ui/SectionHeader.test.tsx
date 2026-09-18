import React from 'react';

import { render, screen } from '@testing-library/react';

import { SectionHeader } from './SectionHeader';

it('is a 13px bold muted h2, 8px above its group and inset 4px', () => {
  render(<SectionHeader>My accounts</SectionHeader>);

  const heading = screen.getByRole('heading', { level: 2, name: 'My accounts' });
  expect(heading).toHaveClass('font-sans', 'text-[13px]', 'font-bold', 'text-muted');
  expect(heading.parentElement).toHaveClass('px-1', 'pb-2');
});

it('can be another heading level', () => {
  render(<SectionHeader as="h3">Contacts</SectionHeader>);
  expect(screen.getByRole('heading', { level: 3, name: 'Contacts' })).toBeInTheDocument();
});

it('renders an action beside the label', () => {
  render(
    <SectionHeader action={<button type="button">See all</button>} data-testid="header">
      Recent
    </SectionHeader>
  );

  expect(screen.getByTestId('header')).toContainElement(screen.getByRole('button', { name: 'See all' }));
});
