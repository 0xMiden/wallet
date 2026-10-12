import React from 'react';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

import { MidenNameClaimSlot, useMidenNameClaimOffer } from './MidenNameClaimSlot';

const mockNavigate = jest.fn();
let mockSupported = true;
let mockRegistrations: { rows: unknown[]; loaded: boolean } = { rows: [], loaded: true };
let mockOwned: string | undefined;
let mockClaiming = false;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => mockNavigate(...args) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('lib/store', () => ({
  useWalletStore: (select: (s: unknown) => unknown) => select({ currentAccount: { publicKey: 'acct' } })
}));
jest.mock('lib/miden/name/config', () => ({ isMidenNameSupported: () => mockSupported }));
jest.mock('lib/miden/name/registrations', () => ({
  useMidenNameRegistrations: () => mockRegistrations,
  ownedLabelOf: () => mockOwned,
  phaseOf: () => (mockClaiming ? 'claiming' : 'owned'),
  uiStateOf: (phase: string) => phase
}));
jest.mock('components/ui/IconButton', () => ({
  IconButton: ({ label, onClick, ...rest }: any) => (
    <button aria-label={label} onClick={onClick} data-testid={rest['data-testid']} />
  )
}));
jest.mock('app/icons/v2', () => ({ Icon: () => null, IconName: { Add: 'add', Close: 'close' } }));

beforeEach(() => {
  localStorage.clear();
  mockNavigate.mockClear();
  mockSupported = true;
  mockRegistrations = { rows: [], loaded: true };
  mockOwned = undefined;
  mockClaiming = false;
});

describe('useMidenNameClaimOffer', () => {
  it('offers a name to an account with none, until it is dismissed', () => {
    const { result } = renderHook(() => useMidenNameClaimOffer());
    expect(result.current.canClaim).toBe(true);
    expect(result.current.dismissed).toBe(false);

    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    // Remembered across mounts.
    expect(renderHook(() => useMidenNameClaimOffer()).result.current.dismissed).toBe(true);
  });

  it.each([
    ['the network has no Miden Name', () => (mockSupported = false)],
    ['registrations are still loading', () => (mockRegistrations = { rows: [], loaded: false })],
    ['the account owns a name', () => (mockOwned = 'solo')],
    [
      'a claim is in progress',
      () => {
        mockRegistrations = { rows: [{}], loaded: true };
        mockClaiming = true;
      }
    ]
  ])('offers nothing when %s', (_case, arrange) => {
    arrange();
    expect(renderHook(() => useMidenNameClaimOffer()).result.current.canClaim).toBe(false);
  });
});

describe('MidenNameClaimSlot', () => {
  it('opens Claim a name from the card and dismisses from the X', () => {
    const onDismiss = jest.fn();
    render(<MidenNameClaimSlot onDismiss={onDismiss} />);

    expect(screen.getByTestId('miden-name-claim-slot')).toHaveTextContent('midenNameClaimSlotPlaceholder.miden');
    fireEvent.click(screen.getByTestId('miden-name-claim-slot-open'));
    expect(mockNavigate).toHaveBeenCalledWith('/miden-name');

    fireEvent.click(screen.getByTestId('miden-name-claim-slot-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });
});
