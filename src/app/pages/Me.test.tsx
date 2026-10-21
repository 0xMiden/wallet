import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import Me from './Me';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')})`
        : key
  })
}));
let mockEarned: string[] = [];
jest.mock('lib/badges/useWalletBadges', () => ({ useWalletBadges: () => mockEarned }));
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

afterEach(() => {
  mockEarned = [];
  jest.clearAllMocks();
});

it('shows a standard Profile tab header and keeps the account identity without a close action', () => {
  render(<Me />);
  expect(screen.getByRole('heading', { level: 1, name: 'profile' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Account 1' })).toBeInTheDocument();
  expect(screen.getByText('Testnet')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument();
});

it('puts My badges before the original embedded settings menu', () => {
  render(<Me />);
  const badges = screen.getByTestId('my-badges-preview');
  const settings = screen.getByTestId('original-settings');
  expect(badges).toHaveTextContent('myBadges');
  fireEvent.click(badges);
  expect(navigate).toHaveBeenCalledWith('/me/badges');
  expect(settings).toHaveAttribute('data-embedded', 'true');
  expect(badges.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('releases the mobile tab frame when unmounted', () => {
  const { unmount } = render(<Me />);
  expect(document.body).toHaveAttribute('data-edge-to-edge');
  unmount();
  expect(document.body).not.toHaveAttribute('data-edge-to-edge');
});

it('shows badge progress as a count and a meter', () => {
  render(<Me />);
  expect(screen.getByText('badgesEarnedCount(earned=0,total=6)')).toBeInTheDocument();
  const meter = screen.getByRole('progressbar', { name: 'myBadges' });
  expect(meter).toHaveAttribute('aria-valuenow', '0');
  expect(meter).toHaveAttribute('aria-valuemax', '6');
});

it('counts an earned badge in the preview and its meter', () => {
  mockEarned = ['first-deposit'];
  render(<Me />);
  expect(screen.getByText('badgesEarnedCount(earned=1,total=6)')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'myBadges' })).toHaveAttribute('aria-valuenow', '1');
});

it('shows the address as one short copy chip and the network as its own tag', () => {
  render(<Me />);
  expect(screen.getByTestId('profile-address')).toHaveTextContent('0x123456…7890');
  expect(screen.getByTestId('profile-network')).toHaveTextContent('Testnet');
});
