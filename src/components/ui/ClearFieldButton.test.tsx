import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { ClearFieldButton } from './ClearFieldButton';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const clearButton = () => screen.getByRole('button', { name: 'clear' });

describe('ClearFieldButton', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a button named by the localized clear key, the muted close-circle glyph in a 44px target', () => {
    render(<ClearFieldButton onClear={jest.fn()} />);
    expect(clearButton()).toHaveAttribute('type', 'button');
    expect(clearButton()).toHaveClass('h-11', 'w-11', 'text-muted');
    expect(clearButton().querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(clearButton().querySelector('svg')).toHaveClass('h-5', 'w-5');
  });

  it('clears with the tap haptic', () => {
    const onClear = jest.fn();
    render(<ClearFieldButton onClear={onClear} />);
    fireEvent.click(clearButton());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('does not take focus from the field when pressed', () => {
    render(<ClearFieldButton onClear={jest.fn()} />);
    // fireEvent returns false once a handler has called preventDefault.
    expect(fireEvent.mouseDown(clearButton())).toBe(false);
  });

  it('does not submit the form its field sits in', () => {
    const onSubmit = jest.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ClearFieldButton onClear={jest.fn()} />
      </form>
    );
    fireEvent.click(clearButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('takes its position from the caller', () => {
    render(<ClearFieldButton onClear={jest.fn()} className="absolute right-0" />);
    expect(clearButton()).toHaveClass('absolute', 'right-0', 'h-11');
  });
});
