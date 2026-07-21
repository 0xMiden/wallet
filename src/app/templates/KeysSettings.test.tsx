import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import KeysSettings from './KeysSettings';

// ---------------------------------------------------------------------------
// Mocks.
//
// KeysSettings is a thin router surface: it derives which key-management rows
// to show from the current account's `type` / `hotPublicKey`, renders a button
// per visible row, and (for guardians) appends a divider + GuardianReplaceHotKey.
// Every collaborator is stubbed so the only code exercised (and measured) is
// KeysSettings.tsx itself.
// ---------------------------------------------------------------------------

// i18n: identity translator so assertions can match on the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Icon reaches into the SVG barrel; render a marker exposing its `name` so the
// chevron per row is assertable without pulling in real icon assets.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { ChevronRightLucide: 'chevron-right-lucide' }
}));

// GuardianReplaceHotKey drives a full cold-signed rotation flow with its own
// native/store collaborators. Replace it with a marker so the guardian-only
// branch (`{isGuardian && <hr/><GuardianReplaceHotKey/>}`) is observable in
// isolation.
jest.mock('app/templates/GuardianReplaceHotKey', () => ({
  __esModule: true,
  default: () => <div data-testid="guardian-replace-hot-key" />
}));

// `navigate` (woozie) and `hapticLight` (native haptics) are the two side
// effects of `openPage`; stub both as spies.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Store: KeysSettings calls `useWalletStore(selector)` once per derived value,
// so the mock simply applies each selector to a per-test `mockState`.
const mockState: { currentAccount: { type?: WalletType; hotPublicKey?: string } | undefined } = {
  currentAccount: undefined
};
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) => selector(mockState)
}));

const mockNavigate = navigate as jest.Mock;
const mockHapticLight = hapticLight as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockState.currentAccount = undefined;
});

// ---------------------------------------------------------------------------
// Row visibility across account shapes.
// ---------------------------------------------------------------------------
describe('KeysSettings — row visibility', () => {
  it('renders only the reveal-private-key row for a non-guardian account and omits the guardian section', () => {
    mockState.currentAccount = { type: WalletType.OffChain };

    render(<KeysSettings />);

    // `show: true` row is always present.
    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    // Guardian-gated rows hidden.
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();
    // No divider / GuardianReplaceHotKey for non-guardians.
    expect(screen.queryByTestId('guardian-replace-hot-key')).not.toBeInTheDocument();
    expect(document.querySelector('hr')).toBeNull();

    // Exactly one row → one button → one chevron icon.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const icon = screen.getByTestId('icon');
    expect(icon).toHaveAttribute('data-name', 'chevron-right-lucide');
  });

  it('renders all three rows plus the guardian section for a guardian with an activated hot key', () => {
    mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot_pk_1' };

    render(<KeysSettings />);

    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    // `isGuardian && hasActivatedHotKey` → true.
    expect(screen.getByText('revealHotKey')).toBeInTheDocument();
    // `isGuardian` → true.
    expect(screen.getByText('rotateGuardian')).toBeInTheDocument();

    // Guardian block: divider + GuardianReplaceHotKey rendered.
    expect(document.querySelector('hr')).not.toBeNull();
    expect(screen.getByTestId('guardian-replace-hot-key')).toBeInTheDocument();

    // Three visible rows → three row buttons.
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('hides the reveal-hot-key row for a guardian without an activated hot key but keeps rotate-guardian and the guardian section', () => {
    mockState.currentAccount = { type: WalletType.Guardian };

    render(<KeysSettings />);

    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    // hasActivatedHotKey === false → reveal-hot-key hidden.
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    // rotate-guardian only needs `isGuardian`.
    expect(screen.getByText('rotateGuardian')).toBeInTheDocument();

    expect(screen.getByTestId('guardian-replace-hot-key')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('does not reveal the hot-key row for a non-guardian even when a hot public key is present', () => {
    // `isGuardian && hasActivatedHotKey`: hasActivatedHotKey is true here, so
    // this pins the AND short-circuit on `isGuardian === false`.
    mockState.currentAccount = { type: WalletType.OnChain, hotPublicKey: 'hot_pk_2' };

    render(<KeysSettings />);

    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();
    expect(screen.queryByTestId('guardian-replace-hot-key')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('handles a missing current account (optional chaining) by showing only the reveal-private-key row', () => {
    mockState.currentAccount = undefined;

    render(<KeysSettings />);

    // `s.currentAccount?.type` / `?.hotPublicKey` both resolve undefined.
    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();
    expect(screen.queryByTestId('guardian-replace-hot-key')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// openPage side effects.
// ---------------------------------------------------------------------------
describe('KeysSettings — openPage', () => {
  it('fires haptics, closes and navigates to the row path when a row is clicked', () => {
    mockState.currentAccount = { type: WalletType.OffChain };
    const onClose = jest.fn();

    render(<KeysSettings onClose={onClose} />);

    fireEvent.click(screen.getByText('revealPrivateKey'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/reveal-private-key');
  });

  it('navigates to each guardian row path with its own target', () => {
    mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot_pk_1' };
    const onClose = jest.fn();

    render(<KeysSettings onClose={onClose} />);

    fireEvent.click(screen.getByText('revealHotKey'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/settings/reveal-hot-key');

    fireEvent.click(screen.getByText('rotateGuardian'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/rotate-guardian');

    // Three clicks in total (private key not clicked here) → onClose each time.
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mockHapticLight).toHaveBeenCalledTimes(2);
  });

  it('does not throw when onClose is omitted (optional-chaining no-op) and still navigates', () => {
    mockState.currentAccount = { type: WalletType.OffChain };

    render(<KeysSettings />);

    expect(() => fireEvent.click(screen.getByText('revealPrivateKey'))).not.toThrow();
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/reveal-private-key');
  });
});
