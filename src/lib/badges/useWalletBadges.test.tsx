import React from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

import { mergeBadgeAwards } from './progress';
import { BADGE_SEEN_STORAGE_KEY, BADGE_STORAGE_KEY } from './types';
import { useHasUnreadBadges, useMarkWalletBadgesViewed, useWalletBadges } from './useWalletBadges';

const mockValues = new Map<string, unknown>();
const mockListeners = new Set<() => void>();
const mockIsStored = jest.fn();
const mockTurnKeys: string[] = [];
let mockTurn = Promise.resolve();
jest.mock('lib/miden/back/safe-storage', () => ({
  isStored: (key: string) => mockIsStored(key)
}));
jest.mock('lib/miden/front/storage', () => ({
  useStorage: (key: string, fallback: unknown) => {
    const react = jest.requireActual('react');
    return [
      react.useSyncExternalStore(
        (cb: () => void) => {
          mockListeners.add(cb);
          return () => mockListeners.delete(cb);
        },
        () => mockValues.get(key) ?? fallback
      )
    ];
  },
  fetchFromStorage: async (key: string) => mockValues.get(key),
  putToStorage: async (key: string, value: unknown) => {
    mockValues.set(key, value);
    mockListeners.forEach(cb => cb());
  },
  inStorageTurn: (key: string, operation: () => Promise<void>) => {
    mockTurnKeys.push(key);
    mockTurn = mockTurn.then(operation);
    return mockTurn;
  }
}));

function Indicator() {
  return <output data-testid="unread">{String(useHasUnreadBadges())}</output>;
}
function Collection() {
  const earned = useWalletBadges();
  useMarkWalletBadgesViewed(earned);
  return <output data-testid="earned">{earned.join(',')}</output>;
}
beforeEach(() => {
  mockValues.clear();
  mockTurnKeys.length = 0;
  mockTurn = Promise.resolve();
  mockIsStored.mockReset();
  mockIsStored.mockResolvedValue(true);
});

test('legacy progress stays read across remount; a new award stays unread until the collection opens', async () => {
  mockValues.set(BADGE_STORAGE_KEY, ['first-send']);
  const first = render(<Indicator />);
  expect(screen.getByTestId('unread')).toHaveTextContent('false');
  first.unmount();
  const profile = render(<Indicator />);
  expect(screen.getByTestId('unread')).toHaveTextContent('false');
  await act(async () => mergeBadgeAwards(['first-deposit'], () => true));
  expect(screen.getByTestId('unread')).toHaveTextContent('true');
  profile.unmount();
  const reopenedProfile = render(<Indicator />);
  expect(screen.getByTestId('unread')).toHaveTextContent('true');
  const collection = render(<Collection />);
  await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('false'));
  expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual(['first-deposit', 'first-send']);
  collection.unmount();
  reopenedProfile.unmount();
  render(<Indicator />);
  expect(screen.getByTestId('unread')).toHaveTextContent('false');
  await act(async () => mergeBadgeAwards(['first-deposit'], () => true));
  expect(screen.getByTestId('unread')).toHaveTextContent('false');
});

test('awards arriving while the collection is open are acknowledged after rendering', async () => {
  mockValues.set(BADGE_STORAGE_KEY, []);
  render(
    <>
      <Indicator />
      <Collection />
    </>
  );
  await act(async () => mergeBadgeAwards(['first-deposit', 'first-send'], () => true));
  await waitFor(() => expect(screen.getByTestId('earned')).toHaveTextContent('first-deposit,first-send'));
  await waitFor(() => expect(screen.getByTestId('unread')).toHaveTextContent('false'));
  await act(async () => mergeBadgeAwards(['first-swap'], () => true));
  await waitFor(() =>
    expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual(['first-deposit', 'first-send', 'first-swap'])
  );
  expect(screen.getByTestId('unread')).toHaveTextContent('false');
});

test('coming-soon identifiers never notify', () => {
  mockValues.set(BADGE_STORAGE_KEY, ['first-receive', 'recovery-checked', 'miniapp-explorer']);
  mockValues.set(BADGE_SEEN_STORAGE_KEY, []);
  render(<Indicator />);
  expect(screen.getByTestId('unread')).toHaveTextContent('false');
});

test('a queued acknowledgement is not stored once the vault check is absent', async () => {
  let release: () => void = () => {};
  mockTurn = new Promise(resolve => {
    release = resolve;
  });
  mockValues.set(BADGE_STORAGE_KEY, ['first-send']);
  mockValues.set(BADGE_SEEN_STORAGE_KEY, []);
  render(<Collection />);
  await act(async () => {
    await Promise.resolve();
  });
  const acknowledgementQueuedBeforeReset = mockTurnKeys.includes(BADGE_STORAGE_KEY);
  mockIsStored.mockResolvedValue(false);
  mockValues.clear();
  await act(async () => {
    release();
    await mockTurn;
  });
  expect(acknowledgementQueuedBeforeReset).toBe(true);
  expect(mockValues.has(BADGE_SEEN_STORAGE_KEY)).toBe(false);
});

test('collection writes a queued acknowledgement when no reset intervenes', async () => {
  let release: () => void = () => {};
  mockTurn = new Promise(resolve => {
    release = resolve;
  });
  mockValues.set(BADGE_STORAGE_KEY, ['first-send']);
  mockValues.set(BADGE_SEEN_STORAGE_KEY, []);
  render(<Collection />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    release();
    await mockTurn;
  });
  expect(mockValues.get(BADGE_SEEN_STORAGE_KEY)).toEqual(['first-send']);
  expect(mockTurnKeys).toContain(BADGE_STORAGE_KEY);
});
