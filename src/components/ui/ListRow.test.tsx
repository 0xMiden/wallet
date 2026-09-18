import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { ListRow } from './ListRow';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/woozie', () => ({
  Link: ({ to, testID, children, ...rest }: any) => (
    <a href={`#${to}`} data-to={to} data-analytics={testID} {...rest}>
      {children}
    </a>
  )
}));

beforeEach(() => jest.clearAllMocks());

it('renders a static row as a div with a title over a muted subtitle', () => {
  render(<ListRow title="Account 1" subtitle="Private · mtst1…wr6w" data-testid="row" />);

  const row = screen.getByTestId('row');
  expect(row.tagName).toBe('DIV');
  expect(screen.getByText('Account 1')).toHaveClass('text-ink', 'font-bold', 'text-base');
  // The e2e helpers read a row's name off this slot.
  expect(row.querySelector('[data-slot="title"]')).toHaveTextContent('Account 1');
  expect(screen.getByText('Private · mtst1…wr6w')).toHaveClass('text-muted', 'text-[13px]');
  expect(row).toHaveClass('min-h-16');
  expect(row.querySelector('[data-slot="chevron"]')).toBeNull();
});

it('is 56px without a subtitle', () => {
  render(<ListRow title="Language" data-testid="row" />);
  expect(screen.getByTestId('row')).toHaveClass('min-h-14');
  expect(screen.getByTestId('row')).not.toHaveClass('min-h-16');
});

it('becomes a button with a tap haptic when it takes onClick', () => {
  const onClick = jest.fn();
  render(<ListRow title="Paul G" onClick={onClick} data-testid="row" />);

  const row = screen.getByTestId('row');
  expect(row.tagName).toBe('BUTTON');
  expect(row).toHaveAttribute('type', 'button');
  fireEvent.click(row);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(hapticLight).toHaveBeenCalledTimes(1);
});

it('shows a chevron on a row that navigates', () => {
  const { rerender } = render(<ListRow title="Paul G" onClick={jest.fn()} data-testid="row" />);
  expect(screen.getByTestId('row').querySelector('[data-slot="chevron"]')).toBeNull();

  rerender(<ListRow title="Paul G" onClick={jest.fn()} chevron data-testid="row" />);
  expect(screen.getByTestId('row').querySelector('[data-slot="chevron"]')).not.toBeNull();
});

it('routes through the wallet Link when given `to`, with a chevron and the testid for analytics', () => {
  render(<ListRow title="Address Book" to="/settings/address-book" data-testid="row" />);

  const row = screen.getByTestId('row');
  expect(row.tagName).toBe('A');
  expect(row).toHaveAttribute('data-to', '/settings/address-book');
  expect(row).toHaveAttribute('data-analytics', 'row');
  expect(row.querySelector('[data-slot="chevron"]')).not.toBeNull();
});

it('opens an external link in a new tab with a haptic', () => {
  render(<ListRow title="Privacy policy" href="https://example.com/privacy" data-testid="row" />);

  const row = screen.getByTestId('row');
  expect(row.tagName).toBe('A');
  expect(row).toHaveAttribute('href', 'https://example.com/privacy');
  expect(row).toHaveAttribute('target', '_blank');
  expect(row).toHaveAttribute('rel', 'noreferrer');
  fireEvent.click(row);
  expect(hapticLight).toHaveBeenCalledTimes(1);
  expect(row.querySelector('[data-slot="chevron"]')).not.toBeNull();
});

it('draws a hairline above every row but the first, inset past the leading visual', () => {
  render(
    <>
      <ListRow title="A" avatar={<span />} data-testid="avatar-row" />
      <ListRow title="B" icon={<svg />} data-testid="icon-row" />
      <ListRow title="C" data-testid="plain-row" />
    </>
  );

  for (const id of ['avatar-row', 'icon-row', 'plain-row']) {
    expect(screen.getByTestId(id)).toHaveClass('before:bg-hairline', 'before:h-px', 'first:before:hidden');
  }
  // 16px padding + 40px avatar + 12px gap; + 30px icon circle; the padding alone.
  expect(screen.getByTestId('avatar-row')).toHaveClass('before:left-[68px]');
  expect(screen.getByTestId('icon-row')).toHaveClass('before:left-[58px]');
  expect(screen.getByTestId('plain-row')).toHaveClass('before:left-4');
});

it('puts an icon in a 30px circle and an avatar in a 40px slot', () => {
  render(
    <>
      <ListRow title="A" avatar={<span data-testid="avatar" />} />
      <ListRow title="B" icon={<svg data-testid="glyph" />} />
    </>
  );

  expect(screen.getByTestId('avatar').parentElement).toHaveClass('h-10', 'w-10');
  expect(screen.getByTestId('glyph').parentElement).toHaveClass('h-[30px]', 'w-[30px]', 'rounded-full');
});

it('renders a trailing value, a custom trailing control and a check', () => {
  render(
    <>
      <ListRow title="Language" value="English" to="/settings/language" data-testid="value-row" />
      <ListRow title="Haptics" trailing={<input type="checkbox" data-testid="toggle" />} data-testid="toggle-row" />
      <ListRow title="Testnet" checked onClick={jest.fn()} data-testid="checked-row" />
      <ListRow title="Devnet" checked={false} onClick={jest.fn()} data-testid="unchecked-row" />
    </>
  );

  expect(screen.getByText('English')).toHaveClass('text-muted');
  expect(screen.getByTestId('value-row').querySelector('[data-slot="chevron"]')).not.toBeNull();
  expect(screen.getByTestId('toggle')).toBeInTheDocument();
  expect(screen.getByTestId('checked-row').querySelector('[data-slot="check"]')).not.toBeNull();
  expect(screen.getByTestId('checked-row')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('unchecked-row').querySelector('[data-slot="check"]')).toBeNull();
  expect(screen.getByTestId('unchecked-row')).toHaveAttribute('aria-pressed', 'false');
});

it('presses to the pressed fill when tappable, and not when static', () => {
  render(
    <>
      <ListRow title="A" onClick={jest.fn()} data-testid="tappable" />
      <ListRow title="B" data-testid="static" />
    </>
  );
  expect(screen.getByTestId('tappable')).toHaveClass('active:bg-fill-pressed');
  expect(screen.getByTestId('static')).not.toHaveClass('active:bg-fill-pressed');
});

it('does not fire a disabled row', () => {
  const onClick = jest.fn();
  render(<ListRow title="A" onClick={onClick} disabled data-testid="row" />);
  fireEvent.click(screen.getByTestId('row'));
  expect(onClick).not.toHaveBeenCalled();
  expect(hapticLight).not.toHaveBeenCalled();
});
