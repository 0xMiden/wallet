import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { useWeeklyClaim } from 'lib/arcade/use-weekly-claim';
import type { WeeklyClaimService } from 'lib/arcade/weekly-claim';

import { ArcadeAllowance } from './ArcadeAllowance';

const mockService: WeeklyClaimService = { read: jest.fn(), prepare: jest.fn(), submit: jest.fn() };
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({
    readGcWeeklyClaim: mockService.read,
    prepareGcWeeklyClaim: mockService.prepare,
    submitGcWeeklyClaim: mockService.submit
  })
}));
jest.mock('./GcClaimReviewDrawer', () => ({ GcClaimReviewDrawer: () => null }));

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

it('uses the effective chain network, isolates account changes, and uses only the backend adapter', () => {
  const view = render(<ArcadeAllowance />);
  expect(screen.getByText('Partner Mainnet')).toBeInTheDocument();
  expect(useWeeklyClaim).toHaveBeenLastCalledWith({ accountId: 'account-a', networkId: 'mainnet' }, mockService);
  act(() => {
    mockNetwork = 'testnet';
    mockListener();
  });
  expect(screen.getByText('Testnet')).toBeInTheDocument();
  expect(useWeeklyClaim).toHaveBeenLastCalledWith({ accountId: 'account-a', networkId: 'testnet' }, mockService);
  mockAccount = 'account-b';
  view.rerender(<ArcadeAllowance />);
  expect(useWeeklyClaim).toHaveBeenLastCalledWith({ accountId: 'account-b', networkId: 'testnet' }, mockService);
});
