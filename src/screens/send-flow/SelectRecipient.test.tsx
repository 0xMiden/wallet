import React, { ChangeEvent } from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

// react-i18next: return the key verbatim so we can assert on translation keys
// (mirrors sibling atom tests such as ColorIdenticon/SeedWordInput).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `components/Button` pulls in framer-motion, Capacitor haptics and the icon
// barrel transitively. We stub it with a plain <button> that still renders
// `iconLeft` (so the internal AddressBookIcon SVG is exercised) and forwards
// onClick/disabled/className/data-testid, keeping the test focused on
// SelectRecipient's own branches.
jest.mock('components/Button', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
    Button: ({ variant: _variant, title, iconLeft, children, ...rest }: any) =>
      ReactMock.createElement('button', { type: 'button', ...rest }, iconLeft, children ?? title)
  };
});

import { SelectRecipient, SelectRecipientProps } from './SelectRecipient';

// jsdom does not lay out elements, so `scrollHeight` is 0 by default. Pin it to
// a deterministic value so we can assert that the auto-grow effect ran and set
// the textarea height from `scrollHeight`.
beforeAll(() => {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return 77;
    }
  });
});

const renderComponent = (overrides: Partial<SelectRecipientProps> = {}) => {
  const props: SelectRecipientProps = {
    address: '',
    isValidAddress: false,
    error: undefined,
    onAddressChange: jest.fn(),
    onAddressBook: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
  };
  const utils = render(<SelectRecipient {...props} />);
  return { props, ...utils };
};

const getTextarea = () => screen.getByTestId('send-recipient-input') as HTMLTextAreaElement;
const getConfirm = () => screen.getByTestId('send-recipient-confirm') as HTMLButtonElement;

describe('SelectRecipient', () => {
  it('renders the heading, placeholder, address-book and confirm buttons', () => {
    renderComponent();

    // Heading + labels come through as raw i18n keys via the mocked translator.
    expect(screen.getByText('chooseRecipient')).toBeInTheDocument();
    expect(getTextarea()).toHaveAttribute('placeholder', 'enterMidenOrEthereumAddress');
    expect(screen.getByText('addressBook')).toBeInTheDocument();
    expect(getConfirm()).toHaveTextContent('confirm');

    // The internal AddressBookIcon SVG is rendered inside the address-book button.
    expect(document.querySelector('svg')).not.toBeNull();
  });

  it('reflects the address prop as the textarea value', () => {
    renderComponent({ address: 'mtst1abc' });
    expect(getTextarea()).toHaveValue('mtst1abc');
  });

  it('runs the auto-grow effect, sizing the textarea from scrollHeight', () => {
    renderComponent({ address: 'a' });
    // Effect sets height to `${scrollHeight}px` (pinned to 77 above).
    expect(getTextarea().style.height).toBe('77px');
  });

  it('re-runs the auto-grow effect when the address changes', () => {
    const { rerender, props } = renderComponent({ address: 'a' });
    expect(getTextarea().style.height).toBe('77px');

    // Blow away the inline height, then rerender with a new address to prove
    // the [address]-keyed effect fires again and re-applies the height.
    getTextarea().style.height = '';
    rerender(<SelectRecipient {...props} address="ab" />);
    expect(getTextarea().style.height).toBe('77px');
  });

  describe('error branch', () => {
    it('does not render the error paragraph and uses the black text class when there is no error', () => {
      renderComponent({ error: undefined });
      expect(screen.queryByText('invalidAddress')).not.toBeInTheDocument();
      const ta = getTextarea();
      expect(ta.className).toContain('text-black');
      expect(ta.className).not.toContain('text-red-500');
    });

    it('renders the translated error paragraph and uses the red text class when there is an error', () => {
      renderComponent({ error: 'invalidAddress' });
      // The <p> renders the translated (key-echoed) error message.
      const paragraph = screen.getByText('invalidAddress');
      expect(paragraph.tagName.toLowerCase()).toBe('p');
      expect(paragraph).toHaveClass('text-red-500');
      // The textarea itself flips to the red text class.
      expect(getTextarea().className).toContain('text-red-500');
    });
  });

  describe('confirm button enabled state', () => {
    it('disables the confirm button when the address is invalid', () => {
      renderComponent({ isValidAddress: false });
      expect(getConfirm()).toBeDisabled();
    });

    it('enables the confirm button when the address is valid', () => {
      renderComponent({ isValidAddress: true });
      expect(getConfirm()).toBeEnabled();
    });
  });

  describe('callbacks', () => {
    it('calls onAddressChange when the textarea changes', () => {
      // Capture the value synchronously inside the handler: the textarea is
      // controlled (value={address}), so React reverts the DOM value after the
      // event and reading `event.target.value` afterwards would see ''.
      let seenValue: string | undefined;
      const onAddressChange = jest.fn((event: ChangeEvent<HTMLTextAreaElement>) => {
        seenValue = event.target.value;
      });
      renderComponent({ onAddressChange });
      fireEvent.change(getTextarea(), { target: { value: 'newaddr' } });
      expect(onAddressChange).toHaveBeenCalledTimes(1);
      expect(seenValue).toBe('newaddr');
    });

    it('calls onAddressBook when the address-book button is clicked', () => {
      const { props } = renderComponent();
      fireEvent.click(screen.getByText('addressBook'));
      expect(props.onAddressBook).toHaveBeenCalledTimes(1);
    });

    it('calls onConfirm when the enabled confirm button is clicked', () => {
      const { props } = renderComponent({ isValidAddress: true });
      fireEvent.click(getConfirm());
      expect(props.onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});
