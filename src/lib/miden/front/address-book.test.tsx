/* eslint-disable import/first */

import { act, renderHook } from '@testing-library/react';

const mockUpdateSettings = jest.fn();

jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ updateSettings: mockUpdateSettings })
}));

const mockUseFilteredContacts = jest.fn();
jest.mock('./use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => mockUseFilteredContacts()
}));

jest.mock('lib/i18n', () => ({
  getMessage: (key: string) => key
}));

import { useContacts } from './address-book';

beforeEach(() => {
  mockUpdateSettings.mockReset();
  mockUseFilteredContacts.mockReset();
});

describe('useContacts', () => {
  it('addContact appends a new contact when the address is unique', async () => {
    mockUseFilteredContacts.mockReturnValue({
      contacts: [{ name: 'Alice', address: 'addr-a' }],
      allContacts: [{ name: 'Alice', address: 'addr-a' }]
    });
    const { result } = renderHook(() => useContacts());
    await act(async () => {
      await result.current.addContact({ name: 'Bob', address: 'addr-b' } as any);
    });
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      contacts: [
        { name: 'Bob', address: 'addr-b' },
        { name: 'Alice', address: 'addr-a' }
      ]
    });
  });

  it('addContact rejects when the address already exists', async () => {
    mockUseFilteredContacts.mockReturnValue({
      contacts: [{ name: 'Alice', address: 'addr-a' }],
      allContacts: [{ name: 'Alice', address: 'addr-a' }]
    });
    const { result } = renderHook(() => useContacts());
    await expect(result.current.addContact({ name: 'Alice2', address: 'addr-a' } as any)).rejects.toThrow();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('removeContact filters by address', async () => {
    mockUseFilteredContacts.mockReturnValue({
      contacts: [
        { name: 'A', address: 'a' },
        { name: 'B', address: 'b' }
      ],
      allContacts: [
        { name: 'A', address: 'a' },
        { name: 'B', address: 'b' }
      ]
    });
    const { result } = renderHook(() => useContacts());
    await act(async () => {
      await result.current.removeContact('a');
    });
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      contacts: [{ name: 'B', address: 'b' }]
    });
  });

  it('getContact returns the matching contact or null', () => {
    mockUseFilteredContacts.mockReturnValue({
      contacts: [],
      allContacts: [{ name: 'A', address: 'a' }]
    });
    const { result } = renderHook(() => useContacts());
    expect(result.current.getContact('a')).toEqual({ name: 'A', address: 'a' });
    expect(result.current.getContact('missing')).toBeNull();
  });
});
