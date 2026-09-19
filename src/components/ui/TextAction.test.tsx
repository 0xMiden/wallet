import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import TextActionDefault, { TextAction } from './TextAction';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

describe('TextAction', () => {
  it('exports the component as the default export', () => {
    expect(TextActionDefault).toBe(TextAction);
  });

  it('renders an accent-tint-ink button with no underline and a 44px hit area', () => {
    render(<TextAction>Learn more</TextAction>);
    const action = screen.getByRole('button', { name: 'Learn more' });
    expect(action).toHaveAttribute('type', 'button');
    expect(action).toHaveClass('text-accent-tint-ink', 'min-h-11', 'font-heading', 'font-bold');
    expect(action.className).not.toMatch(/underline|text-primary-500|text-accent-primary\b/);
  });

  it('fires the tap haptic and the handler, and forwards attributes', () => {
    const onClick = jest.fn();
    render(
      <TextAction onClick={onClick} aria-expanded={false} data-testid="action">
        Use a custom URL
      </TextAction>
    );
    fireEvent.click(screen.getByTestId('action'));
    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('action')).toHaveAttribute('aria-expanded', 'false');
  });
});
