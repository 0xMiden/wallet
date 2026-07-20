import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { navigate } from 'lib/woozie';
import { WalletPromptType } from 'lib/wallet-prompts';

import { HomePrompts } from './HomePrompts';

// `t` is never `init()`-ed in the unit env; echo the key back so the rendered
// copy is directly assertable by translation key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `navigate` fires on card tap. Spy on it so we can assert the routed path
// without pulling in the real woozie history stack.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

// The real banner lazy-requires native Capacitor haptics + the miden front
// barrel. Stub it to a marker so we can assert it renders (or not) based on
// `account.requiresHotKeyRotation`.
jest.mock('app/templates/ActivateHotKeyBanner', () => ({
  ActivateHotKeyBanner: () => <div data-testid="hotkey-banner">hotkey-banner</div>
}));

// The real PromptCard/PromptCarousel drag in framer-motion, haptics and SVG
// icons. Substitute thin stubs that faithfully forward the props HomePrompts
// relies on (title/body/variant/onClick/onDismiss and the children list) so the
// test stays hermetic while still exercising every handler HomePrompts wires.
jest.mock('components/ui', () => ({
  PromptCarousel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="prompt-carousel">{children}</div>
  ),
  PromptCard: ({
    title,
    body,
    variant,
    onClick,
    onDismiss
  }: {
    title: string;
    body?: string;
    variant?: string;
    onClick?: () => void;
    onDismiss?: () => void;
  }) => (
    <div data-testid="prompt-card" data-variant={variant ?? ''} data-dismissible={String(!!onDismiss)}>
      <button type="button" data-testid="card-click" onClick={onClick}>
        {title}
      </button>
      <span data-testid="card-body">{body}</span>
      {onDismiss && (
        <button type="button" data-testid="card-dismiss" onClick={onDismiss}>
          dismiss
        </button>
      )}
    </div>
  )
}));

// `useWalletPromptStorage` is the single source of pending-state + dismissal.
// We keep the real `WalletPromptType` enum (HomePrompts keys its definition map
// off it at module-eval time) and only replace the hook so each test can drive
// `isPromptPending` / `dismissPrompt`.
const mockIsPromptPending = jest.fn();
const mockDismissPrompt = jest.fn();

jest.mock('lib/wallet-prompts', () => ({
  WalletPromptType: { VerifySeedPhrase: 'verifySeedPhrase' },
  useWalletPromptStorage: () => ({
    isPromptPending: mockIsPromptPending,
    dismissPrompt: mockDismissPrompt
  })
}));

const mockNavigate = navigate as jest.MockedFunction<typeof navigate>;

// Minimal cast — HomePrompts only reads `requiresHotKeyRotation`.
const makeAccount = (requiresHotKeyRotation?: boolean) =>
  ({ requiresHotKeyRotation } as Parameters<typeof HomePrompts>[0]['account']);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('HomePrompts', () => {
  it('renders the pending VerifySeedPhrase prompt inside the carousel', () => {
    mockIsPromptPending.mockReturnValue(true);

    render(<HomePrompts account={makeAccount(false)} />);

    expect(screen.getByTestId('prompt-carousel')).toBeInTheDocument();

    const card = screen.getByTestId('prompt-card');
    // Title/body echo the definition's translation keys; variant + dismissible
    // come straight from the VerifySeedPhrase definition.
    expect(screen.getByTestId('card-click')).toHaveTextContent('verifySeedPhrasePromptTitle');
    expect(screen.getByTestId('card-body')).toHaveTextContent('verifySeedPhrasePromptBody');
    expect(card).toHaveAttribute('data-variant', 'warning');
    expect(card).toHaveAttribute('data-dismissible', 'true');

    // The pending check was driven with the real enum value.
    expect(mockIsPromptPending).toHaveBeenCalledWith(WalletPromptType.VerifySeedPhrase);
  });

  it('navigates to the prompt route when the card is clicked', () => {
    mockIsPromptPending.mockReturnValue(true);

    render(<HomePrompts account={makeAccount(false)} />);

    fireEvent.click(screen.getByTestId('card-click'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/verify-seed-phrase');
  });

  it('dismisses the prompt via the dismiss handler', () => {
    mockIsPromptPending.mockReturnValue(true);

    render(<HomePrompts account={makeAccount(false)} />);

    fireEvent.click(screen.getByTestId('card-dismiss'));

    expect(mockDismissPrompt).toHaveBeenCalledTimes(1);
    expect(mockDismissPrompt).toHaveBeenCalledWith(WalletPromptType.VerifySeedPhrase);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders no prompt cards when nothing is pending', () => {
    mockIsPromptPending.mockReturnValue(false);

    render(<HomePrompts account={makeAccount(false)} />);

    // Carousel still mounts, but the pending filter drops every definition.
    expect(screen.getByTestId('prompt-carousel')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-card')).not.toBeInTheDocument();
  });

  it('renders the ActivateHotKeyBanner when the account requires hot-key rotation', () => {
    mockIsPromptPending.mockReturnValue(false);

    render(<HomePrompts account={makeAccount(true)} />);

    expect(screen.getByTestId('hotkey-banner')).toBeInTheDocument();
  });

  it('omits the ActivateHotKeyBanner when rotation is not required', () => {
    mockIsPromptPending.mockReturnValue(false);

    render(<HomePrompts account={makeAccount(false)} />);

    expect(screen.queryByTestId('hotkey-banner')).not.toBeInTheDocument();
  });

  it('renders both the pending prompt and the hot-key banner together', () => {
    mockIsPromptPending.mockReturnValue(true);

    render(<HomePrompts account={makeAccount(true)} />);

    expect(screen.getByTestId('prompt-card')).toBeInTheDocument();
    expect(screen.getByTestId('hotkey-banner')).toBeInTheDocument();
  });
});
