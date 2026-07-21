import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { withErrorHumanDelay } from 'lib/ui/humanDelay';

import AddContactModal from './AddContactModal';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert the rendered copy directly.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `ModalWithTitle` wraps `CustomModal` (react-modal portal + `useAppEnv`).
// None of that plumbing matters here — render the children only while `isOpen`
// so the closed (`address === null`) branch renders nothing, and surface
// `title` / `onRequestClose` so both are assertable / drivable.
jest.mock('app/templates/ModalWithTitle', () => ({
  __esModule: true,
  default: ({
    isOpen,
    title,
    onRequestClose,
    children
  }: {
    isOpen?: boolean;
    title?: React.ReactNode;
    onRequestClose?: () => void;
    children?: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        <span data-testid="modal-title">{title}</span>
        <button type="button" data-testid="modal-request-close" onClick={onRequestClose} />
        {children}
      </div>
    ) : null
}));

// `AnimalIdenticon` renders an svg identicon off the public key; a marker that
// echoes the forwarded `publicKey` is enough to assert the `address ?? ''`
// fallback without the identicon machinery.
jest.mock('app/atoms/AnimalIdenticon', () => ({
  __esModule: true,
  default: ({ publicKey }: { publicKey: string }) => <div data-testid="identicon" data-public-key={publicKey} />
}));

// `AddressShortView` pulls in `utils/string`; render the raw address so the
// forwarded value is directly assertable.
jest.mock('app/atoms/AddressShortView', () => ({
  __esModule: true,
  default: ({ address }: { address: string }) => <span data-testid="addr-short">{address}</span>
}));

// `FormField` pulls in analytics/tippy plumbing; a forwardRef <input> is enough
// for react-hook-form to register/watch the field and for us to type into it.
// It also surfaces `errorCaption` so the validation / submit-error branches are
// assertable.
jest.mock('app/atoms/FormField', () =>
  React.forwardRef(
    (
      {
        name,
        id,
        placeholder,
        maxLength,
        label,
        errorCaption,
        onChange,
        onBlur
      }: {
        name?: string;
        id?: string;
        placeholder?: string;
        maxLength?: number;
        label?: React.ReactNode;
        errorCaption?: React.ReactNode;
        onChange?: React.ChangeEventHandler<HTMLInputElement>;
        onBlur?: React.FocusEventHandler<HTMLInputElement>;
      },
      ref: React.Ref<HTMLInputElement>
    ) => (
      <span>
        <label htmlFor={id}>{label}</label>
        <input
          ref={ref}
          name={name}
          id={id}
          placeholder={placeholder}
          maxLength={maxLength}
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
// clicking it drives the form's onSubmit, and expose the `loading` flag.
jest.mock('app/atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: ({
    children,
    loading,
    type = 'submit'
  }: {
    children?: React.ReactNode;
    loading?: boolean;
    type?: 'submit' | 'button' | 'reset';
  }) => (
    <button type={type} data-loading={String(!!loading)} data-testid="submit-btn">
      {children}
    </button>
  )
}));

// `FormSecondaryButton` is the Cancel button (type="button"); surface its
// onClick so the cancel path is drivable.
jest.mock('app/atoms/FormSecondaryButton', () => ({
  __esModule: true,
  default: ({
    children,
    onClick,
    type = 'button'
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    type?: 'submit' | 'button' | 'reset';
  }) => (
    <button type={type} onClick={onClick} data-testid="cancel-btn">
      {children}
    </button>
  )
}));

// Collapse the 300ms human-delay so the submit-error branch resolves
// synchronously (default). Individual tests override the implementation.
jest.mock('lib/ui/humanDelay', () => ({
  withErrorHumanDelay: jest.fn(async (_err: unknown, cb: () => void | Promise<void>) => {
    await cb();
  })
}));

const mockWithErrorHumanDelay = withErrorHumanDelay as jest.Mock;

const ADDRESS = 'mtst1alice_qxyzABCD';

const onClose = jest.fn();

const getForm = (container: HTMLElement) => container.querySelector('form') as HTMLFormElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockWithErrorHumanDelay.mockImplementation(async (_err: unknown, cb: () => void | Promise<void>) => {
    await cb();
  });
});

