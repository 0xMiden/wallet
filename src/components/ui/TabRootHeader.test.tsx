import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { TabRootHeader } from './TabRootHeader';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

const filterItems = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' }
];

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const renderWithFilter = (onChange = jest.fn()) =>
  render(
    <TabRootHeader
      title="Activity"
      filter={{ items: filterItems, value: 'all', onChange, 'aria-label': 'Activity filters' }}
    />
  );

it('is a 60px title band — 56px row plus the 4px rule — over the filter row', () => {
  const { container } = renderWithFilter();

  const header = container.querySelector('header')!;
  expect(header).toHaveClass('h-14', 'py-2.5');
  expect(header.className).not.toMatch(/border/);

  // Ahmad's rule, drawn by the header rather than by any page: 4px on `fill`, at the page margin.
  const rule = header.nextElementSibling!;
  expect(rule).toHaveClass('mx-4', 'h-1', 'rounded-full', 'bg-fill');
  expect(rule).toHaveAttribute('aria-hidden', 'true');

  const row = screen.getByRole('radiogroup', { name: 'Activity filters' });
  expect(rule.nextElementSibling).toBe(row);
  expect(row).toHaveClass('px-4', 'py-1.5');
});

it('owns how the filter row looks: the page passes items and a selection, nothing else', () => {
  renderWithFilter();

  const selected = screen.getByRole('radio', { name: 'All' });
  const rest = screen.getByRole('radio', { name: 'Sent' });

  expect(selected).toHaveAttribute('aria-checked', 'true');
  // The bottom nav's raised bubble over the selection, filled with the accent and carrying a
  // `pure-black` label; an outlined pill for everything else.
  expect(selected.querySelector('[data-slot="motion-highlight"]')).toHaveClass('bg-accent-primary', 'shadow-raised');
  expect(selected).toHaveClass('text-pure-black');
  expect(selected).not.toHaveClass('text-pure-white');
  expect(rest.querySelector('[data-slot="motion-highlight"]')).toBeNull();
  expect(rest).toHaveClass('border', 'border-hairline', 'bg-page', 'text-ink');
});

it('reports a real change in the filter row', () => {
  const onChange = jest.fn();
  renderWithFilter(onChange);

  fireEvent.click(screen.getByRole('radio', { name: 'Sent' }));
  expect(onChange).toHaveBeenCalledWith('sent');

  fireEvent.click(screen.getByRole('radio', { name: 'All' }));
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('renders the title row and the rule, and no filter row, on a tab root that does not filter', () => {
  const { container } = render(<TabRootHeader title="Settings" />);

  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  expect(screen.queryByRole('radiogroup')).toBeNull();

  const header = container.querySelector('header')!;
  expect(header).toHaveClass('h-14', 'py-2.5');
  // Settings gets the same rule as Activity and Explore — that is the point of the shared band.
  expect(header.nextElementSibling).toHaveClass('mx-4', 'h-1', 'bg-fill');
});
