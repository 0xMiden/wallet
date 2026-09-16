import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { useMidenContext, useAccount } from 'lib/miden/front';
import { useRetryableSWR } from 'lib/swr';
import { useConfirm } from 'lib/ui/dialog';

import DAppSettings from './DAppSettings';

// The wallet-adapter package ships as ESM and is not transformed by jest, so we
// provide just the `PrivateDataPermission` enum the component reads. Values
// mirror the real enum (`UPON_REQUEST` / `AUTO`) so the equality check behaves
// identically to production.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' }
}));

// `t` is never `init()`-ed in the unit env; echo the key back (interpolation
// args are ignored) so rendered copy is assertable by key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `AddressShortView` pulls in `utils/string`; render the raw address so the
// account value is directly assertable.
jest.mock('app/atoms/AddressShortView', () => ({
  __esModule: true,
  default: ({ address }: { address: string }) => <span data-testid="addr-short">{address}</span>
}));

// `CopyButton` reaches into analytics / tippy / haptics; stub it to a marker
// that surfaces the `text` it would copy plus its children.
jest.mock('app/atoms/CopyButton', () => ({
  __esModule: true,
  default: ({ text, children }: { text: string; children?: React.ReactNode }) => (
    <button data-testid="copy-btn" data-copy-text={text}>
      {children}
    </button>
  )
}));

// `lib/miden/front` is a barrel over the SDK; mock only the two members used.
jest.mock('lib/miden/front', () => ({
  useMidenContext: jest.fn(),
  useAccount: jest.fn()
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn()
}));

jest.mock('lib/ui/dialog', () => ({
  useConfirm: jest.fn()
}));

const UPON_REQUEST = 'UPON_REQUEST';
const AUTO = 'AUTO';

const mockUseMidenContext = useMidenContext as jest.Mock;
const mockUseAccount = useAccount as jest.Mock;
const mockUseRetryableSWR = useRetryableSWR as jest.Mock;
const mockUseConfirm = useConfirm as jest.Mock;

const getAllDAppSessions = jest.fn();
const removeDAppSession = jest.fn();
const mutate = jest.fn();
const confirm = jest.fn();

type Session = {
  network: string;
  accountId: string;
  privateDataPermission: string;
};

const ACCOUNT_ID = 'mtst1account_ABCD';

// Two rendered cards (matching accountId) plus one skipped origin (no session
// whose accountId matches the active account).
const DATA: Record<string, Session[]> = {
  'https://app.example.com': [
    { network: 'testnet', accountId: ACCOUNT_ID, privateDataPermission: UPON_REQUEST },
    // A second, non-matching session in the same origin proves `find` selects
    // the account-matching one rather than the first.
    { network: 'localnet', accountId: 'someone_else_QQQ', privateDataPermission: AUTO }
  ],
  // Not a valid URL → the `new URL(...)` ctor throws → hostname falls back to
  // the raw origin. Uses the `Auto` permission branch.
  'invalid url string': [{ network: 'localnet', accountId: ACCOUNT_ID, privateDataPermission: AUTO }],
  // No session matches the active account → this origin is skipped entirely.
  'https://skipme.io': [{ network: 'testnet', accountId: 'nobody_ZZZ', privateDataPermission: AUTO }]
};

const setData = (data: Record<string, Session[]>) => {
  mockUseRetryableSWR.mockReturnValue({ data, mutate });
};

beforeEach(() => {
  jest.clearAllMocks();
  removeDAppSession.mockResolvedValue(undefined);
  confirm.mockResolvedValue(true);
  getAllDAppSessions.mockResolvedValue(DATA);
  mockUseMidenContext.mockReturnValue({ getAllDAppSessions, removeDAppSession });
  mockUseAccount.mockReturnValue({ publicKey: ACCOUNT_ID });
  mockUseConfirm.mockReturnValue(confirm);
  setData(DATA);
});

