import React from 'react';

import { render, screen } from '@testing-library/react';

import Me from './Me';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/badges/useWalletBadges', () => ({ useWalletBadges: () => [] }));
jest.mock('./Settings', () => ({
  __esModule: true,
  default: ({ embedded }: { embedded: boolean }) => <div data-testid="original-settings" data-embedded={embedded} />
}));
jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: '0x1234567890123456789012345678901234567890', name: 'Account 1' }),
  useNetwork: () => ({ id: 'testnet', name: 'Testnet' })
}));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  Link: ({ to, children, testID, ...props }: React.PropsWithChildren<{ to: string; testID?: string }>) => (
    <a href={to} {...props}>
      {children}
    </a>
  )
}));

afterEach(() => jest.clearAllMocks());

it('shows a standard Profile tab header and keeps the account identity without a close action', () => {
  render(<Me />);
  expect(screen.getByRole('heading', { level: 1, name: 'profile' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Account 1' })).toBeInTheDocument();
  expect(screen.getByText('Testnet')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument();
});

it('puts My badges before the original embedded settings menu', () => {
  render(<Me />);
  const badges = screen.getByRole('link', { name: /openMyBadges/ });
  const settings = screen.getByTestId('original-settings');
  expect(badges).toHaveAttribute('href', '/me/badges');
  expect(settings).toHaveAttribute('data-embedded', 'true');
  expect(badges.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('releases the mobile tab frame when unmounted', () => {
  const { unmount } = render(<Me />);
  expect(document.body).toHaveAttribute('data-edge-to-edge');
  unmount();
  expect(document.body).not.toHaveAttribute('data-edge-to-edge');
});
