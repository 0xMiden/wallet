import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { useWeeklyClaim } from 'lib/arcade/use-weekly-claim';
import { unavailableWeeklyClaimService } from 'lib/arcade/weekly-claim';

import { ArcadeAllowance } from './ArcadeAllowance';

let mockAccount = 'account-a';
let mockNetwork = 'mainnet';
let mockListener = () => {};
jest.mock('lib/miden/front/ready', () => ({
  useAccount: () => ({ publicKey: mockAccount }),
  useAllNetworks: () => [
    { id: 'mainnet', name: 'Partner Mainnet' },
    { id: 'testnet', name: 'Testnet' }
  ]
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));
jest.mock('lib/remote-config/runtime', () => ({
  subscribeBridgeConfig: (listener: () => void) => {
    mockListener = listener;
    return () => {};
  }
}));
jest.mock('lib/arcade/use-weekly-claim', () => ({
  useWeeklyClaim: jest.fn(() => ({
    snapshot: { status: { kind: 'unavailable' }, balance: null },
    busy: false,
    claim: jest.fn(),
    refresh: jest.fn()
  }))
}));
jest.mock('./ArcadeAllowanceCard', () => ({
  ArcadeAllowanceCard: ({ networkName }: { networkName: string }) => <div>{networkName}</div>
}));

it('uses the effective chain network, isolates account changes, and keeps the production adapter unavailable', () => {
  const view = render(<ArcadeAllowance />);
  expect(screen.getByText('Partner Mainnet')).toBeInTheDocument();
  expect(useWeeklyClaim).toHaveBeenLastCalledWith(
    { accountId: 'account-a', networkId: 'mainnet' },
    unavailableWeeklyClaimService
  );
  act(() => {
    mockNetwork = 'testnet';
    mockListener();
  });
  expect(screen.getByText('Testnet')).toBeInTheDocument();
  expect(useWeeklyClaim).toHaveBeenLastCalledWith(
    { accountId: 'account-a', networkId: 'testnet' },
    unavailableWeeklyClaimService
  );
  mockAccount = 'account-b';
  view.rerender(<ArcadeAllowance />);
  expect(useWeeklyClaim).toHaveBeenLastCalledWith(
    { accountId: 'account-b', networkId: 'testnet' },
    unavailableWeeklyClaimService
  );
});
