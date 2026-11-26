import React, { useState } from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { BridgePicker, type BridgePickerOption } from './BridgePicker';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie'),
  useLocation: () => ({ pathname: '/', hash: '' })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

const icon = (size: 'sm' | 'md') => <span data-testid={`icon-${size}`} />;
const OPTIONS: BridgePickerOption[] = [
  { id: 'usdc-a', label: 'USDC', detail: 'Epoch · 0xaaaa', keywords: '0xaaaa1111', icon },
  { id: 'usdc-b', label: 'USDC', detail: 'AggLayer · 0xbbbb', keywords: '0xbbbb2222', icon },
  { id: 'eth', label: 'ETH', keywords: 'Ether', icon }
];

function Harness({
  options = OPTIONS,
  searchable,
  onChange
}: {
  options?: readonly BridgePickerOption[];
  searchable?: boolean;
  onChange: (id: string) => void;
}) {
  const [value, setValue] = useState('usdc-b');
  return (
    <BridgePicker
      menuLabel="Pick"
      value={value}
      options={options}
      searchable={searchable}
      onChange={id => {
        onChange(id);
        setValue(id);
      }}
      data-testid="picker"
    />
  );
}

const pill = () => screen.getByTestId('picker');
const menu = () => screen.queryByTestId('picker-menu');
const row = (id: string) => screen.getByTestId(`bridge-option-${id}`);
const shownRows = () => within(screen.getByRole('radiogroup', { name: 'Pick' })).queryAllByRole('radio');

it('one option is plain text with no menu', () => {
  render(<Harness options={[OPTIONS[2]!]} onChange={jest.fn()} />);
  expect(pill().tagName).toBe('SPAN');
  expect(pill()).toHaveTextContent('ETH');
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.click(pill());
  expect(menu()).toBeNull();
});

it('no option is a disabled pill', () => {
  render(<Harness options={[]} onChange={jest.fn()} />);
  expect(pill().tagName).toBe('BUTTON');
  expect(pill()).toBeDisabled();
  expect(pill()).toHaveTextContent('unavailable');
});

