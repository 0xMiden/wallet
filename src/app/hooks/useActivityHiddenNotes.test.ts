import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { useActivityHiddenNotes } from './useActivityHiddenNotes';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn(), putToStorage: jest.fn() }));
const read = jest.mocked(fetchFromStorage);
const write = jest.mocked(putToStorage);

beforeEach(() => {
  jest.clearAllMocks();
  read.mockResolvedValue(['old']);
  write.mockResolvedValue(undefined);
});

it('loads account-specific hidden notes, persists a rejection, and restores them', async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledWith('activity-hidden-notes:account');
  await act(async () => {
    await result.current.hide('new');
  });
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', ['old', 'new']);
  await act(async () => {
    await result.current.restore();
  });
  expect(result.current.ids.size).toBe(0);
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', []);
});

it('restores the previous notes if storage fails', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  write.mockRejectedValueOnce(new Error('Storage unavailable'));
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => {
    await result.current.hide('new');
  });
  expect([...result.current.ids]).toEqual(['old']);
  expect(result.current.failed).toBe(true);
  log.mockRestore();
});
