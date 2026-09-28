import React from 'react';

import { render, screen } from '@testing-library/react';

import { UnreadDot } from './UnreadDot';

describe('UnreadDot', () => {
  it('renders nothing at all when there is nothing unread', () => {
    const { container } = render(<UnreadDot unread={false} label="Unread" />);

    // Not hidden - absent.
    expect(container).toBeEmptyDOMElement();
  });

  it('is the notification token, never the error red', () => {
    render(<UnreadDot unread label="Unread" data-testid="dot" />);

    expect(screen.getByTestId('dot')).toHaveClass('bg-notification');
    expect(screen.getByTestId('dot')).not.toHaveClass('bg-status-negative');
  });

  it('sits in the row margin by default and on an icon corner as a badge', () => {
    const { rerender } = render(<UnreadDot unread label="Unread" data-testid="dot" />);
    expect(screen.getByTestId('dot')).toHaveClass('absolute', 'left-1', 'size-2');

    rerender(<UnreadDot unread placement="badge" label="Unread" data-testid="dot" />);
    expect(screen.getByTestId('dot')).toHaveClass('-top-0.5', '-right-0.5', 'ring-2', 'ring-page');
  });

  it('carries its own label, so the dot is never colour alone', () => {
    render(
      <button type="button">
        Received 1 TOK
        <UnreadDot unread label="Unread" />
      </button>
    );

    expect(screen.getByRole('button', { name: 'Received 1 TOK Unread' })).toBeTruthy();
  });

  it('has no live region: a list refreshing must not announce anything', () => {
    const { container } = render(<UnreadDot unread label="Unread" />);

    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
