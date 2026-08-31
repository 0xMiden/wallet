import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useStorage, useMidenContext, useAccount } from 'lib/miden/front';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';

import DAppDrawerSettings from './DAppDrawerSettings';
import { GeneralSettingsSelectors } from './GeneralSettings.selectors';

// `@miden-sdk/miden-wallet-adapter-base` ships as untransformed ESM and is
// pulled in transitively by `lib/miden/types` (imported for the real
// `MidenSharedStorageKey` enum). Stub the members that module references so the
// enum can load without the ESM import breaking the transform.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: {},
  SignKind: {}
}));

// `t` is never `init()`-ed in the unit env; echo the key back so rendered copy
// is assertable by key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `ToggleSwitch` reaches into analytics / haptics / brand colors. Render a plain
// controlled checkbox exposing checked/onChange/name/testID so every prop and
// branch of DAppDrawerSettings is assertable.
jest.mock('app/atoms/ToggleSwitch', () => ({
  __esModule: true,
  default: ({
    checked,
    onChange,
    name,
    testID
  }: {
    checked: boolean;
    onChange: (evt: React.ChangeEvent<HTMLInputElement>) => void;
    name: string;
    testID: string;
  }) => <input type="checkbox" data-testid={testID} name={name} checked={checked} onChange={onChange} />
}));

// `app/icons/v2` bundles SVG components; surface the icon name as a marker so
// the chevron in the "see connected" button is assertable.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { ChevronRightLucide: 'chevron-right-lucide' }
}));

// `lib/miden/front` is a barrel over the SDK / storage layer; mock only the
// three members the component reads.
jest.mock('lib/miden/front', () => ({
  useStorage: jest.fn(),
  useMidenContext: jest.fn(),
  useAccount: jest.fn()
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const mockUseStorage = useStorage as jest.Mock;
const mockUseMidenContext = useMidenContext as jest.Mock;
const mockUseAccount = useAccount as jest.Mock;
const mockUseRetryableSWR = useRetryableSWR as jest.Mock;
const mockNavigate = navigate as jest.Mock;

const getAllDAppSessions = jest.fn();
const setDAppEnabled = jest.fn();

const ACCOUNT_ID = 'mtst1account_ABCD';

type Session = { accountId: string };

// One origin whose session matches the active account → hasConnectedDApps true.
const CONNECTED: Record<string, Session[]> = {
  'https://app.example.com': [{ accountId: 'someone_else' }, { accountId: ACCOUNT_ID }]
};

// An origin with sessions, but none matching the active account → the
// `sessions.some(...)` predicate returns false → hasConnectedDApps false.
const NOT_CONNECTED: Record<string, Session[]> = {
  'https://other.io': [{ accountId: 'nobody_ZZZ' }]
};

const setData = (data: Record<string, Session[]> | undefined) => {
  mockUseRetryableSWR.mockReturnValue({ data });
};

const setStorage = (value: boolean) => {
  mockUseStorage.mockReturnValue([value, setDAppEnabled]);
};

beforeEach(() => {
  jest.clearAllMocks();
  setDAppEnabled.mockResolvedValue(undefined);
  mockUseMidenContext.mockReturnValue({ getAllDAppSessions });
  mockUseAccount.mockReturnValue({ publicKey: ACCOUNT_ID });
  setStorage(true);
  setData(undefined);
});

describe('DAppDrawerSettings', () => {
  it('renders the interaction label, description and the dApp toggle reflecting the stored value', () => {
    render(<DAppDrawerSettings />);

    expect(screen.getByText('dAppsInteraction')).toBeInTheDocument();
    expect(screen.getByText('dAppsToggleDescription')).toBeInTheDocument();

    const toggle = screen.getByTestId(GeneralSettingsSelectors.DAppToggle) as HTMLInputElement;
    expect(toggle).toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute('name', 'dAppEnabled');
  });

  it('wires useStorage with the DAppEnabled key defaulting to enabled and useRetryableSWR with the sessions loader', () => {
    render(<DAppDrawerSettings />);

    expect(mockUseStorage).toHaveBeenCalledWith('DAppEnabled', true);
    expect(mockUseRetryableSWR).toHaveBeenCalledWith(
      ['getAllDAppSessions'],
      getAllDAppSessions,
      expect.objectContaining({
        suspense: true,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false
      })
    );
  });

  it('reflects a disabled stored value in the toggle', () => {
    setStorage(false);

    render(<DAppDrawerSettings />);

    expect(screen.getByTestId(GeneralSettingsSelectors.DAppToggle)).not.toBeChecked();
  });

  it('hides the "see connected" button when the sessions data is undefined (the `data ?? {}` branch)', () => {
    setData(undefined);

    render(<DAppDrawerSettings />);

    expect(screen.queryByText('seeConnected')).not.toBeInTheDocument();
  });

  it('hides the "see connected" button when no session matches the active account', () => {
    setData(NOT_CONNECTED);

    render(<DAppDrawerSettings />);

    expect(screen.queryByText('seeConnected')).not.toBeInTheDocument();
  });

  it('hides the "see connected" button for an empty sessions map', () => {
    setData({});

    render(<DAppDrawerSettings />);

    expect(screen.queryByText('seeConnected')).not.toBeInTheDocument();
  });

  it('renders the "see connected" button when a session matches the active account', () => {
    setData(CONNECTED);

    render(<DAppDrawerSettings />);

    expect(screen.getByText('seeConnected')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'chevron-right-lucide');
  });

  it('navigates to the dapps settings when "see connected" is clicked', () => {
    setData(CONNECTED);

    render(<DAppDrawerSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'seeConnected' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/dapps');
  });

  it('persists the new value when the dApp toggle is switched', () => {
    render(<DAppDrawerSettings />);

    // Initial checked = true → clicking dispatches a change with checked = false.
    fireEvent.click(screen.getByTestId(GeneralSettingsSelectors.DAppToggle));

    expect(setDAppEnabled).toHaveBeenCalledTimes(1);
    expect(setDAppEnabled).toHaveBeenCalledWith(false);
  });

  it('guards the dApp toggle against re-entrant changes', () => {
    render(<DAppDrawerSettings />);
    const toggle = screen.getByTestId(GeneralSettingsSelectors.DAppToggle);

    // While the first change is still "in-flight", synchronously fire a second
    // change. The re-entrancy ref guard must short-circuit it so the setter
    // runs exactly once.
    setDAppEnabled.mockImplementationOnce(() => {
      fireEvent.click(toggle);
      return Promise.resolve();
    });

    fireEvent.click(toggle);

    expect(setDAppEnabled).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejection from the setter (the `.catch(() => {})` branch)', async () => {
    setDAppEnabled.mockRejectedValueOnce(new Error('boom'));

    render(<DAppDrawerSettings />);

    // Must not throw / produce an unhandled rejection.
    fireEvent.click(screen.getByTestId(GeneralSettingsSelectors.DAppToggle));

    await waitFor(() => expect(setDAppEnabled).toHaveBeenCalledWith(false));
    // Flush the rejection microtask so the catch handler executes.
    await Promise.resolve();
  });
});
