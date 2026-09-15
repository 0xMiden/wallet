import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ScreenHeader } from './ScreenHeader';

// Every consumer of ScreenHeader mocks it, so nothing exercised the real
// component — the title-less branch below is the production path for all five
// transaction success receipts and had no coverage at all.
jest.mock('components/CircleButton', () => ({
  CircleButton: ({ icon, onClick, className, color, ...rest }: Record<string, unknown>) => (
    <button
      type="button"
      data-testid="circle-button"
      data-icon={String(icon)}
      data-color={String(color)}
      className={String(className ?? '')}
      onClick={onClick as () => void}
      {...rest}
    />
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="v2-icon" data-icon={name} className={className} />
  ),
  IconName: new Proxy({}, { get: (_t, prop) => String(prop) })
}));

describe('with a title', () => {
  it('renders it as the page h1', () => {
    render(<ScreenHeader title="Send" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Send' })).toBeInTheDocument();
  });

  it('still renders the h1 when both affordances are present', () => {
    render(<ScreenHeader title="Send" onBack={jest.fn()} onClose={jest.fn()} backLabel="back" closeLabel="close" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
  });
});

describe('without a title', () => {
  it('renders no heading rather than an empty one', () => {
    render(<ScreenHeader title="" onClose={jest.fn()} closeLabel="close" />);

    // An `<h1></h1>` announced a nameless level-1 heading ahead of the receipt's
    // real title, which lives in the body under the hero.
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('keeps a flex spacer so the close button stays pinned right', () => {
    const { container } = render(<ScreenHeader title="" onClose={jest.fn()} closeLabel="close" />);

    // Dropping the element entirely instead of swapping it for a spacer would
    // collapse the row and pull close in against the left edge.
    expect(container.querySelector('div > div.flex-1')).not.toBeNull();
  });

  it('treats a rendered-but-empty node the same way', () => {
    render(<ScreenHeader title={null} onClose={jest.fn()} closeLabel="close" />);

    expect(screen.queryByRole('heading')).toBeNull();
  });
});

it('invokes both callbacks', () => {
  const onBack = jest.fn();
  const onClose = jest.fn();
  render(<ScreenHeader title="Send" onBack={onBack} onClose={onClose} backLabel="back" closeLabel="close" />);

  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  fireEvent.click(screen.getByRole('button', { name: 'close' }));

  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('omits each affordance when its handler is absent', () => {
  render(<ScreenHeader title="Send" />);

  expect(screen.queryByRole('button')).toBeNull();
});