describe('DAppSettings', () => {
  it('renders a card only for origins with a session matching the active account', () => {
    render(<DAppSettings />);

    // Matching origins render (valid + invalid-URL); non-matching is skipped.
    expect(screen.getByText('app.example.com')).toBeInTheDocument();
    expect(screen.getAllByText('invalid url string').length).toBeGreaterThan(0);
    expect(screen.queryByText('skipme.io')).not.toBeInTheDocument();

    // One card per matching origin.
    expect(screen.getAllByText('originLabel')).toHaveLength(2);
  });

  it('derives the header hostname from a valid URL and falls back to the raw origin otherwise', () => {
    render(<DAppSettings />);

    // Valid URL → hostname; the full origin still appears as the Origin value.
    expect(screen.getByText('app.example.com')).toBeInTheDocument();
    expect(screen.getByText('https://app.example.com')).toBeInTheDocument();

    // Invalid URL → catch branch → hostname === origin. The raw string appears
    // twice (header hostname + Origin value row).
    expect(screen.getAllByText('invalid url string')).toHaveLength(2);
  });

  it('renders network, account and both permission labels', () => {
    render(<DAppSettings />);

    // Networks (capitalized via CSS, text unchanged).
    expect(screen.getByText('testnet')).toBeInTheDocument();
    expect(screen.getByText('localnet')).toBeInTheDocument();

    // AddressShortView receives the matched accountId for every card.
    expect(screen.getAllByTestId('addr-short')).toHaveLength(2);
    expect(screen.getAllByTestId('addr-short')[0]).toHaveTextContent(ACCOUNT_ID);

    // CopyButton is wired with the accountId as its copy text.
    expect(screen.getAllByTestId('copy-btn')[0]).toHaveAttribute('data-copy-text', ACCOUNT_ID);

    // UponRequest → permissionUponRequest; Auto → permissionAutomatic.
    expect(screen.getByText('permissionUponRequest')).toBeInTheDocument();
    expect(screen.getByText('permissionAutomatic')).toBeInTheDocument();
    // The static permission chip renders once per card.
    expect(screen.getAllByText('permissionLabel')).toHaveLength(2);
  });

  it('builds the explorer link from the accountId prefix before the underscore', () => {
    render(<DAppSettings />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    // `mtst1account_ABCD`.split('_')[0] === 'mtst1account' (truthy branch).
    links.forEach(link => expect(link).toHaveAttribute('href', 'https://testnet.midenscan.com/account/mtst1account'));
  });

  it('removes the session and revalidates when the confirm dialog is accepted', async () => {
    render(<DAppSettings />);

    const header = screen.getByText('app.example.com').parentElement as HTMLElement;
    fireEvent.click(within(header).getByRole('button'));

    await waitFor(() => expect(removeDAppSession).toHaveBeenCalledWith('https://app.example.com'));
    expect(confirm).toHaveBeenCalledWith({
      title: 'actionConfirmation',
      children: 'resetPermissionsConfirmation'
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not remove the session when the confirm dialog is dismissed', async () => {
    confirm.mockResolvedValue(false);
    render(<DAppSettings />);

    const header = screen.getByText('app.example.com').parentElement as HTMLElement;
    fireEvent.click(within(header).getByRole('button'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(removeDAppSession).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('renders nothing when there are no matching sessions', () => {
    setData({});
    const { container } = render(<DAppSettings />);

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.queryByText('originLabel')).not.toBeInTheDocument();
  });

  it('falls back to the full accountId for the explorer link when the prefix is empty', () => {
    // publicKey starts with `_` → split('_')[0] === '' (falsy) → `|| accountId`.
    const leadingUnderscoreId = '_leading';
    mockUseAccount.mockReturnValue({ publicKey: leadingUnderscoreId });
    setData({
      'https://x.io': [{ network: 'testnet', accountId: leadingUnderscoreId, privateDataPermission: AUTO }]
    });

    render(<DAppSettings />);

    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `https://testnet.midenscan.com/account/${leadingUnderscoreId}`
    );
  });
});
