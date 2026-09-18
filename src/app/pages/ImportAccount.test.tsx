import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  useLocation: () => ({ historyPosition: 0 })
}));

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <header>
      <h1>{title}</h1>
      <button type="button" onClick={onBack}>
        back
      </button>
    </header>
  )
}));

jest.mock('app/atoms/Alert', () => ({
  __esModule: true,
  default: ({ title, description }: { title: string; description: React.ReactNode }) => (
    <div role="alert">
      {title}: {description}
    </div>
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockImportAccount.mockResolvedValue('mtst1imported');
  mockUpdateCurrentAccount.mockResolvedValue(undefined);
});

it('renders an accessible private-key import form', () => {
  render(<ImportAccount />);

  expect(screen.getByRole('heading', { name: 'importAccount' })).toBeInTheDocument();
  expect(screen.getByLabelText('privateKey')).toHaveAttribute('id', 'importacc-privatekey');
  expect(screen.getByLabelText('accountName')).toHaveAttribute('id', 'importacc-name');
  expect(screen.getByRole('button', { name: 'importAccount' })).toBeEnabled();
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

it('clears the clipboard when a secret is pasted', () => {
  render(<ImportAccount />);

  fireEvent.paste(screen.getByLabelText('privateKey'));

  expect(clearClipboard).toHaveBeenCalledTimes(1);
});

it('shows an import failure without navigating or logging the secret', async () => {
  mockImportAccount.mockRejectedValue(new Error('Invalid private key'));
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<ImportAccount />);

  fireEvent.change(screen.getByLabelText('privateKey'), { target: { value: 'secret-value' } });
  fireEvent.submit(screen.getByTestId('import-account-form'));

  // The backend sentence is untranslated, so the screen shows its own copy and
  // keeps the cause in the log.
  expect(await screen.findByRole('alert')).toHaveTextContent('error: smthWentWrong');
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

  expect(await screen.findByRole('alert')).toHaveTextContent('error: smthWentWrong');
});

it('returns home from the back button', () => {
  render(<ImportAccount />);

  fireEvent.click(screen.getByRole('button', { name: 'back' }));

  expect(navigate).toHaveBeenCalledWith('/', 'replace');
});
