import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { ImportHotKeyScreen } from './ImportHotKey';

// i18n echoes keys so assertions match what the component asks for.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Leaf stubs in the ImportSeedPhrase.test style: expose the props the screen
// drives, nothing more.
jest.mock('components/Input', () => ({
  Input: (props: any) => (
    <input
      data-testid="hot-key-input"
      type={props.type}
      value={props.value ?? ''}
      placeholder={props.placeholder}
      onChange={props.onChange}
    />
  )
}));

jest.mock('components/Button', () => ({
  Button: (props: any) => (
    <button data-testid="import-hot-key-submit" disabled={props.disabled} onClick={props.onClick}>
      {props.title}
    </button>
  )
}));

const SCALAR_HEX = 'ab'.repeat(32);

const typeKey = (value: string) => fireEvent.change(screen.getByTestId('hot-key-input'), { target: { value } });
const submit = () => fireEvent.click(screen.getByTestId('import-hot-key-submit'));

describe('ImportHotKeyScreen', () => {
  it('renders title, description and a disabled continue button by default', () => {
    render(<ImportHotKeyScreen />);

    expect(screen.getByText('importHotKeyTitle')).toBeInTheDocument();
    expect(screen.getByText('importHotKeyDescription')).toBeInTheDocument();
    expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
    // The paste field masks the key — it is signing material.
    expect(screen.getByTestId('hot-key-input')).toHaveAttribute('type', 'password');
  });

  it('enables continue for a valid key and submits the normalized hex', () => {
    const onSubmit = jest.fn();
    render(<ImportHotKeyScreen onSubmit={onSubmit} />);

    typeKey(`0x${SCALAR_HEX.toUpperCase()}`);
    expect(screen.getByTestId('import-hot-key-submit')).not.toBeDisabled();

    submit();
    expect(onSubmit).toHaveBeenCalledWith(SCALAR_HEX);
  });

  it('accepts the 66-hex serialized form too', () => {
    const onSubmit = jest.fn();
    render(<ImportHotKeyScreen onSubmit={onSubmit} />);

    typeKey(`01${SCALAR_HEX}`);
    submit();

    expect(onSubmit).toHaveBeenCalledWith(`01${SCALAR_HEX}`);
  });

  it('shows the format error for junk input and keeps continue disabled', () => {
    const onSubmit = jest.fn();
    render(<ImportHotKeyScreen onSubmit={onSubmit} />);

    typeKey('not-a-key');

    expect(screen.getByText('importHotKeyInvalid')).toBeInTheDocument();
    expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows no format error while the field is empty', () => {
    render(<ImportHotKeyScreen />);

    expect(screen.queryByText('importHotKeyInvalid')).not.toBeInTheDocument();
  });

  it('disables continue while submitting', () => {
    render(<ImportHotKeyScreen submitting />);

    typeKey(SCALAR_HEX);
    expect(screen.getByTestId('import-hot-key-submit')).toBeDisabled();
  });
});
