/** @jest-environment node */
import type { GuardianAwareWalletPage } from '../playwright/e2e/fixtures/two-wallets';
import { restoreMainnetLoopGuardian } from '../playwright/e2e/helpers/mainnet-loop-wallet';
import { setAutoConsume } from '../playwright/e2e/helpers/test-dapp';
import { blockMainnetConsumeAuthorization } from '../playwright/e2e/helpers/mainnet-consume-authorization';

jest.mock('../playwright/e2e/helpers/test-dapp', () => ({ setAutoConsume: jest.fn() }));
jest.mock('../playwright/e2e/helpers/mainnet-consume-authorization', () => ({ blockMainnetConsumeAuthorization: jest.fn() }));
const events: string[] = [];
const recover = jest.fn();
const sync = jest.fn();
const wallet = { recoverGuardianFromHotKey: recover, triggerSync: sync };
beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  jest.mocked(blockMainnetConsumeAuthorization).mockReset().mockImplementation(async () => { events.push('block-sdk-claim'); });
  jest.mocked(setAutoConsume).mockImplementation(async () => {
    events.push('disable-native-auto-claim');
  });
  recover.mockImplementation(async () => {
    events.push('restore-existing-actor');
  });
  sync.mockImplementation(async () => {
    events.push('sync');
  });
});
const restore = (key = ' existing-test-pair ') => restoreMainnetLoopGuardian(wallet as GuardianAwareWalletPage, key);
it('disables and awaits native auto-claim mirrors BEFORE restoring and syncing the existing funded actor', async () => {
  await restore();
  expect(setAutoConsume).toHaveBeenCalledWith(wallet, false);
  expect(recover).toHaveBeenCalledWith('existing-test-pair');
  expect(sync).toHaveBeenCalledWith(true);
  expect(events).toEqual(['block-sdk-claim', 'disable-native-auto-claim', 'restore-existing-actor', 'block-sdk-claim', 'sync']);
});
it('does not restore or sync when the deny-all SDK barrier cannot be installed', async () => {
  jest.mocked(blockMainnetConsumeAuthorization).mockRejectedValue(new Error('SDK barrier unavailable'));
  await expect(restore()).rejects.toThrow('SDK barrier unavailable');
  expect(recover).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
});
it('does not synchronize when restoration cleared a barrier that cannot be reinstated', async () => {
  jest.mocked(blockMainnetConsumeAuthorization).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('SDK barrier reset'));
  await expect(restore()).rejects.toThrow('SDK barrier reset');
  expect(recover).toHaveBeenCalledTimes(1);
  expect(sync).not.toHaveBeenCalled();
});
it('does not expose the funded actor if disabling native auto-claim fails', async () => {
  jest.mocked(setAutoConsume).mockRejectedValue(new Error('mirror unavailable'));
  await expect(restore()).rejects.toThrow('mirror unavailable');
  expect(recover).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
});
it('does not synchronize a failed recovery', async () => {
  recover.mockRejectedValue(new Error('recovery failed'));
  await expect(restore()).rejects.toThrow('recovery failed');
  expect(sync).not.toHaveBeenCalled();
});
it('refuses a missing key without logging it or touching wallet state', async () => {
  await expect(restore(' ')).rejects.toThrow(/key|pair/i);
  expect(setAutoConsume).not.toHaveBeenCalled();
  expect(blockMainnetConsumeAuthorization).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});
it('propagates sync failure instead of treating the actor as ready', async () => {
  sync.mockRejectedValue(new Error('sync unavailable'));
  await expect(restore()).rejects.toThrow('sync unavailable');
});
