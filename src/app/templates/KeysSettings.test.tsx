import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { SeedPhraseStatus } from 'lib/shared/types';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

import KeysSettings from './KeysSettings';

// ---------------------------------------------------------------------------
// Mocks.
//
// KeysSettings is a thin router surface: it derives which key-management rows
// to show from the current account's `type` / `hotPublicKey`, renders them as
// ListRows in one ListGroup on the shared SubPageLayout, and (for guardians)
// appends the GuardianReplaceHotKey section.
// Every collaborator is stubbed so the only code exercised (and measured) is
// KeysSettings.tsx itself.
// ---------------------------------------------------------------------------

// i18n: identity translator so assertions can match on the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { ChevronLeft: 'chevron-left', Close: 'close' }
}));

// GuardianReplaceHotKey drives a full cold-signed rotation flow with its own
// native/store collaborators. Replace it with a marker so the guardian-only
// branch (`{isGuardian && <GuardianReplaceHotKey/>}`) is observable in
// isolation.
jest.mock('app/templates/GuardianReplaceHotKey', () => ({
  __esModule: true,
  default: () => <div data-testid="guardian-replace-hot-key" />
}));

// `navigate` (woozie) and `hapticLight` (native haptics) are the two side
// effects of `openPage`; stub both as spies.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  Link: () => null
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// Store: KeysSettings calls `useWalletStore(selector)` once per derived value,
// so the mock simply applies each selector to a per-test `mockState`.
const mockState: {
  currentAccount: { type?: WalletType; hotPublicKey?: string; coldPublicKey?: string } | undefined;
  seedPhraseStatus?: SeedPhraseStatus;
} = {
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
  mockState.seedPhraseStatus = 'stored';
});

// ---------------------------------------------------------------------------
// Row visibility across account shapes.
// ---------------------------------------------------------------------------
describe('KeysSettings — row visibility', () => {
  it.each<SeedPhraseStatus | undefined>(['removing', 'removed', 'unavailable', undefined])(
    'keeps the paired private key reveal with seed status %s',
    status => {
      mockState.seedPhraseStatus = status;
      mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot-key', coldPublicKey: 'cold-key' };
      render(<KeysSettings />);

      expect(screen.getAllByText('revealPrivateKey')).toHaveLength(1);
      expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
      expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();
      expect(screen.getByTestId('guardian-replace-hot-key')).toBeInTheDocument();
    }
  );

  it('renders only the reveal-private-key row for a non-guardian account and omits the guardian section', () => {
    mockState.currentAccount = { type: WalletType.OffChain };

    render(<KeysSettings />);

    // `show: true` row is always present.
    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    // Guardian-gated rows hidden.
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();
    // No GuardianReplaceHotKey for non-guardians.
    expect(screen.queryByTestId('guardian-replace-hot-key')).not.toBeInTheDocument();

    // Exactly one row → one button → one chevron.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.querySelector('[data-slot="chevron"]')).not.toBeNull();
  });

  it('renders one paired reveal row and no guardian rotation for an activated guardian', () => {
    mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot_pk_1', coldPublicKey: 'cold_pk_1' };

    render(<KeysSettings />);

    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    // `isGuardian && hasActivatedHotKey` → true.
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    // Rotation is the Guardian Settings CTA, not a keys row.
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();

    // Guardian block: GuardianReplaceHotKey rendered, with no rule above it.
    expect(document.querySelector('hr')).toBeNull();
    expect(screen.getByTestId('guardian-replace-hot-key')).toBeInTheDocument();

    // The paired reveal is the only row.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('hides the reveal-hot-key row for a guardian without an activated hot key but keeps the guardian section', () => {
    mockState.currentAccount = { type: WalletType.Guardian, coldPublicKey: 'cold_pk_1' };

    render(<KeysSettings />);

    expect(screen.queryByText('revealPrivateKey')).not.toBeInTheDocument();
    // hasActivatedHotKey === false → reveal-hot-key hidden.
    expect(screen.queryByText('revealHotKey')).not.toBeInTheDocument();
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();

    expect(screen.getByTestId('guardian-replace-hot-key')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  // Hot-key-only import: a Guardian account with no coldPublicKey and no seed.
  // The cold-signed hot key replacement stays offered: the pipeline prompts for
  // the seed phrase per transaction and derives the cold key against the
  // on-chain signer without storing it.
  it('keeps the hot key replacement for a guardian without a cold key', () => {
    mockState.seedPhraseStatus = 'unavailable';
    mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot_pk_1' };

    render(<KeysSettings />);

    expect(screen.getByText('revealPrivateKey')).toBeInTheDocument();
    expect(screen.queryByText('rotateGuardian')).not.toBeInTheDocument();
    expect(screen.getByTestId('guardian-replace-hot-key')).toBeInTheDocument();
    expect(screen.queryByText('recoveryActionsRequireRecoveryKey')).not.toBeInTheDocument();
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
// Shared layout.
// ---------------------------------------------------------------------------
describe('KeysSettings — layout', () => {
  it('renders through SubPageLayout: the row as a ListRow in one ListGroup, then the rotation section', () => {
    mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot_pk_1', coldPublicKey: 'cold_pk_1' };

    render(<KeysSettings />);

    const page = screen.getByTestId('keys-settings');
    const body = page.querySelector('[data-slot="body"]')!;
    expect(body).toHaveClass('px-4', 'gap-5', 'overflow-y-auto');

    const reveal = screen.getByTestId('keys-reveal-private-key');
    expect(screen.queryByTestId('keys-rotate-guardian')).toBeNull();
    // One ListGroup on the shared fill holds the row.
    expect(reveal.parentElement).toHaveClass('bg-fill', 'rounded-2xl');
    // Rows are ListRows: the shared 16px title and a trailing chevron.
    expect(reveal.querySelector('[data-slot="title"]')).toHaveTextContent('revealPrivateKey');
    expect(reveal.querySelector('[data-slot="chevron"]')).not.toBeNull();
    // The rotation section follows as a sibling section of the body, 20px below.
    expect(screen.getByTestId('guardian-replace-hot-key').parentElement).toBe(body);
    // No page footer: rotation is a section action, not the page's CTA.
    expect(page.querySelector('[data-slot="footer"]')).toBeNull();
  });

  it('renders no empty group when no row applies', () => {
    mockState.currentAccount = { type: WalletType.OffChain };
    mockState.seedPhraseStatus = 'removed';

    render(<KeysSettings />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelector('.bg-fill')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openPage side effects.
// ---------------------------------------------------------------------------
describe('KeysSettings — openPage', () => {
  it('fires haptics and navigates to the row path when a row is clicked', () => {
    mockState.currentAccount = { type: WalletType.OffChain };

    render(<KeysSettings />);

    fireEvent.click(screen.getByText('revealPrivateKey'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/reveal-private-key');
  });

  it('navigates a guardian reveal row to the hot key page', () => {
    mockState.currentAccount = { type: WalletType.Guardian, hotPublicKey: 'hot_pk_1', coldPublicKey: 'cold_pk_1' };

    render(<KeysSettings />);

    fireEvent.click(screen.getByText('revealPrivateKey'));
    expect(mockNavigate).toHaveBeenLastCalledWith('/settings/reveal-hot-key');

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });
});
