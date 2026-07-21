import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import PromptCardDefault, { PromptCard } from './PromptCard';

// Surface each icon's `name` so the two Trail branches (Close vs ChevronRight)
// are distinguishable from the DOM. All other icon props are ignored.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: {
    Close: 'Close',
    ChevronRight: 'ChevronRight'
  }
}));

// Native haptic buzz — spy so we can assert exactly when it fires.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

const mockHapticLight = hapticLight as jest.MockedFunction<typeof hapticLight>;

const renderCard = (props: Partial<React.ComponentProps<typeof PromptCard>> = {}) =>
  render(<PromptCard title="Back up your wallet" {...props} />);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PromptCard — exports & structure', () => {
  it('exposes the same component as the default and named export', () => {
    expect(PromptCardDefault).toBe(PromptCard);
  });

  it('renders the title and the base container classes', () => {
    const { container } = renderCard();

    const title = screen.getByText('Back up your wallet');
    expect(title).toBeTruthy();
    expect(title.className).toContain('font-bold');
    expect(title.className).toContain('truncate');

    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('bg-surface-input');
    expect(root.className).toContain('rounded-10');
  });

  it('appends a caller-supplied className to the container', () => {
    const { container } = renderCard({ className: 'my-extra-class' });

    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('my-extra-class');
    // Base classes still present alongside the override.
    expect(root.className).toContain('flex');
  });

  it('accepts a variant prop without altering output (unused styling hook)', () => {
    // `variant` is part of the public props but has no rendered effect today;
    // passing each value must not throw or change the title.
    (['default', 'warning', 'critical'] as const).forEach(variant => {
      const { unmount } = renderCard({ variant });
      expect(screen.getByText('Back up your wallet')).toBeTruthy();
      unmount();
    });
  });
});

describe('PromptCard — body rendering', () => {
  it('renders the body text when provided', () => {
    renderCard({ body: 'Write down your recovery phrase' });

    const body = screen.getByText('Write down your recovery phrase');
    expect(body).toBeTruthy();
    expect(body.className).toContain('text-xs');
  });

  it('omits the body element entirely when no body is passed', () => {
    renderCard();
    expect(screen.queryByText('Write down your recovery phrase')).toBeNull();
  });

  it('omits the body element when body is an empty string (falsy branch)', () => {
    const { container } = renderCard({ body: '' });
    // Only the title lives in the text column — no second text node.
    const column = container.querySelector('.flex-col') as HTMLElement;
    expect(column.querySelectorAll('div')).toHaveLength(1);
  });
});

describe('PromptCard — Trail: dismiss vs chevron', () => {
  it('renders the chevron affordance (no dismiss) when onDismiss is absent', () => {
    renderCard();

    expect(screen.getByTestId('icon').getAttribute('data-name')).toBe('ChevronRight');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('renders a Dismiss button with the Close icon when onDismiss is provided', () => {
    renderCard({ onDismiss: jest.fn() });

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss.getAttribute('type')).toBe('button');
    expect(screen.getByTestId('icon').getAttribute('data-name')).toBe('Close');
  });
});

describe('PromptCard — onClick behaviour', () => {
  it('exposes a button role and buzzes then calls onClick when clicked', () => {
    const onClick = jest.fn();
    const { container } = renderCard({ onClick });

    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('role')).toBe('button');

    fireEvent.click(root);

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has no button role and does not buzz when onClick is absent', () => {
    const { container } = renderCard();

    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('role')).toBeNull();

    // Clicking the row is a no-op — no handler wired, no haptic.
    fireEvent.click(root);
    expect(mockHapticLight).not.toHaveBeenCalled();
  });
});

describe('PromptCard — onDismiss behaviour', () => {
  it('buzzes then calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = jest.fn();
    renderCard({ onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('stops propagation so a co-present onClick does NOT fire when dismissing', () => {
    const onClick = jest.fn();
    const onDismiss = jest.fn();
    renderCard({ onClick, onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // Only the dismiss path runs; the row's onClick is shielded by stopPropagation.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    // A single buzz — from the dismiss handler only.
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });

  it('still routes a row click to onClick when the row itself (not dismiss) is clicked', () => {
    const onClick = jest.fn();
    const onDismiss = jest.fn();
    const { container } = renderCard({ onClick, onDismiss });

    fireEvent.click(container.firstChild as HTMLElement);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });
});
