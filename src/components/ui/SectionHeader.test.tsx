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

it('renders an icon aria-hidden in a 32px bg-fill circle before the label, default size unaffected', () => {
  render(<SectionHeader icon={<svg data-testid="glyph" />}>Security</SectionHeader>);

  const glyph = screen.getByTestId('glyph');
  const circle = glyph.parentElement;
  expect(circle).toHaveAttribute('aria-hidden', 'true');
  expect(circle).toHaveClass('h-8', 'w-8', 'rounded-full', 'bg-fill');

  // Adding `icon` alone does not switch the label off its default `sm` style.
  const heading = screen.getByRole('heading', { level: 2, name: 'Security' });
  expect(heading).toHaveClass('font-sans', 'text-[13px]', 'font-bold', 'text-muted');
});

it('the lg size is an 18px Nunito extrabold ink heading, for a page-level section title', () => {
  render(<SectionHeader size="lg">Settings</SectionHeader>);

  const heading = screen.getByRole('heading', { level: 2, name: 'Settings' });
  expect(heading).toHaveClass('font-heading', 'text-lg', 'font-extrabold', 'text-ink');
});

it('has no icon circle when icon is omitted', () => {
  render(<SectionHeader>My accounts</SectionHeader>);
  expect(document.querySelector('.bg-fill')).not.toBeInTheDocument();
});