it('arrow keys move focus without selecting and Enter-click selects once, closing the menu and returning focus to the pill', async () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  expect(pill()).toHaveAttribute('aria-haspopup', 'dialog');
  expect(pill()).toHaveAccessibleName('Pick: USDC');
  expect(pill()).toHaveAttribute('aria-expanded', 'false');
  pill().focus();
  fireEvent.keyDown(pill(), { key: 'ArrowDown' });
  expect(menu()).toHaveAttribute('aria-label', 'Pick');
  expect(pill()).toHaveAttribute('aria-expanded', 'true');
  expect(within(menu()!).getByText('Pick')).toBeInTheDocument();
  await waitFor(() => expect(row('usdc-b')).toHaveFocus());
  expect(row('usdc-b')).toHaveAttribute('aria-checked', 'true');
  expect(row('usdc-b')).toHaveAttribute('tabindex', '0');
  expect(row('usdc-a')).toHaveAttribute('tabindex', '-1');
  expect(row('eth')).toHaveAttribute('tabindex', '-1');
  expect(within(row('usdc-a')).getByText('Epoch · 0xaaaa')).toBeInTheDocument();
  expect(within(row('usdc-a')).getByTestId('icon-md')).toBeInTheDocument();

  fireEvent.keyDown(row('usdc-b'), { key: 'ArrowDown' });
  expect(row('eth')).toHaveFocus();
  fireEvent.keyDown(row('eth'), { key: 'ArrowDown' });
  expect(row('usdc-a')).toHaveFocus();
  fireEvent.keyDown(row('usdc-a'), { key: 'ArrowUp' });
  expect(row('eth')).toHaveFocus();
  fireEvent.keyDown(row('eth'), { key: 'Home' });
  expect(row('usdc-a')).toHaveFocus();
  fireEvent.keyDown(row('usdc-a'), { key: 'End' });
  expect(row('eth')).toHaveFocus();
  expect(onChange).not.toHaveBeenCalled();
  expect(row('usdc-b')).toHaveAttribute('aria-checked', 'true');

  // A native button turns Enter into a click, which jsdom does not do: nothing may cancel that keydown.
  expect(row('eth').tagName).toBe('BUTTON');
  expect(fireEvent.keyDown(row('eth'), { key: 'Enter' })).toBe(true);
  fireEvent.click(row('eth'));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('eth');
  await waitFor(() => expect(menu()).toBeNull());
  await waitFor(() => expect(pill()).toHaveFocus());
  expect(pill()).toHaveTextContent('ETH');
  expect(pill()).toHaveAccessibleName('Pick: ETH');
  expect(pill()).toHaveAttribute('aria-expanded', 'false');

  fireEvent.click(pill());
  await waitFor(() => expect(row('eth')).toHaveFocus());
  fireEvent.click(row('eth'));
  await waitFor(() => expect(menu()).toBeNull());
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('search filters by symbol and address, reports no match, and is cleared when reopened', async () => {
  render(<Harness searchable onChange={jest.fn()} />);
  fireEvent.click(pill());
  const search = () => screen.getByTestId('picker-search');
  await waitFor(() => expect(search()).toHaveFocus());
  expect(search()).toHaveAttribute('placeholder', 'searchByNameOrSymbol');

  fireEvent.change(search(), { target: { value: 'usdc' } });
  expect(shownRows().map(item => item.dataset.testid)).toEqual(['bridge-option-usdc-a', 'bridge-option-usdc-b']);
  fireEvent.change(search(), { target: { value: '0XBBBB2' } });
  expect(shownRows().map(item => item.dataset.testid)).toEqual(['bridge-option-usdc-b']);
  fireEvent.change(search(), { target: { value: 'agglayer' } });
  expect(shownRows().map(item => item.dataset.testid)).toEqual(['bridge-option-usdc-b']);
  // Mounted while empty, so a screen reader announces the later text; out of flow, so it leaves no gap.
  const status = screen.getByRole('status');
  expect(status).toBeEmptyDOMElement();
  expect(status).toHaveClass('sr-only');
  fireEvent.change(search(), { target: { value: 'zzz' } });
  expect(shownRows()).toHaveLength(0);
  expect(screen.getByRole('status')).toBe(status);
  expect(status).toHaveTextContent('commandBridgeNoTokens');
  expect(status).not.toHaveClass('sr-only');

  fireEvent.keyDown(search(), { key: 'Escape' });
  await waitFor(() => expect(menu()).toBeNull());
  fireEvent.click(pill());
  await waitFor(() => expect(search()).toHaveFocus());
  expect(search()).toHaveValue('');
  expect(shownRows()).toHaveLength(3);
});

it('the search field stays pinned and opaque over a scrolling list', () => {
  render(<Harness searchable onChange={jest.fn()} />);
  fireEvent.click(pill());
  // jsdom has no layout: the classes are the contract.
  const header = screen.getByTestId('picker-search').parentElement!.parentElement!;
  expect(header).toHaveClass('sticky', 'top-0', 'z-10', 'bg-page', '-mx-2', 'px-2', '-my-2', 'py-2');
  // A focused row must not scroll to rest underneath it.
  expect(row('usdc-a')).toHaveClass('scroll-mt-16');
});

it('a menu without search has no status region', () => {
  render(<Harness onChange={jest.fn()} />);
  fireEvent.click(pill());
  expect(screen.queryByRole('status')).toBeNull();
});

it('ArrowDown from the search field reaches the first row', async () => {
  render(<Harness searchable onChange={jest.fn()} />);
  fireEvent.click(pill());
  const search = screen.getByTestId('picker-search');
  await waitFor(() => expect(search).toHaveFocus());
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    expect(fireEvent.keyDown(search, { key })).toBe(true);
    expect(search).toHaveFocus();
  }
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(row('usdc-a')).toHaveFocus();
  search.focus();
  fireEvent.keyDown(search, { key: 'ArrowUp' });
  expect(row('eth')).toHaveFocus();
});

it('Escape and an outside press close without selecting', async () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  fireEvent.click(pill());
  await waitFor(() => expect(row('usdc-b')).toHaveFocus());
  fireEvent.keyDown(row('usdc-b'), { key: 'Escape' });
  await waitFor(() => expect(menu()).toBeNull());
  fireEvent.click(pill());
  await waitFor(() => expect(row('usdc-b')).toHaveFocus());
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(menu()).toBeNull());
  expect(onChange).not.toHaveBeenCalled();
  expect(pill()).toHaveTextContent('USDC');
});

it('options shrinking to one removes the open menu', async () => {
  const onChange = jest.fn();
  const view = render(<Harness onChange={onChange} />);
  fireEvent.click(pill());
  await waitFor(() => expect(row('usdc-b')).toHaveFocus());
  view.rerender(<Harness options={[OPTIONS[1]!]} onChange={onChange} />);
  await waitFor(() => expect(menu()).toBeNull());
  expect(pill().tagName).toBe('SPAN');
  view.rerender(<Harness onChange={onChange} />);
  expect(pill()).toHaveAttribute('aria-expanded', 'false');
  expect(menu()).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