describe('AddContactModal', () => {
  it('renders nothing when address is null (modal closed)', () => {
    render(<AddContactModal address={null} onClose={onClose} />);

    // `isOpen={Boolean(address)}` is false → the mocked modal renders null, so
    // no title, no form, no buttons are present.
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('submit-btn')).not.toBeInTheDocument();
  });

  it('opens the modal and wires the address into the identicon and short-view', () => {
    render(<AddContactModal address={ADDRESS} onClose={onClose} />);

    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(screen.getByTestId('modal-title')).toHaveTextContent('addNewContact');

    // `publicKey={address ?? ''}` and `<AddressShortView address={address ?? ''} />`
    // both receive the real address on the truthy side of the `??`.
    expect(screen.getByTestId('identicon')).toHaveAttribute('data-public-key', ADDRESS);
    expect(screen.getByTestId('addr-short')).toHaveTextContent(ADDRESS);

    // Static copy + the name field render (t echoes the key).
    expect(screen.getByPlaceholderText('newContactPlaceholder')).toBeInTheDocument();
    expect(screen.getByText('cancel')).toBeInTheDocument();
    expect(screen.getByText('addContact')).toBeInTheDocument();

    // No error initially → `errorCaption={errors.name?.message}` is undefined.
    expect(screen.queryByTestId('error-name')).not.toBeInTheDocument();
    // Not submitting → `loading={isSubmitting}` is false.
    expect(screen.getByTestId('submit-btn')).toHaveAttribute('data-loading', 'false');
  });

  it('closes the modal when the Cancel button is clicked', () => {
    render(<AddContactModal address={ADDRESS} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the modal via the modal request-close (onRequestClose)', () => {
    render(<AddContactModal address={ADDRESS} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('modal-request-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears errors, resets the form and closes on a valid submit', async () => {
    const { container } = render(<AddContactModal address={ADDRESS} onClose={onClose} />);

    const input = screen.getByTestId('field-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Alice' } });

    fireEvent.submit(getForm(container));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // Happy path never enters the catch block.
    expect(mockWithErrorHumanDelay).not.toHaveBeenCalled();
    // resetForm() clears the field back to its (empty) default.
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('surfaces the required-validation error and does not close when the name is empty', async () => {
    const { container } = render(<AddContactModal address={ADDRESS} onClose={onClose} />);

    // Submit with an empty name so react-hook-form's `required` rule populates
    // `errors.name`, exercising the truthy side of `errorCaption`.
    fireEvent.submit(getForm(container));

    await waitFor(() => expect(screen.getByTestId('error-name')).toHaveTextContent('required'));
    // Validation failed → the submit handler never ran.
    expect(onClose).not.toHaveBeenCalled();
    expect(mockWithErrorHumanDelay).not.toHaveBeenCalled();
  });

  it('routes a thrown onClose through withErrorHumanDelay and sets a submit error', async () => {
    onClose.mockImplementation(() => {
      throw new Error('close failed');
    });

    const { container } = render(<AddContactModal address={ADDRESS} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Alice' } });

    fireEvent.submit(getForm(container));

    // The catch block delegates to withErrorHumanDelay, whose (mocked) callback
    // calls setError('name', ...) with the thrown error's message.
    await waitFor(() => expect(mockWithErrorHumanDelay).toHaveBeenCalledTimes(1));
    expect(mockWithErrorHumanDelay.mock.calls[0][0]).toBeInstanceOf(Error);
    await waitFor(() => expect(screen.getByTestId('error-name')).toHaveTextContent('close failed'));
  });

  // NOTE ON THE `if (isSubmitting) return;` GUARD (line 33)
  // ----------------------------------------------------------------------------
  // Its true-branch is unreachable dead code in this component. `onAddContactSubmit`
  // reads `isSubmitting` from its render closure, and react-hook-form only exposes
  // `isSubmitting === true` to a *committed* render. But the handler calls
  // `resetForm()` synchronously — before its only `await` — and react-hook-form's
  // `reset()` restores `isSubmitting` to `false`. So no committed render ever hands
  // the closure a `true` value, and a re-entrant submit (verified below) is stopped
  // by required-validation on the just-reset field rather than by this guard.
  it('a re-entrant submit is blocked by the reset form, never double-closing', async () => {
    // Hold the first submit in-flight by making onClose throw into a pending delay.
    let releaseDelay: () => void = () => {};
    mockWithErrorHumanDelay.mockReturnValue(
      new Promise<void>(resolve => {
        releaseDelay = resolve;
      })
    );
    onClose.mockImplementation(() => {
      throw new Error('boom');
    });

    const { container } = render(<AddContactModal address={ADDRESS} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Alice' } });
    const form = getForm(container);

    await act(async () => {
      fireEvent.submit(form);
    });
    // First submit reset the field to empty and entered the (still-pending) catch.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('field-name') as HTMLInputElement).value).toBe('');

    // Second submit: the required rule fails on the now-empty field, so the handler
    // never runs and onClose is not invoked again.
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseDelay();
    });
  });
});
