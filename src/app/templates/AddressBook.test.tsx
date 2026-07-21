import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useContacts, isAddressValid } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import { useConfirm } from 'lib/ui/dialog';
import { withErrorHumanDelay } from 'lib/ui/humanDelay';

import AddressBook from './AddressBook';

// `i18next`'s `t` is imported directly by the component. It's never `init()`-ed
// in the unit env, so echo the key back (interpolation args are ignored).
jest.mock('i18next', () => ({ t: (key: string) => key }));

// `FormField` pulls in analytics/tippy plumbing; a forwardRef <input> is enough
// for react-hook-form to register/watch the field and for us to type into it.
// It also surfaces `errorCaption` so the invalid-address branch is assertable.
jest.mock('app/atoms/FormField', () =>
  React.forwardRef(
    (
      {
        name,
        id,
        placeholder,
        maxLength,
        errorCaption,
        onChange,
        onBlur
      }: {
        name?: string;
        id?: string;
        placeholder?: string;
        maxLength?: number;
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
// clicking it drives the form's onSubmit, and expose loading/disabled/testID.
jest.mock('app/atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: ({
    children,
    disabled,
    loading,
    testID,
    type = 'submit'
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
    type?: 'submit' | 'button' | 'reset';
  }) => (
    <button type={type} disabled={disabled} data-loading={String(!!loading)} data-testid={testID ?? 'submit-btn'}>
      {children}
    </button>
  )
}));

// `Avatar` reaches into react-i18next + Identicon; it carries no logic the
// component under test cares about, so stub it to a marker node.
jest.mock('components/Avatar', () => ({
  Avatar: (props: { image?: string; size?: string }) => <div data-testid="avatar" data-image={props.image} />
}));

// `CardItem` renders the contact row. Expose title/subtitle plus whether an
// onClick / hoverable was wired so we can assert the accountInWallet branches
// and drive the remove flow by clicking the row.
jest.mock('components/CardItem', () => ({
  CardItem: ({
    title,
    subtitle,
    onClick,
    hoverable
  }: {
    title?: string;
    subtitle?: string;
    onClick?: () => void;
    hoverable?: boolean;
  }) => (
    <div
      data-testid={`card-${title}`}
      data-hoverable={String(!!hoverable)}
      data-has-onclick={String(Boolean(onClick))}
      onClick={onClick}
    >
      <span>{title}</span>
      <span data-testid={`subtitle-${title}`}>{subtitle}</span>
    </div>
  )
}));

// `lib/miden/front` is a barrel over the SDK; mock only the two members the
// component imports.
jest.mock('lib/miden/front', () => ({
  useContacts: jest.fn(),
  isAddressValid: jest.fn()
}));

jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: jest.fn()
}));

jest.mock('lib/ui/dialog', () => ({
  useConfirm: jest.fn()
}));

// Collapse the 300ms human-delay so the error branch resolves synchronously.
jest.mock('lib/ui/humanDelay', () => ({
  withErrorHumanDelay: jest.fn(async (_err: unknown, cb: () => void | Promise<void>) => {
    await cb();
  })
}));

const mockUseContacts = useContacts as jest.Mock;
const mockIsAddressValid = isAddressValid as jest.Mock;
const mockUseFilteredContacts = useFilteredContacts as jest.Mock;
const mockUseConfirm = useConfirm as jest.Mock;
const mockWithErrorHumanDelay = withErrorHumanDelay as jest.Mock;

const addContact = jest.fn();
const removeContact = jest.fn();
const confirm = jest.fn();

type Contact = {
  name: string;
  address: string;
  accountInWallet: boolean;
  isPublic: boolean;
};

// Alice → in-wallet + public, Bob → in-wallet + private, Carol → external.
const CONTACTS: Contact[] = [
  { name: 'Alice', address: 'mtst1alice_qxyzABCD', accountInWallet: true, isPublic: true },
  { name: 'Bob', address: 'mtst1bob_qwstUVWX', accountInWallet: true, isPublic: false },
  { name: 'Carol', address: 'mtst1carol_qrstEFGH', accountInWallet: false, isPublic: false }
];

const setContacts = (allContacts: Contact[]) => {
  mockUseFilteredContacts.mockReturnValue({ allContacts });
};

