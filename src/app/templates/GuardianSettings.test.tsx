import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import GuardianSettings from './GuardianSettings';

const mockUseCurrentGuardianEndpoint = jest.fn();
const mockGuardianOptionForEndpoint = jest.fn();
jest.mock('app/hooks/useCurrentGuardianEndpoint', () => ({
  useCurrentGuardianEndpoint: () => mockUseCurrentGuardianEndpoint(),
  guardianOptionForEndpoint: (endpoint: string) => mockGuardianOptionForEndpoint(endpoint),
  guardianEndpointHost: (endpoint: string) => (endpoint ? new URL(endpoint).host : '')
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { lastSyncedAt: number | null }) => unknown) => selector({ lastSyncedAt: null })
}));

jest.mock('components/Button', () => ({
  // Fires the haptic the real Button fires on every click (Button.tsx). Without it
  // a handler adding its own looked like the only one, which is how the rotate CTA
  // came to buzz twice — the mock counted one call either way.
  Button: ({ title, onClick }: { title: string; onClick: () => void }) => (
    <button
      onClick={() => {
        mockHapticLight();
        onClick();
      }}
    >
      {title}
    </button>
  )
}));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: () => mockHapticLight() }));

const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (path: string) => mockNavigate(path) }));

// GuardianInfoDrawer — the real component renders through vaul portals; a
// passthrough stub exposes its `open` prop so the "Learn more" wiring is testable.
jest.mock('screens/onboarding/common/GuardianInfoDrawer', () => ({
  GuardianInfoDrawer: ({ open }: { open: boolean }) => (
    <div data-testid="guardian-info-drawer" data-open={String(open)} />
  )
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: 'https://guardian.one', refresh: jest.fn() });
  mockGuardianOptionForEndpoint.mockReturnValue({
    id: 'open-zeppelin',
    name: 'Guardian One',
    operatedBy: 'Provider One',
    location: 'US-EAST'
  });
});

it('renders the configured guardian summary and live details', () => {
  render(<GuardianSettings />);

  expect(mockGuardianOptionForEndpoint).toHaveBeenCalledWith('https://guardian.one');
  expect(screen.getByTestId('guardian-operator-logo')).toBeInTheDocument();
  expect(screen.getByText('Guardian One')).toBeInTheDocument();
  expect(screen.getByText('online')).toBeInTheDocument();
  expect(screen.getByText('guardianInfoDescription')).toBeInTheDocument();
  expect(screen.getByText('Provider One')).toBeInTheDocument();
  expect(screen.getByText('guardian.one')).toBeInTheDocument();
  expect(screen.getByText('US-EAST')).toBeInTheDocument();
  expect(screen.getByText('never')).toBeInTheDocument();
});

it('labels an unmatched endpoint as a custom guardian', () => {
  mockGuardianOptionForEndpoint.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(screen.getByRole('heading', { name: 'customGuardian' })).toBeInTheDocument();
  expect(screen.getByTestId('guardian-avatar')).toBeInTheDocument();
});

it('shows loading while the guardian endpoint is unresolved', () => {
  mockUseCurrentGuardianEndpoint.mockReturnValue({ endpoint: '', refresh: jest.fn() });
  mockGuardianOptionForEndpoint.mockReturnValue(undefined);
  render(<GuardianSettings />);

  expect(screen.getByRole('heading', { name: 'loading' })).toBeInTheDocument();
});

it('opens the Guardian explainer drawer from the About section', () => {
  render(<GuardianSettings />);

  expect(screen.getByTestId('guardian-info-drawer')).toHaveAttribute('data-open', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'learnMoreAboutGuardian' }));

  expect(mockHapticLight).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('guardian-info-drawer')).toHaveAttribute('data-open', 'true');
});

it('navigates to guardian rotation, buzzing once', () => {
  render(<GuardianSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'rotateGuardian' }));

  // Once, from Button's own wrapper — the handler must not add a second. The
  // "Learn more" button above is a plain <button>, so its haptic is its own.
  expect(mockHapticLight).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith('/rotate-guardian');
});
