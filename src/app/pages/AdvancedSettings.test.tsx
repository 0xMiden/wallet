import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import AdvancedSettings from './AdvancedSettings';

// `t` is never `init()`-ed in the unit env; echo the key back so rendered copy
// (labels rendered via `t(...)`) is assertable by key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `lib/miden/front` is a barrel over the SDK; mock only `useAccount`, the sole
// member this page imports, so we can steer `walletAccount.publicKey`.
jest.mock('lib/miden/front', () => ({
  useAccount: jest.fn()
}));

// `mock`-prefixed so jest's hoisted mock factories may reference them.
const mockGetAccount = jest.fn();
const mockResolveCommitments = jest.fn();

// The WASM client + lock are native/async plumbing. `withWasmClientLock` simply
// runs the callback (no real lock in the unit env), and `getMidenClient`
// resolves to a stub exposing `getAccount`.
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => Promise.resolve({ getAccount: mockGetAccount }),
  withWasmClientLock: (cb: () => unknown) => cb()
}));

jest.mock('lib/miden/sdk/resolve-public-key-commitments', () => ({
  resolvePublicKeyCommitments: (account: unknown) => mockResolveCommitments(account)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  Link: () => null
}));

// The copy action is the shared CopyButton, rendered for real; only the clipboard is stubbed.
const mockCopy = jest.fn();
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: (...args: unknown[]) => mockCopy(...args) } }));

const mockUseAccount = useAccount as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;
const mockNavigate = navigate as jest.Mock;

// A 16-char (post-`0x`) key resolves to a stable truncation:
// `0x` + first 6 (`abcdef`) + `...` + last 4 (`7890`).
const RESOLVED_KEY = 'abcdef1234567890';
const commitment = { toHex: () => `0x${RESOLVED_KEY}` };

// The copy action is DetailRow's orange text action, labelled by state.
const queryCopyAction = () => screen.queryByRole('button', { name: /^(copy|copied)$/ });

const renderWithResolvedKey = async () => {
  mockGetAccount.mockResolvedValue({});
  mockResolveCommitments.mockReturnValue([commitment]);
  const view = render(<AdvancedSettings />);
  // Wait for the async effect to resolve and paint the truncated key.
  await screen.findByText('0xabcdef...7890');
  return view;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAccount.mockReturnValue({ publicKey: 'account-id-1', type: 'on-chain' });
});

describe('AdvancedSettings (page)', () => {
  it('renders all section labels', async () => {
    await renderWithResolvedKey();

    expect(screen.getByText('accountPublicKey')).toBeInTheDocument();
    expect(screen.getByText('editMidenFaucetId')).toBeInTheDocument();
    expect(screen.getByText('exportAccountFile')).toBeInTheDocument();
  });

  it('resolves the account public key and displays the truncated chip', async () => {
    await renderWithResolvedKey();

    // Client was queried with the wallet account's public key.
    expect(mockGetAccount).toHaveBeenCalledWith('account-id-1');
    // Commitment resolver received the fetched account.
    expect(mockResolveCommitments).toHaveBeenCalledWith({});

    // Truncated chip: 0x + first 6 + ... + last 4.
    expect(screen.getByText('0xabcdef...7890')).toBeInTheDocument();

    // The copy action is offered, labelled for the not-yet-copied state.
    expect(queryCopyAction()).toHaveTextContent('copy');
  });

  it('renders through SubPageLayout: the key in a DetailCard, the faucet editor as a ListRow', async () => {
    await renderWithResolvedKey();

    const page = screen.getByTestId('advanced-settings');
    expect(page.querySelector('[data-slot="body"]')).toHaveClass('px-4', 'gap-5');
    const keyRow = screen.getByTestId('advanced-public-key');
    expect(keyRow.parentElement).toHaveClass('bg-fill', 'rounded-2xl', 'divide-y');
    expect(keyRow).toContainElement(queryCopyAction());
    const faucetRow = screen.getByTestId('advanced-edit-faucet-id');
    expect(faucetRow.querySelector('[data-slot="chevron"]')).not.toBeNull();
    expect(faucetRow.parentElement).toHaveClass('bg-fill', 'rounded-2xl');
  });

  it('triggers haptics and copies when the copy action is pressed', async () => {
    await renderWithResolvedKey();

    fireEvent.click(queryCopyAction()!);

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    // The full, untruncated key, not the chip's short form.
    expect(mockCopy).toHaveBeenCalledWith({ string: RESOLVED_KEY });
  });

  it('rolls the action to Copied after a copy', async () => {
    mockCopy.mockResolvedValue(undefined);
    await renderWithResolvedKey();

    await act(async () => {
      fireEvent.click(screen.getByTestId('advanced-copy-public-key'));
    });

    expect(
      screen.getByTestId('advanced-copy-public-key').querySelector('[data-copy-label] [data-present="true"]')
    ).toHaveTextContent('copied');
  });

  it('renders a non-breaking-space placeholder and no copy action when the account is not found', async () => {
    mockGetAccount.mockResolvedValue(null);

    const { container } = render(<AdvancedSettings />);

    await waitFor(() => expect(mockGetAccount).toHaveBeenCalled());
    // `resolvePublicKeyCommitments` is never reached when the account is null.
    expect(mockResolveCommitments).not.toHaveBeenCalled();

    await waitFor(() => {
      const chip = container.querySelector('.font-mono') as HTMLElement;
      // U+00A0 placeholder keeps the row height stable before/without a key.
      expect(chip.textContent).toBe(' ');
    });

    // Nothing to copy, so no action to press.
    expect(queryCopyAction()).toBeNull();
    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('leaves the key unresolved when the account has no public-key commitments', async () => {
    mockGetAccount.mockResolvedValue({});
    mockResolveCommitments.mockReturnValue([]);

    const { container } = render(<AdvancedSettings />);

    await waitFor(() => expect(mockResolveCommitments).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      const chip = container.querySelector('.font-mono') as HTMLElement;
      expect(chip.textContent).toBe(' ');
    });
    expect(queryCopyAction()).toBeNull();
  });

  it('navigates to the faucet-id editor when the faucet row is pressed', async () => {
    await renderWithResolvedKey();

    fireEvent.click(screen.getByText('editMidenFaucetId'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/edit-miden-faucet-id');
  });

  it('navigates to the guarded account-file export when its row is pressed', async () => {
    await renderWithResolvedKey();

    fireEvent.click(screen.getByText('exportAccountFile'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/export-account-file');
  });
});

it('does not offer the account-file export for a Guardian account', () => {
  // The vault refuses a Guardian export outright, so offering the row would only lead the user
  // through the funds warning and a credential prompt to a certain refusal.
  mockUseAccount.mockReturnValue({ publicKey: 'guardian-account', type: 'guardian' });

  render(<AdvancedSettings />);

  expect(screen.queryByText('exportAccountFile')).not.toBeInTheDocument();
});
