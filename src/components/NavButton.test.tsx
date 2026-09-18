import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

import { NavButton } from './NavButton';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className }: { name: string; size?: string; className?: string }) => (
    <svg data-testid="glyph" data-name={name} data-size={size} className={className} />
  ),
  IconName: { ChevronLeft: 'chevron-left', Close: 'close' }
}));

beforeEach(() => jest.clearAllMocks());

it('bare: a 24px glyph alone in a 44px hit area, for page headers', () => {
  render(
    <NavButton
      icon={IconName.ChevronLeft}
      label="Back"
      onClick={jest.fn()}
      appearance="bare"
      iconClassName="text-ink"
    />
  );

  const button = screen.getByRole('button', { name: 'Back' });
  expect(button).toHaveClass('h-11', 'w-11');
  expect(button).not.toHaveClass('bg-surface-nav-button');
  const glyph = screen.getByTestId('glyph');
  expect(glyph).toHaveAttribute('data-name', 'chevron-left');
  expect(glyph).toHaveAttribute('data-size', 'md');
  expect(glyph).toHaveClass('text-ink');
});

it('circle: a 36px button on the nav-button fill with the small grey glyph by default', () => {
  render(<NavButton icon={IconName.Close} label="Close" onClick={jest.fn()} />);

  const button = screen.getByRole('button', { name: 'Close' });
  expect(button).toHaveClass('h-9', 'w-9', 'bg-surface-nav-button');
  const glyph = screen.getByTestId('glyph');
  expect(glyph).toHaveAttribute('data-size', 'sm');
  expect(glyph).toHaveClass('text-heading-gray');
});

it('buzzes, then calls onClick, and is never a form submit', () => {
  const onClick = jest.fn();
  render(<NavButton icon={IconName.Close} label="Close" onClick={onClick} data-testid="nav-close" />);

  const button = screen.getByTestId('nav-close');
  expect(button).toHaveAttribute('type', 'button');
  fireEvent.click(button);

  expect(hapticLight).toHaveBeenCalledTimes(1);
  expect(onClick).toHaveBeenCalledTimes(1);
});