const fillForm = (name: string, address: string) => {
  fireEvent.change(screen.getByTestId('field-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('field-address'), { target: { value: address } });
};

beforeEach(() => {
  jest.clearAllMocks();
  addContact.mockResolvedValue(undefined);
  removeContact.mockResolvedValue(undefined);
  confirm.mockResolvedValue(true);
  mockUseContacts.mockReturnValue({ addContact, removeContact });
  mockUseConfirm.mockReturnValue(confirm);
  mockIsAddressValid.mockReturnValue(true);
  setContacts(CONTACTS);
});

describe('AddressBook', () => {
  it('renders the form headings and every contact with its per-type subtitle', () => {
    render(<AddressBook />);

    // Static copy (t echoes the key).
    expect(screen.getByText('addContact', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('currentContacts')).toBeInTheDocument();

    // accountInWallet + isPublic → "public"; accountInWallet + !isPublic → "private";
    // !accountInWallet → "external".
    expect(screen.getByTestId('subtitle-Alice').textContent).toContain('public');
    expect(screen.getByTestId('subtitle-Bob').textContent).toContain('private');
    expect(screen.getByTestId('subtitle-Carol').textContent).toContain('external');

    // hoverable = !accountInWallet, and only external contacts get an onClick.
    expect(screen.getByTestId('card-Alice')).toHaveAttribute('data-hoverable', 'false');
    expect(screen.getByTestId('card-Alice')).toHaveAttribute('data-has-onclick', 'false');
    expect(screen.getByTestId('card-Carol')).toHaveAttribute('data-hoverable', 'true');
    expect(screen.getByTestId('card-Carol')).toHaveAttribute('data-has-onclick', 'true');
  });

  it('shows the empty-state copy when there are no contacts', () => {
    setContacts([]);
    render(<AddressBook />);
    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
  });

  it('treats a whitespace-only query as empty and lists all contacts', () => {
    render(<AddressBook />);
    fireEvent.change(screen.getByPlaceholderText('searchContacts'), { target: { value: '   ' } });

    expect(screen.getByTestId('card-Alice')).toBeInTheDocument();
    expect(screen.getByTestId('card-Bob')).toBeInTheDocument();
    expect(screen.getByTestId('card-Carol')).toBeInTheDocument();
  });

  it('filters contacts by name (case-insensitive)', () => {
    render(<AddressBook />);
    fireEvent.change(screen.getByPlaceholderText('searchContacts'), { target: { value: 'ALI' } });

    expect(screen.getByTestId('card-Alice')).toBeInTheDocument();
    expect(screen.queryByTestId('card-Bob')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-Carol')).not.toBeInTheDocument();
  });

  it('filters contacts by address when the name does not match', () => {
    render(<AddressBook />);
    // "uvwx" only appears in Bob's address, not in any name.
    fireEvent.change(screen.getByPlaceholderText('searchContacts'), { target: { value: 'uvwx' } });

    expect(screen.getByTestId('card-Bob')).toBeInTheDocument();
    expect(screen.queryByTestId('card-Alice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-Carol')).not.toBeInTheDocument();
  });

  it('renders the empty-state when a query matches nothing', () => {
    render(<AddressBook />);
    fireEvent.change(screen.getByPlaceholderText('searchContacts'), { target: { value: 'zzz-no-match' } });

    expect(screen.getByText('noContactsFound')).toBeInTheDocument();
    expect(screen.queryByTestId('card-Alice')).not.toBeInTheDocument();
  });

  it('removes an external contact after the confirm dialog is accepted', async () => {
    render(<AddressBook />);
    fireEvent.click(screen.getByTestId('card-Carol'));

    await waitFor(() => expect(removeContact).toHaveBeenCalledWith('mtst1carol_qrstEFGH'));
    expect(confirm).toHaveBeenCalledWith({
      title: 'actionConfirmation',
      children: 'deleteContactConfirm'
    });
  });

  it('does not remove the contact when the confirm dialog is dismissed', async () => {
    confirm.mockResolvedValue(false);
    render(<AddressBook />);
    fireEvent.click(screen.getByTestId('card-Carol'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(removeContact).not.toHaveBeenCalled();
  });

  it('does not wire a click handler on in-wallet contacts', async () => {
    render(<AddressBook />);
    // Alice's onClick is undefined; clicking is a no-op (no confirm / remove).
    fireEvent.click(screen.getByTestId('card-Alice'));

    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();
    expect(removeContact).not.toHaveBeenCalled();
  });
});

describe('AddNewContactForm', () => {
  const submitButton = () => screen.getByTestId('AddressBook/AddNewContact');

  it('disables the submit button until both fields are filled', () => {
    render(<AddressBook />);
    expect(submitButton()).toBeDisabled();

    fireEvent.change(screen.getByTestId('field-name'), { target: { value: 'Dave' } });
    expect(submitButton()).toBeDisabled(); // address still empty

    fireEvent.change(screen.getByTestId('field-address'), { target: { value: 'mtst1dave_addr' } });
    expect(submitButton()).toBeEnabled();
  });

  it('adds a valid contact and resets the form', async () => {
    render(<AddressBook />);
    fillForm('Dave', 'mtst1dave_addr');

    fireEvent.click(submitButton());

    await waitFor(() => expect(addContact).toHaveBeenCalledTimes(1));
    expect(mockIsAddressValid).toHaveBeenCalledWith('mtst1dave_addr');
    expect(addContact).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'mtst1dave_addr', name: 'Dave', addedAt: expect.any(Number) })
    );

    // resetForm() clears the fields → button falls back to disabled.
    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(mockWithErrorHumanDelay).not.toHaveBeenCalled();
  });

  it('renders the name field validation error (required) on an empty submit', async () => {
    const { container } = render(<AddressBook />);
    // Submit directly (bypassing the disabled button) with an empty name so
    // react-hook-form's `required` rule populates `errors.name`, exercising the
    // `errorCaption={errors.name?.message}` branch.
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(screen.getByTestId('error-name')).toHaveTextContent('required'));
    expect(addContact).not.toHaveBeenCalled();
  });

  it('surfaces an invalid-address error and does not add the contact', async () => {
    mockIsAddressValid.mockReturnValue(false);
    render(<AddressBook />);
    fillForm('Dave', 'not-an-address');

    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByTestId('error-address')).toHaveTextContent('invalidAddress'));
    expect(addContact).not.toHaveBeenCalled();
    expect(mockWithErrorHumanDelay).toHaveBeenCalledTimes(1);
  });
});
