import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Pill } from './Pill';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

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
    <Pill data-testid="pill" onClick={onClick} selected accent="send" tone="selected">
      Sepolia
    </Pill>
  );

  const pill = screen.getByTestId('pill');
  fireEvent.click(pill);

  expect(pill.tagName).toBe('BUTTON');
  expect(pill).toHaveAttribute('aria-pressed', 'true');
  expect(pill).toHaveClass('border-accent-send', 'bg-accent-send-tint');
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
    <Pill data-testid="pill" tone="selected" accent="send">
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

it('sizes small pills for badges', () => {
  render(
    <Pill data-testid="pill" size="sm" tone="positive">
      Earning
    </Pill>
  );

  expect(screen.getByTestId('pill')).toHaveClass('h-6', 'px-2', 'text-xs', 'text-status-positive');
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
