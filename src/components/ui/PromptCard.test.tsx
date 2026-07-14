import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { PromptCard } from './PromptCard';

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { ChevronRight: 'ChevronRight', Close: 'Close' }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

describe('PromptCard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the card action when its content is clicked', () => {
    const onClick = jest.fn();
    render(<PromptCard title="Fund your wallet" onClick={onClick} />);

    fireEvent.click(screen.getByText('Fund your wallet'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('runs the CTA exactly once without bubbling to the card action', () => {
    const onClick = jest.fn();
    const onAction = jest.fn();
    render(<PromptCard title="Fund your wallet" onClick={onClick} actionLabel="Fund now" onAction={onAction} />);

    fireEvent.click(screen.getByRole('button', { name: 'Fund now' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('dismisses without invoking either card action', () => {
    const onClick = jest.fn();
    const onAction = jest.fn();
    const onDismiss = jest.fn();
    render(
      <PromptCard
        title="Fund your wallet"
        onClick={onClick}
        actionLabel="Fund now"
        onAction={onAction}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not invoke a disabled CTA', () => {
    const onAction = jest.fn();
    render(<PromptCard title="Fund your wallet" actionLabel="Fund now" onAction={onAction} actionDisabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Fund now' }));

    expect(onAction).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
  });
});
