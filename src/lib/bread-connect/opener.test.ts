/* eslint-disable import/first */
const mockOpenCallback = jest.fn();
jest.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    openCallback: (options: { url: string }) => mockOpenCallback(options)
  })
}));

import { openCallback } from './opener';

const LINK = 'https://game.example/bread#v=1&m=e30';

beforeEach(() => mockOpenCallback.mockReset());

it('opens the callback through the native opener and reports whether an app took it', async () => {
  mockOpenCallback.mockResolvedValueOnce({ opened: true }).mockResolvedValueOnce({ opened: false });

  expect(await openCallback(LINK)).toBe(true);
  expect(await openCallback(LINK)).toBe(false);
  expect(mockOpenCallback).toHaveBeenCalledWith({ url: LINK });
});

it('reports a native failure as not opened', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockOpenCallback.mockRejectedValueOnce(new Error('not implemented on web'));

    expect(await openCallback(LINK)).toBe(false);
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
