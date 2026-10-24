/* eslint-disable import/first */
const mockPrepare = jest.fn();
const mockMobile = { value: true };
jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: { prepareMorph: (...args: unknown[]) => mockPrepare(...args) }
}));
jest.mock('lib/platform', () => ({ isMobile: () => mockMobile.value }));

import { MORPH_PREPARE_MS, prepareMorph } from './morph-boost';

beforeEach(() => {
  mockPrepare.mockReset();
  mockPrepare.mockResolvedValue(undefined);
  mockMobile.value = true;
});

it('asks native for the full frame rate for a window that a morph takes over', async () => {
  await prepareMorph();

  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(mockPrepare).toHaveBeenCalledWith({ durationMs: MORPH_PREPARE_MS });
  expect(MORPH_PREPARE_MS).toBeGreaterThanOrEqual(300);
  expect(MORPH_PREPARE_MS).toBeLessThanOrEqual(1000);
});

it('names the window to warm, when a control restores a particular dApp', async () => {
  await prepareMorph('dapp-7');

  expect(mockPrepare).toHaveBeenCalledWith({ durationMs: MORPH_PREPARE_MS, id: 'dapp-7' });
});

it('sends nothing off mobile', async () => {
  mockMobile.value = false;

  await prepareMorph();

  expect(mockPrepare).not.toHaveBeenCalled();
});

it('resolves when the plugin has no such method', async () => {
  mockPrepare.mockRejectedValue(new Error('UNIMPLEMENTED'));

  await expect(prepareMorph()).resolves.toBeUndefined();
  expect(mockPrepare).toHaveBeenCalledTimes(1);
});
