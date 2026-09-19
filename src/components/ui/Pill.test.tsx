import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight, hapticSelection } from 'lib/mobile/haptics';

import { Pill } from './Pill';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
});

it('renders a label as static text, with no button semantics', () => {
  render(
    <Pill data-testid="pill" icon={<svg data-testid="glyph" />}>
      Miden
    </Pill>
  );

  const pill = screen.getByTestId('pill');
  expect(pill.tagName).toBe('SPAN');
  expect(pill).toHaveTextContent('Miden');
  expect(screen.getByTestId('glyph')).toBeInTheDocument();
});

it('sizes a bare SVG icon, which the build leaves without width or height', () => {
  const { container } = render(<Pill icon={<svg data-testid="glyph" />}>Address Book</Pill>);

  const slot = container.querySelector('[data-testid="glyph"]')?.parentElement;
  expect(slot?.className).toContain('[&>svg]:h-full');
  expect(slot?.className).toContain('[&>svg]:w-full');
});

it('becomes a button when tappable, and reports its pressed state', () => {
  const onClick = jest.fn();
  render(
    <Pill data-testid="pill" onClick={onClick} selected tone="selected">
      Sepolia
    </Pill>
  );

  const pill = screen.getByTestId('pill');
  fireEvent.click(pill);

  expect(pill.tagName).toBe('BUTTON');
  expect(pill).toHaveAttribute('aria-pressed', 'true');
  expect(pill).toHaveClass('bg-accent-tint', 'text-accent-tint-ink');
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('keeps one geometry per size, whatever the tone', () => {
  const { rerender } = render(
    <Pill data-testid="pill" tone="neutral">
      A
    </Pill>
  );
  const neutral = screen.getByTestId('pill').className;

  rerender(
    <Pill data-testid="pill" tone="selected">
      A
    </Pill>
  );
  const selected = screen.getByTestId('pill').className;

  // Same height, padding and gap; only the colors differ. A selected pill that
  // added a border would be 2px wider than its neighbours.
  for (const geometry of ['h-8', 'px-3', 'gap-1.5', 'rounded-full', 'border']) {
    expect(neutral).toContain(geometry);
    expect(selected).toContain(geometry);
  }
});

it('is always positioned, so an absolutely-positioned sibling behind it paints underneath', () => {
  render(<Pill data-testid="pill">A</Pill>);
  expect(screen.getByTestId('pill')).toHaveClass('relative');
});

it('sizes small pills for status badges', () => {
  render(
    <Pill data-testid="pill" size="sm" tone="positive">
      Earning
    </Pill>
  );

  expect(screen.getByTestId('pill')).toHaveClass('h-6', 'px-2', 'text-badge', 'text-positive-tint-ink');
});

it('puts a status pill on its opaque tint, not a translucent wash of the status color', () => {
  render(
    <Pill data-testid="pill" tone="negative">
      Failed
    </Pill>
  );

  // A translucent wash takes on the surface beneath and fell under 4.5:1 on `fill`.
  expect(screen.getByTestId('pill')).toHaveClass('bg-negative-tint');
  expect(screen.getByTestId('pill').className).not.toMatch(/bg-status-negative\//);
});

it('renders a leading status dot in the tone’s own ink color', () => {
  const { container } = render(
    <Pill size="sm" tone="warning" dot>
      Pending
    </Pill>
  );

  const dot = container.querySelector('[aria-hidden="true"]');
  expect(dot).toHaveClass('bg-current', 'rounded-full');
});

it('does not render a dot unless asked', () => {
  const { container } = render(<Pill tone="positive">Earning</Pill>);
  expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
});

it('gives a seed word the same quiet fill as a neutral pill', () => {
  render(
    <Pill data-testid="pill" tone="word">
      apple
    </Pill>
  );

  expect(screen.getByTestId('pill')).toHaveClass('bg-fill', 'text-ink');
});

it('leaves color choices to the caller on a plain pill', () => {
  render(
    <Pill data-testid="pill" tone="plain" className="bg-network-miden-tint">
      Miden
    </Pill>
  );

  const pill = screen.getByTestId('pill');
  expect(pill).not.toHaveClass('bg-fill', 'bg-accent-tint');
  expect(pill).toHaveClass('bg-network-miden-tint');
});

it('defaults a plain pill’s border to transparent, so it never shows a stray currentColor ring', () => {
  render(
    <Pill data-testid="pill" tone="plain">
      Miden
    </Pill>
  );

  expect(screen.getByTestId('pill')).toHaveClass('border-transparent');
});

it('lets a caller’s own border color replace the plain-tone default instead of losing to it', () => {
  render(
    <Pill data-testid="pill" tone="plain" className="border-network-miden-border">
      Miden
    </Pill>
  );

  const pill = screen.getByTestId('pill');
  // `border-transparent` and the caller's border color are both "border-color" utilities;
  // whichever wins in Tailwind's compiled (alphabetical) order would otherwise silently beat
  // the caller's class regardless of prop order, so only one may be present here.
  expect(pill).toHaveClass('border-network-miden-border');
  expect(pill).not.toHaveClass('border-transparent');
});

describe('haptic', () => {
  it('fires hapticLight on every tap by default', () => {
    const onClick = jest.fn();
    render(
      <Pill data-testid="pill" onClick={onClick}>
        Paste
      </Pill>
    );

    fireEvent.click(screen.getByTestId('pill'));
    fireEvent.click(screen.getByTestId('pill'));

    expect(hapticLight).toHaveBeenCalledTimes(2);
    expect(hapticSelection).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('fires hapticSelection only when the tap actually selects (haptic="selection")', () => {
    const onClick = jest.fn();
    const { rerender } = render(
      <Pill data-testid="pill" onClick={onClick} haptic="selection" selected={false}>
        received
      </Pill>
    );

    fireEvent.click(screen.getByTestId('pill'));
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(hapticLight).not.toHaveBeenCalled();

    // Re-tapping an already-selected pill (the caller flips `selected` once it commits the
    // change) is silent — the equivalent of tapping the already-active filter twice.
    rerender(
      <Pill data-testid="pill" onClick={onClick} haptic="selection" selected>
        received
      </Pill>
    );
    fireEvent.click(screen.getByTestId('pill'));

    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('fires no haptic at all when haptic is false, leaving it to the caller', () => {
    const onClick = jest.fn();
    render(
      <Pill data-testid="pill" onClick={onClick} haptic={false}>
        received
      </Pill>
    );

    fireEvent.click(screen.getByTestId('pill'));

    expect(hapticLight).not.toHaveBeenCalled();
    expect(hapticSelection).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

it('does not fire while disabled', () => {
  const onClick = jest.fn();
  render(
    <Pill data-testid="pill" onClick={onClick} disabled>
      Max
    </Pill>
  );

  fireEvent.click(screen.getByTestId('pill'));

  expect(onClick).not.toHaveBeenCalled();
  expect(screen.getByTestId('pill')).toBeDisabled();
});

describe('variants', () => {
  it.each([
    ['neutral', ['bg-fill', 'text-ink', 'border-transparent']],
    ['word', ['bg-fill', 'text-ink', 'border-transparent']],
    ['selected', ['bg-accent-tint', 'text-accent-tint-ink', 'border-transparent']],
    ['positive', ['bg-positive-tint', 'text-positive-tint-ink', 'border-transparent']],
    ['warning', ['bg-pending-tint', 'text-pending-tint-ink', 'border-transparent']],
    ['negative', ['bg-negative-tint', 'text-negative-tint-ink', 'border-transparent']],
    ['inactive', ['bg-fill-pressed', 'text-ink', 'border-transparent']],
    ['plain', ['border-transparent']]
  ] as const)('gives the %s tone its colors', (tone, classes) => {
    render(
      <Pill data-testid="pill" tone={tone}>
        A
      </Pill>
    );
    expect(screen.getByTestId('pill')).toHaveClass(...classes);
  });

  it('defaults to the neutral tone at the md size', () => {
    render(<Pill data-testid="pill">A</Pill>);
    expect(screen.getByTestId('pill')).toHaveClass('bg-fill', 'text-ink', 'h-8', 'px-3', 'text-pill');
  });

  it.each([
    ['xs', ['h-5', 'gap-1', 'px-2', 'text-badge', 'font-semibold'], ['-ml-0.5', 'h-3', 'w-3']],
    ['sm', ['h-6', 'gap-1', 'px-2', 'text-badge'], ['-ml-0.5', 'h-3.5', 'w-3.5']],
    ['md', ['h-8', 'gap-1.5', 'px-3', 'text-pill'], ['-ml-1', 'h-4', 'w-4']]
  ] as const)('sizes the %s pill and its icon box', (size, pillClasses, iconClasses) => {
    render(
      <Pill data-testid="pill" size={size} icon={<svg data-testid="glyph" />}>
        A
      </Pill>
    );
    expect(screen.getByTestId('pill')).toHaveClass('rounded-full', 'border', ...pillClasses);
    expect(screen.getByTestId('glyph').parentElement).toHaveClass('shrink-0', ...iconClasses);
  });
});

it('draws an inverse pill as a darker well of the colored surface under it, in that surface’s ink', () => {
  render(
    <Pill data-testid="pill" tone="inverse">
      0.00 (0.00%)
    </Pill>
  );

  expect(screen.getByTestId('pill')).toHaveClass('bg-surface-balance-pill', 'text-surface-balance-fg');
});
