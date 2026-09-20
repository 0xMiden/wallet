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

it('is a 61px title band — 60px row plus the hairline — over the filter row', () => {
  const { container } = renderWithFilter();

  const header = container.querySelector('header')!;
  expect(header).toHaveClass('h-15', 'border-b', 'border-hairline');
  // The retired 4px grey rule: nothing of the sort is left between the two rows.
  expect(container.querySelector('.h-1')).toBeNull();

  const row = screen.getByRole('radiogroup', { name: 'Activity filters' });
  expect(header.nextElementSibling).toBe(row);
  expect(row).toHaveClass('px-4', 'py-1.5');
});

it('owns how the filter row looks: the page passes items and a selection, nothing else', () => {
  renderWithFilter();

  const selected = screen.getByRole('radio', { name: 'All' });
  const rest = screen.getByRole('radio', { name: 'Sent' });

  expect(selected).toHaveAttribute('aria-checked', 'true');
  expect(selected.querySelector('[data-slot="motion-highlight"]')).toHaveClass('bg-raised');
  expect(selected).not.toHaveClass('text-pure-white');
  expect(rest.querySelector('[data-slot="motion-highlight"]')).toBeNull();
  expect(rest).not.toHaveClass('border');
});

it('reports a real change in the filter row', () => {
  const onChange = jest.fn();
  renderWithFilter(onChange);

  fireEvent.click(screen.getByRole('radio', { name: 'Sent' }));
  expect(onChange).toHaveBeenCalledWith('sent');

  fireEvent.click(screen.getByRole('radio', { name: 'All' }));
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('renders the title row alone on a tab root that does not filter', () => {
  const { container } = render(<TabRootHeader title="Settings" />);

  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  expect(screen.queryByRole('radiogroup')).toBeNull();
  expect(container.querySelector('header')).toHaveClass('h-15', 'border-b', 'border-hairline');
});
