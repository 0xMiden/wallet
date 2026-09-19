import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { PasscodeScreen } from './PasscodeScreen';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { Backspace: 'backspace', FaceId: 'face-id' }
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticError: jest.fn()
}));

const noop = () => undefined;

const renderScreen = (props: Partial<React.ComponentProps<typeof PasscodeScreen>> = {}) =>
  render(
    <PasscodeScreen
      data-testid="some-passcode"
      title="title"
      message="message"
      filled={0}
      length={6}
      onDigit={noop}
      onDelete={noop}
      {...props}
    />
  );

describe('PasscodeScreen', () => {
  it('groups the prompt and the keypad, splitting the free height 3:2 above and below', () => {
    renderScreen();

    const layout = screen.getByTestId('passcode-screen-layout');
    expect(layout).toHaveClass('min-h-full', 'flex', 'flex-col');
    // Prompt and keypad sit together as one group: the leftover height splits 3:2 above and below.
    const dock = screen.getByTestId('passcode-keypad-dock');
    expect(dock.previousElementSibling).toBe(screen.getByTestId('passcode-header'));
    expect(layout.lastElementChild).toBe(screen.getByTestId('passcode-bottom-space'));
    expect(dock).toHaveClass('shrink-0', 'pt-12');
    expect(screen.getByTestId('passcode-top-space')).toHaveClass('flex-[3]');
    expect(screen.getByTestId('passcode-bottom-space')).toHaveClass('flex-[2]');
    expect(dock).toContainElement(screen.getByTestId('numpad'));
    // Its last row stays 20px above the body's safe-area padding.
    expect(layout).toHaveClass('pb-5');
    // The header block holds the title, the message and the dots, above the keypad.
    const header = screen.getByTestId('passcode-header');
    expect(header).toContainElement(screen.getByRole('heading', { name: 'title' }));
    expect(header).toContainElement(screen.getByTestId('passcode-dots'));
  });

  it('tightens the gap above the keypad on a short viewport so everything fits without scrolling', () => {
    renderScreen();

    expect(screen.getByTestId('passcode-keypad-dock')).toHaveClass('[@media(max-height:720px)]:pt-8');
  });

  it('puts the root test id on the page', () => {
    renderScreen();

    expect(screen.getByTestId('some-passcode')).toHaveClass('h-full', 'bg-page');
  });

  it('shows the message muted, or in negative-ink when it is an error', () => {
    const { rerender } = renderScreen();
    expect(screen.getByRole('status')).toHaveTextContent('message');
    expect(screen.getByRole('status')).toHaveClass('text-muted');

    rerender(
      <PasscodeScreen
        title="title"
        message="wrong"
        isError
        filled={0}
        length={6}
        errorKey={1}
        onDigit={noop}
        onDelete={noop}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('wrong');
    expect(screen.getByRole('status')).toHaveClass('text-negative-ink');
    expect(screen.getByTestId('passcode-dots')).toHaveAttribute('data-shake', 'true');
  });

  it('fills one dot per entered digit', () => {
    renderScreen({ filled: 4 });

    const filled = screen.getAllByTestId('passcode-dot').filter(dot => dot.getAttribute('data-filled') === 'true');
    expect(filled).toHaveLength(4);
  });

  it('renders the action centred under the keypad, after it in DOM order', () => {
    renderScreen({ action: <button type="button">forgot</button> });

    const forgot = screen.getByRole('button', { name: 'forgot' });
    const header = screen.getByTestId('passcode-screen-layout').firstElementChild as HTMLElement;
    expect(header).not.toContainElement(forgot);
    const dock = screen.getByTestId('passcode-keypad-dock');
    const slot = screen.getByTestId('passcode-screen-action');
    // The keypad, then the action: the dock's last child, centred, 8px under the last key row.
    expect(dock.lastElementChild).toBe(slot);
    expect(dock.firstElementChild).toBe(screen.getByTestId('numpad'));
    expect(slot).toContainElement(forgot);
    expect(slot).toHaveClass('flex', 'justify-center', 'mt-2');
    expect(
      screen.getByTestId('numpad').compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('takes the room for the action from the padding under the keypad', () => {
    const { rerender } = renderScreen();
    expect(screen.getByTestId('passcode-screen-layout')).toHaveClass('pb-5');

    rerender(
      <PasscodeScreen
        title="title"
        message="message"
        filled={0}
        length={6}
        onDigit={noop}
        onDelete={noop}
        action={<button type="button">forgot</button>}
      />
    );
    const layout = screen.getByTestId('passcode-screen-layout');
    expect(layout).toHaveClass('pb-2');
    expect(layout).not.toHaveClass('pb-5');
    expect(screen.getByTestId('passcode-keypad-dock')).toHaveClass('pt-12');
  });

  it('forwards keypad presses and the biometric key', () => {
    const onDigit = jest.fn();
    const onDelete = jest.fn();
    const onBiometric = jest.fn();
    renderScreen({ onDigit, onDelete, onBiometric });

    fireEvent.click(screen.getByTestId('numpad-7'));
    fireEvent.click(screen.getByTestId('numpad-delete'));
    fireEvent.click(screen.getByTestId('numpad-biometric'));
    expect(onDigit).toHaveBeenCalledWith('7');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onBiometric).toHaveBeenCalledTimes(1);
  });
});
