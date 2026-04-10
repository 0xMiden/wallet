/* eslint-disable import/first */

import React from 'react';

import { renderHook } from '@testing-library/react';

const mockUpdateSettings = jest.fn();
const mockUseSettings = jest.fn();
const mockUseAllAccounts = jest.fn();

jest.mock('./client', () => ({
  useMidenContext: () => ({ updateSettings: mockUpdateSettings })
}));

jest.mock('./ready', () => ({
  useSettings: () => mockUseSettings(),
  useAllAccounts: () => mockUseAllAccounts()
}));

import { useFilteredContacts } from './use-filtered-contacts.hook';

beforeEach(() => {
  mockUpdateSettings.mockReset();
  mockUseSettings.mockReset();
  mockUseAllAccounts.mockReset();
});

describe('useFilteredContacts', () => {
  it('returns the saved contacts and merges in account-derived contacts', () => {
    mockUseSettings.mockReturnValue({
      contacts: [{ name: 'Alice', address: 'addr-a' }]
    });
    mockUseAllAccounts.mockReturnValue([
      { publicKey: 'acc-1', name: 'Account 1', isPublic: true }
    ]);
    const { result } = renderHook(() => useFilteredContacts());
    expect(result.current.contacts).toEqual([{ name: 'Alice', address: 'addr-a' }]);
    expect(result.current.allContacts.some(c => c.address === 'addr-a')).toBe(true);
    expect(result.current.allContacts.some(c => c.address === 'acc-1')).toBe(true);
  });

  it('handles missing contacts list (defaults to empty array)', () => {
    mockUseSettings.mockReturnValue({});
    mockUseAllAccounts.mockReturnValue([]);
    const { result } = renderHook(() => useFilteredContacts());
    expect(result.current.contacts).toEqual([]);
    expect(result.current.allContacts).toEqual([]);
  });

  it('strips contact addresses that collide with account addresses', () => {
    mockUseSettings.mockReturnValue({
      contacts: [
        { name: 'Alice', address: 'addr-a' },
        { name: 'Self', address: 'acc-1' }
      ]
    });
    mockUseAllAccounts.mockReturnValue([
      { publicKey: 'acc-1', name: 'Account 1', isPublic: true }
    ]);
    const { result } = renderHook(() => useFilteredContacts());
    // Self should be stripped from allContacts because it collides with acc-1
    const selfMatches = result.current.allContacts.filter(c => c.address === 'acc-1');
    expect(selfMatches.length).toBe(1);
    expect(selfMatches[0]!.accountInWallet).toBe(true);
    // updateSettings should have been called with the filtered contacts
    expect(mockUpdateSettings).toHaveBeenCalled();
  });
});
