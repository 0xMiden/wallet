import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { clearClipboard } from 'lib/ui/util';
import { navigate } from 'lib/woozie';

import ImportAccount from './ImportAccount';

const mockImportAccount = jest.fn();
const mockUpdateCurrentAccount = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    importAccount: mockImportAccount,
    updateCurrentAccount: mockUpdateCurrentAccount
  })
}));

jest.mock('lib/ui/util', () => ({
  ...jest.requireActual('lib/ui/util'),
  clearClipboard: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  HistoryAction: { Replace: 'replace' },
  // useBackWithFallback reads live history at call time.
  createLocationState: () => ({ historyPosition: 0, href: 'http://localhost/#/import-account' }),
  listen: () => () => undefined
}));

jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <header>
      <h1>{title}</h1>
      <button type="button" onClick={onBack}>
        back
      </button>
    </header>
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockImportAccount.mockResolvedValue('mtst1imported');
  mockUpdateCurrentAccount.mockResolvedValue(undefined);
  (clearClipboard as jest.Mock).mockResolvedValue(true);
});

it('renders an accessible private-key import form', () => {
  render(<ImportAccount />);

  expect(screen.getByRole('heading', { name: 'importAccount' })).toBeInTheDocument();
  expect(screen.getByLabelText('privateKey')).toHaveAttribute('id', 'importacc-privatekey');
  expect(screen.getByLabelText('accountName')).toHaveAttribute('id', 'importacc-name');
  expect(screen.getByRole('button', { name: 'importAccount' })).toBeEnabled();
  // FormSubmitButton defaulted to type="submit"; the canonical Button defaults to
  // type="button", so the caller has to pin it explicitly or a real click (not just
  // this suite's `fireEvent.submit` on the form) would stop submitting.
  expect(screen.getByRole('button', { name: 'importAccount' })).toHaveAttribute('type', 'submit');
});

it('draws the page through the shared frame: fields, hints and a CTA pinned outside the form', () => {
  const { container } = render(<ImportAccount />);

  // The shared text field, not a hand-rolled well: label, hint and field are one component.
  const secretField = screen.getByLabelText('privateKey');
  expect(secretField.tagName).toBe('TEXTAREA');
  expect(secretField.parentElement).toHaveClass('bg-fill');
  expect(screen.getByText('privateKeyInputDescription')).toHaveClass('text-caption', 'text-muted');
  expect(container.querySelector('label[for="importacc-privatekey"]')).toHaveClass('text-label', 'text-muted');

  // The CTA is in the layout's pinned footer, and submits the form by name from there.
  const cta = screen.getByRole('button', { name: 'importAccount' });
  const pinned = container.querySelector('[data-slot="footer"]')!;
  expect(pinned).toContainElement(cta);
  expect(pinned).not.toContainElement(screen.getByTestId('import-account-form'));
  expect(cta).toHaveAttribute('form', 'import-account-form');
});

it('covers a pasted private key once the field is left', () => {
  render(<ImportAccount />);
  const field = screen.getByLabelText('privateKey');

  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'aabbcc' } });
  expect(document.querySelector('[data-slot="secret-cover"]')).toBeNull();
  fireEvent.blur(field);
  expect(document.querySelector('[data-slot="secret-cover"]')).toBeInTheDocument();
});

it('normalizes the secret and name, selects the imported account, and returns home', async () => {
  render(<ImportAccount />);

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: ' aa bb\ncc ' } });
  fireEvent.change(screen.getByLabelText('accountName'), { target: { value: ' Imported ' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));

  await waitFor(() => expect(mockImportAccount).toHaveBeenCalledWith('aabbcc', 'Imported'));
  expect(mockUpdateCurrentAccount).toHaveBeenCalledWith('mtst1imported');
  expect(navigate).toHaveBeenCalledWith('/');
});

it('imports without an optional account name', async () => {
  render(<ImportAccount />);

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: 'aabbcc' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));

  await waitFor(() => expect(mockImportAccount).toHaveBeenCalledWith('aabbcc', undefined));
});

