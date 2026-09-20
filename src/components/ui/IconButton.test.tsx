import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

import { IconButton } from './IconButton';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className, fill }: { name: string; size?: string; className?: string; fill?: string }) => (
    <svg data-testid={`icon-${name}`} data-size={size} data-fill={fill} className={className} />
  ),
  IconName: { ChevronLeft: 'chevron-left', Close: 'close', Search: 'search' }
}));

beforeEach(() => jest.clearAllMocks());

describe('appearance="bare" (default)', () => {
  it('is a 24px glyph alone in a 44px hit area, ink, with no background', () => {
    render(<IconButton icon={IconName.ChevronLeft} label="Back" onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Back' });
    expect(button.className).toContain('h-11');
    expect(button.className).toContain('w-11');
    expect(button.className).toContain('text-ink');
    expect(button.className).not.toMatch(/\bbg-/);

    const icon = screen.getByTestId('icon-chevron-left');
    expect(icon).toHaveAttribute('data-size', 'md');
    expect(icon).toHaveAttribute('data-fill', 'currentColor');
  });

  it('has no aria-pressed when active is omitted — a plain action, not a toggle', () => {
    render(<IconButton icon={IconName.Close} label="Close" onClick={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveAttribute('aria-pressed');
  });

  it('switches to the accent color and aria-pressed when active', () => {
    const { rerender } = render(
      <IconButton icon={IconName.Search} label="Search" active={false} onClick={jest.fn()} />
    );
    const inactive = screen.getByRole('button', { name: 'Search' });
    expect(inactive.className).toContain('text-ink');
    expect(inactive).toHaveAttribute('aria-pressed', 'false');

    rerender(<IconButton icon={IconName.Search} label="Search" active onClick={jest.fn()} />);
    const active = screen.getByRole('button', { name: 'Search' });
    expect(active.className).toContain('text-accent-primary');
    expect(active).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('appearance="circle"', () => {
  it('is a 32px circle on fill with a muted 20px glyph by default', () => {
    render(<IconButton icon={IconName.Close} label="Close" appearance="circle" onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('w-8');
    expect(button.className).toContain('bg-fill');
    expect(button.className).toContain('text-muted');

    const icon = screen.getByTestId('icon-close');
    expect(icon).toHaveAttribute('data-size', 'sm');
  });

  it('renders the 36px variant when circleSize="36"', () => {
    render(<IconButton icon={IconName.Close} label="Close" appearance="circle" circleSize="36" onClick={jest.fn()} />);

    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.className).toContain('h-9');
    expect(button.className).toContain('w-9');
    expect(button.className).not.toContain('h-8');
  });
});

it('carries the color-transition micro-interaction, not a literal duration', () => {
  render(<IconButton icon={IconName.Close} label="Close" onClick={jest.fn()} />);
  const button = screen.getByRole('button', { name: 'Close' });
  expect(button.className).toContain('transition-colors');
  expect(button.className).toMatch(/duration-\d/);
});

it('buzzes, then calls onClick, and is never a form submit', () => {
  const onClick = jest.fn();
  render(<IconButton icon={IconName.Close} label="Close" onClick={onClick} data-testid="icon-btn" />);

  const button = screen.getByTestId('icon-btn');
  expect(button).toHaveAttribute('type', 'button');
  fireEvent.click(button);

  expect(hapticLight).toHaveBeenCalledTimes(1);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('does not fire onClick or haptics while disabled', () => {
  const onClick = jest.fn();
  render(<IconButton icon={IconName.Close} label="Close" onClick={onClick} disabled />);

  const button = screen.getByRole('button', { name: 'Close' });
  expect(button).toBeDisabled();
  fireEvent.click(button);

  expect(onClick).not.toHaveBeenCalled();
  expect(hapticLight).not.toHaveBeenCalled();
});

it('keeps className for layout only, alongside the variant classes', () => {
  render(<IconButton icon={IconName.Close} label="Close" onClick={jest.fn()} className="ml-2" />);
  const button = screen.getByRole('button', { name: 'Close' });
  expect(button.className).toContain('ml-2');
  expect(button.className).toContain('h-11');
});

it('forwards a data-testid', () => {
  render(<IconButton icon={IconName.Close} label="Close" onClick={jest.fn()} data-testid="my-icon-button" />);
  expect(screen.getByTestId('my-icon-button')).toBeInTheDocument();
});

describe('IconButton 44px circle', () => {
  it('draws a page header back button: a 44px fill circle with an ink, medium glyph', () => {
    render(<IconButton icon={IconName.ArrowLeft} appearance="circle" circleSize="44" label="Back" />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(button).toHaveClass('bg-fill', 'h-11', 'w-11', 'text-ink');
    expect(button).not.toHaveClass('text-muted');
  });
});
