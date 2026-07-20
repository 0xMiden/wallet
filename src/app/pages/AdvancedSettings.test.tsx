import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useAccount } from 'lib/miden/front';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import AdvancedSettings from './AdvancedSettings';

// `t` is never `init()`-ed in the unit env; echo the key back so rendered copy
// (labels rendered via `t(...)`) is assertable by key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `app/icons/v2` is a barrel of SVG components. Render a marker element that
// surfaces the icon `name` so the copied/not-copied and chevron icons are
// individually assertable via `[data-icon="..."]`.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  IconName: { Checkmark: 'checkmark', Copy: 'copy', ChevronRightLucide: 'chevron-right' }
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
  navigate: jest.fn()
}));

// Controllable copy hook: `copy` is a spy and `copied` is a mutable flag so the
// checkmark-vs-copy icon branch can be driven from the test.
const mockCopy = jest.fn();
let mockCopied = false;
jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null }, copy: mockCopy, copied: mockCopied })
}));

const mockUseAccount = useAccount as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;
const mockNavigate = navigate as jest.Mock;

// A 16-char (post-`0x`) key resolves to a stable truncation:
// `0x` + first 6 (`abcdef`) + `...` + last 4 (`7890`).
const RESOLVED_KEY = 'abcdef1234567890';
const commitment = { toHex: () => `0x${RESOLVED_KEY}` };

const getCopyButton = (container: HTMLElement) => container.querySelectorAll('button')[0];

const renderWithResolvedKey = async (props?: { onClose?: () => void }) => {
  mockGetAccount.mockResolvedValue({});
  mockResolveCommitments.mockReturnValue([commitment]);
  const view = render(<AdvancedSettings {...props} />);
  // Wait for the async effect to resolve and paint the truncated key.
  await screen.findByText('0xabcdef...7890');
  return view;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCopied = false;
  mockUseAccount.mockReturnValue({ publicKey: 'account-id-1' });
});

describe('AdvancedSettings (page)', () => {
  it('renders both section labels', async () => {
    await renderWithResolvedKey();

    expect(screen.getByText('accountPublicKey')).toBeInTheDocument();
    expect(screen.getByText('editMidenFaucetId')).toBeInTheDocument();
  });

  it('resolves the account public key and displays the truncated chip', async () => {
    const { container } = await renderWithResolvedKey();

    // Client was queried with the wallet account's public key.
    expect(mockGetAccount).toHaveBeenCalledWith('account-id-1');
    // Commitment resolver received the fetched account.
    expect(mockResolveCommitments).toHaveBeenCalledWith({});

    // Truncated chip: 0x + first 6 + ... + last 4.
    expect(screen.getByText('0xabcdef...7890')).toBeInTheDocument();

    // The hidden sr-only input mirrors the full (un-truncated) key.
    const srInput = container.querySelector('input') as HTMLInputElement;
    expect(srInput.value).toBe(RESOLVED_KEY);

    // Copy button is enabled and shows the (not-yet-copied) copy icon.
    expect(getCopyButton(container)).not.toBeDisabled();
    expect(container.querySelector('[data-icon="copy"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="checkmark"]')).toBeNull();
  });

  it('triggers haptics and copies when the enabled copy button is pressed', async () => {
    const { container } = await renderWithResolvedKey();

    fireEvent.click(getCopyButton(container));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockCopy).toHaveBeenCalledTimes(1);
  });

  it('shows the checkmark icon while in the copied state', async () => {
    mockCopied = true;
    const { container } = await renderWithResolvedKey();

    expect(container.querySelector('[data-icon="checkmark"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="copy"]')).toBeNull();
  });

  it('renders a non-breaking-space placeholder and disabled copy button when the account is not found', async () => {
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

    const copyButton = getCopyButton(container);
    expect(copyButton).toBeDisabled();

    // The disabled button does not dispatch the click handler.
    fireEvent.click(copyButton);
    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();

    // Hidden input falls back to an empty string when there is no key.
    const srInput = container.querySelector('input') as HTMLInputElement;
    expect(srInput.value).toBe('');
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
    expect(getCopyButton(container)).toBeDisabled();
  });

  it('closes the sheet and navigates to the faucet-id editor when the faucet row is pressed', async () => {
    const onClose = jest.fn();
    await renderWithResolvedKey({ onClose });

    fireEvent.click(screen.getByText('editMidenFaucetId'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/edit-miden-faucet-id');
  });

  it('navigates without throwing when no onClose handler is provided', async () => {
    await renderWithResolvedKey();

    expect(() => fireEvent.click(screen.getByText('editMidenFaucetId'))).not.toThrow();
    expect(mockNavigate).toHaveBeenCalledWith('/settings/edit-miden-faucet-id');
  });
});