it('rejects an empty secret and an invalid account name before import', async () => {
  render(<ImportAccount />);

  fireEvent.submit(screen.getByTestId('import-account-form'));
  expect(await screen.findByText('required')).toBeInTheDocument();
  expect(mockImportAccount).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: 'aabbcc' } });
  fireEvent.change(screen.getByLabelText('accountName'), { target: { value: '-invalid' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));
  expect(await screen.findByText('accountNameInputInvalid')).toBeInTheDocument();
  expect(mockImportAccount).not.toHaveBeenCalled();
});

it('ignores a second submission while the first import is pending', async () => {
  let resolveImport!: (accountPublicKey: string) => void;
  mockImportAccount.mockReturnValue(
    new Promise<string>(resolve => {
      resolveImport = resolve;
    })
  );
  render(<ImportAccount />);

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: 'aabbcc' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));
  fireEvent.submit(screen.getByTestId('import-account-form'));

  await waitFor(() => expect(mockImportAccount).toHaveBeenCalledTimes(1));
  resolveImport('mtst1imported');
  await waitFor(() => expect(mockUpdateCurrentAccount).toHaveBeenCalledWith('mtst1imported'));
});

it('clears the clipboard when a secret is pasted', async () => {
  render(<ImportAccount />);

  // The resolved mock drives a state update after the paste; act() flushes it so the update
  // is not left dangling past the test's end (a warning today, real cross-test pollution once
  // another test's render is on screen when it lands).
  await act(async () => {
    fireEvent.paste(screen.getByLabelText('privateKey'));
  });

  expect(clearClipboard).toHaveBeenCalledTimes(1);
});

it('shows a warning notice when a pasted key could not be removed from the clipboard', async () => {
  (clearClipboard as jest.Mock).mockResolvedValue(false);
  render(<ImportAccount />);

  fireEvent.paste(screen.getByLabelText('privateKey'));

  const warning = await screen.findByTestId('import-account-clipboard-warning');
  expect(warning).toHaveTextContent('privateKeyClipboardNotCleared');
});

it('shows no warning when the pasted key is removed from the clipboard', async () => {
  (clearClipboard as jest.Mock).mockResolvedValue(true);
  render(<ImportAccount />);

  // `act` flushes the resolved promise's `.then` before this asserts, so a false positive
  // (the warning was never rendered because nothing waited for the microtask) is ruled out.
  await act(async () => {
    fireEvent.paste(screen.getByLabelText('privateKey'));
  });

  expect(screen.queryByTestId('import-account-clipboard-warning')).not.toBeInTheDocument();
});

it('hides an earlier warning once a later paste clears the clipboard', async () => {
  (clearClipboard as jest.Mock).mockResolvedValue(false);
  render(<ImportAccount />);
  const field = screen.getByLabelText('privateKey');

  fireEvent.paste(field);
  await screen.findByTestId('import-account-clipboard-warning');

  (clearClipboard as jest.Mock).mockResolvedValue(true);
  fireEvent.paste(field);

  await waitFor(() => expect(screen.queryByTestId('import-account-clipboard-warning')).not.toBeInTheDocument());
});

it('shows an import failure without navigating or logging the secret', async () => {
  mockImportAccount.mockRejectedValue(new Error('Invalid private key'));
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<ImportAccount />);

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: 'secret-value' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));

  // The backend sentence is untranslated, so the screen shows its own copy and
  // keeps the cause in the log.
  // The shared negative Notice, not the atom's red block.
  const alert = await screen.findByTestId('import-account-error');
  expect(alert).toHaveAttribute('role', 'alert');
  expect(alert).toHaveAttribute('data-tone', 'negative');
  expect(alert).toHaveTextContent('smthWentWrong');
  expect(consoleErrorSpy).toHaveBeenCalled();
  expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('secret-value');
  consoleErrorSpy.mockRestore();
  expect(mockUpdateCurrentAccount).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.queryByText('secret-value')).not.toBeInTheDocument();
});

it('uses the safe fallback for non-Error failures', async () => {
  mockImportAccount.mockRejectedValue({ code: 'failure' });
  render(<ImportAccount />);

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: 'secret-value' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));

  expect(await screen.findByTestId('import-account-error')).toHaveTextContent('smthWentWrong');
});

it('returns home from the back button', () => {
  render(<ImportAccount />);

  fireEvent.click(screen.getByRole('button', { name: 'back' }));

  expect(navigate).toHaveBeenCalledWith('/', 'replace');
});
