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
  expect(header).toHaveClass('h-14');
  expect(header.className).not.toMatch(/border/);
  // No vertical padding, so the 44px icon action cannot push the 56px row taller.
  expect(header.className).not.toMatch(/\b(py|pt|pb)-/);

  // Ahmad's rule, drawn by the header rather than by any page: 4px on `fill`, at the page
  // margin, with the shared 8px of air under it so nothing sits on the bar.
  const rule = header.nextElementSibling!;
  expect(rule).toHaveClass('mx-4', 'mb-2', 'h-1', 'rounded-full', 'bg-fill');
  expect(rule).toHaveAttribute('aria-hidden', 'true');

  const row = screen.getByRole('radiogroup', { name: 'Activity filters' });
  expect(rule.nextElementSibling).toBe(row);
  // 4px of padding, not 6: the 8px above came out of what this row used to spend.
  expect(row).toHaveClass('px-4', 'py-1');
});

it('is the same band, class for class, with search closed and open', () => {
  const search = { open: false, value: '', onChange: jest.fn(), placeholder: 'Search' };
  const band = (root: HTMLElement) => {
    const header = root.querySelector('header')!;
    const rule = header.nextElementSibling!;
    return { header: header.className, rule: rule.className, row: rule.nextElementSibling!.className };
  };

  const { container, rerender } = render(
    <TabRootHeader
      title="Explore"
      search={search}
      filter={{ items: filterItems, value: 'all', onChange: jest.fn(), 'aria-label': 'Explore filters' }}
    />
  );
  const closed = band(container);

  rerender(
    <TabRootHeader
      title="Explore"
      search={{ ...search, open: true }}
      filter={{ items: filterItems, value: 'all', onChange: jest.fn(), 'aria-label': 'Explore filters' }}
    />
  );

  // Nothing about the band changes when the field takes the title's place: the row is a fixed
  // 56px with no padding to grow by, and both sides of the swap are the same 36px box — so the
  // rule, the filter row and everything under them stay exactly where they were.
  expect(band(container)).toEqual(closed);
  expect(screen.getByTestId('tab-header-search').className).toContain('h-9');
});

it('owns how the filter row looks: the page passes items and a selection, nothing else', () => {
  renderWithFilter();

  const selected = screen.getByRole('radio', { name: 'All' });
  const rest = screen.getByRole('radio', { name: 'Sent' });

  expect(selected).toHaveAttribute('aria-checked', 'true');
  // The bottom nav's raised bubble over the selection, filled with the accent and carrying a
  // white label (text-pure-white); an outlined pill for everything else.
  expect(selected.querySelector('[data-slot="motion-highlight"]')).toHaveClass('bg-accent-primary', 'shadow-raised');
  expect(selected).toHaveClass('text-pure-white');
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
  expect(header).toHaveClass('h-14');
  // Settings gets the same rule, and the same 8px under it, as Activity and Explore — that is
  // the point of the shared band; its body adds no top padding of its own.
  expect(header.nextElementSibling).toHaveClass('mx-4', 'mb-2', 'h-1', 'bg-fill');
});
