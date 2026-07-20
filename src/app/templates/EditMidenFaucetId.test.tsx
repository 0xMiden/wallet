import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { setFaucetIdSetting } from 'lib/miden/assets';

import EditMidenFaucetId from './EditMidenFaucetId';

// ---------------------------------------------------------------------------
// Mocks.
//
// EditMidenFaucetId is a thin form over `useMidenFaucetId()` (current id) and
// `setFaucetIdSetting()` (persist). We stub every collaborator so the only real
// code exercised (and measured) is EditMidenFaucetId.tsx itself.
// ---------------------------------------------------------------------------

// i18n: identity translator so assertions can match on the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The current-faucet-id hook — scripted per test.
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: jest.fn()
}));

// `lib/miden/assets` is a barrel over storage/native-asset plumbing; the
// component only uses `setFaucetIdSetting`.
jest.mock('lib/miden/assets', () => ({
  setFaucetIdSetting: jest.fn()
}));

// `FormField` pulls in analytics/tippy plumbing; a forwardRef <input> is enough
// for react-hook-form to register the field via `ref` and read its value on
// submit. It also surfaces `errorCaption` so the submit-error branch is
// assertable, and wires the component's custom `onChange` (which overrides
// register's own onChange in the source).
jest.mock('app/atoms/FormField', () =>
  React.forwardRef(
    (
      {
        name,
        id,
        type,
        placeholder,
        errorCaption,
        onChange,
        onBlur
      }: {
        name?: string;
        id?: string;
        type?: string;
        placeholder?: string;
        errorCaption?: string;
        onChange?: React.ChangeEventHandler<HTMLInputElement>;
        onBlur?: React.FocusEventHandler<HTMLInputElement>;
      },
      ref: React.Ref<HTMLInputElement>
    ) => (
      <span>
        <input
          ref={ref}
          name={name}
          id={id}
          type={type}
          placeholder={placeholder}
          onChange={onChange}
          onBlur={onBlur}
          data-testid={`field-${name}`}
        />
        {errorCaption ? <span data-testid={`error-${name}`}>{errorCaption}</span> : null}
      </span>
    )
  )
);

// `FormSubmitButton` defaults to type="submit"; render a plain submit button so
// clicking it drives the form's onSubmit, and expose the loading (isSubmitting)
// flag so the in-flight state is assertable.
jest.mock('app/atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: ({
    children,
    loading,
    disabled
  }: {
    children?: React.ReactNode;
    loading?: boolean;
    disabled?: boolean;
  }) => (
    <button type="submit" disabled={disabled} data-loading={String(!!loading)} data-testid="submit-btn">
      {children}
    </button>
  )
}));

const mockUseMidenFaucetId = useMidenFaucetId as jest.Mock;
const mockSetFaucetIdSetting = setFaucetIdSetting as jest.Mock;

const field = () => screen.getByTestId('field-faucetId') as HTMLInputElement;
const form = () => document.querySelector('form') as HTMLFormElement;

// Type a value, then blur. The component overrides register's `onChange` (with
// its own clear-errors handler) but leaves register's `onBlur` intact, so — as
// in the real app, where clicking the submit button first blurs the focused
// input — react-hook-form captures the field value on blur. Without this,
// `_formValues.faucetId` stays empty and the `required` rule blocks submit.
const prime = (value: string) => {
  fireEvent.change(field(), { target: { value } });
  fireEvent.blur(field());
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseMidenFaucetId.mockReturnValue('0xcurrentfaucet');
  mockSetFaucetIdSetting.mockResolvedValue(undefined);
});

describe('EditMidenFaucetId', () => {
  it('renders the form and seeds the placeholder from the current faucet id', () => {
    render(<EditMidenFaucetId />);

    // Static copy (t echoes the key).
    expect(screen.getByText('setNewFaucetId')).toBeInTheDocument();
    // placeholder = faucetId ?? '' → current id when known.
    expect(field()).toHaveAttribute('placeholder', '0xcurrentfaucet');
    // No success message and no error before any interaction.
    expect(screen.queryByText('faucetIdUpdated')).not.toBeInTheDocument();
    expect(screen.queryByTestId('error-faucetId')).not.toBeInTheDocument();
  });

  it('autofocuses the faucet-id input on mount (useLayoutEffect)', () => {
    render(<EditMidenFaucetId />);
    expect(field()).toHaveFocus();
  });

  it('falls back to an empty placeholder when the faucet id is not yet known', () => {
    mockUseMidenFaucetId.mockReturnValue(null);
    render(<EditMidenFaucetId />);
    expect(field()).toHaveAttribute('placeholder', '');
  });

  it('persists the entered faucet id and shows the success message', async () => {
    render(<EditMidenFaucetId />);
    prime('0xnewfaucet');

    fireEvent.submit(form());

    await waitFor(() => expect(screen.getByText('faucetIdUpdated')).toBeInTheDocument());
    expect(mockSetFaucetIdSetting).toHaveBeenCalledTimes(1);
    expect(mockSetFaucetIdSetting).toHaveBeenCalledWith('0xnewfaucet');
    // The success button reflects the settled (not-submitting) state.
    expect(screen.getByTestId('submit-btn')).toHaveAttribute('data-loading', 'false');
  });

  it('clears the success message and errors when the field changes again', async () => {
    render(<EditMidenFaucetId />);
    prime('0xnewfaucet');
    fireEvent.submit(form());
    await waitFor(() => expect(screen.getByText('faucetIdUpdated')).toBeInTheDocument());

    // Typing again hits the onChange `submitSuccess === true` branch → hides it.
    fireEvent.change(field(), { target: { value: '0xanotherfaucet' } });
    await waitFor(() => expect(screen.queryByText('faucetIdUpdated')).not.toBeInTheDocument());
  });

  it('surfaces the failure message and logs the error when persistence rejects', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('storage unavailable');
    mockSetFaucetIdSetting.mockRejectedValue(boom);

    render(<EditMidenFaucetId />);
    prime('0xnewfaucet');
    fireEvent.submit(form());

    // The catch block waits 300ms (human delay) before setting the error.
    await screen.findByTestId('error-faucetId', undefined, { timeout: 2000 });
    expect(screen.getByTestId('error-faucetId')).toHaveTextContent('storage unavailable');
    expect(screen.queryByText('faucetIdUpdated')).not.toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith(boom);
    // Refocus after the failed submit lands back on the faucet-id input.
    expect(field()).toHaveFocus();

    consoleSpy.mockRestore();
  });

  it('ignores a re-submit while a submit is still in flight (isSubmitting guard)', async () => {
    let resolveSet: () => void = () => {};
    mockSetFaucetIdSetting.mockImplementation(
      () =>
        new Promise<void>(res => {
          resolveSet = res;
        })
    );

    render(<EditMidenFaucetId />);
    prime('0xnewfaucet');

    await act(async () => {
      fireEvent.submit(form());
    });

    // First submit is pending → isSubmitting reflected on the button.
    await waitFor(() => expect(screen.getByTestId('submit-btn')).toHaveAttribute('data-loading', 'true'));

    // Re-submitting now runs onSubmit with isSubmitting === true → early return,
    // so setFaucetIdSetting is NOT called a second time.
    await act(async () => {
      fireEvent.submit(form());
    });
    expect(mockSetFaucetIdSetting).toHaveBeenCalledTimes(1);

    // Let the in-flight submit settle to avoid dangling act warnings.
    await act(async () => {
      resolveSet();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('submit-btn')).toHaveAttribute('data-loading', 'false'));
  });
});
