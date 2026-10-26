/**
 * @jest-environment node
 */
import { HarnessFault } from './dapp-cells';
import { androidDevice, iosDevice, parseReverseList, reversePagePort, type AdbRun } from './dapp-mobile-device';

function adbAnswering(list: string): { run: AdbRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: AdbRun = async (serial, args) => {
    calls.push([serial, ...args]);
    return args[1] === '--list' ? list : '';
  };
  return { run, calls };
}

describe('adb reverse for the page port', () => {
  it("reads adb's bare newline as no rules", () => {
    expect(parseReverseList('\n')).toEqual([]);
  });

  it('clears the rules, adds the page port and finds it in the list', async () => {
    const { run, calls } = adbAnswering('host-19 tcp:4810 tcp:4810\n');
    await expect(reversePagePort('emulator-5554', 4810, run)).resolves.toBe('host-19 tcp:4810 tcp:4810');
    expect(calls).toEqual([
      ['emulator-5554', 'reverse', '--remove-all'],
      ['emulator-5554', 'reverse', 'tcp:4810', 'tcp:4810'],
      ['emulator-5554', 'reverse', '--list']
    ]);
  });

  it('fails as a harness fault when the rule is not listed', async () => {
    const { run } = adbAnswering('\n');
    await expect(reversePagePort('emulator-5556', 4810, run)).rejects.toBeInstanceOf(HarnessFault);
  });

  it('forwards each emulator in turn', async () => {
    const { run, calls } = adbAnswering('host-19 tcp:4810 tcp:4810\n');
    await expect(androidDevice(['emulator-5554', 'emulator-5556'], run).forwardPagePort(4810)).resolves.toBe(
      'emulator-5554: host-19 tcp:4810 tcp:4810; emulator-5556: host-19 tcp:4810 tcp:4810'
    );
    expect(calls.map(call => call[0])).toEqual([
      'emulator-5554',
      'emulator-5554',
      'emulator-5554',
      'emulator-5556',
      'emulator-5556',
      'emulator-5556'
    ]);
  });
});

describe('the iOS device', () => {
  it('answers each wallet notification prompt, and names the wallet whose prompt stayed', async () => {
    const answered = { settleNotificationPrompt: jest.fn(async () => ({ answered: true as const })) };
    const stuck = {
      settleNotificationPrompt: jest.fn(async () => ({
        answered: false as const,
        reason: 'idb-unavailable' as const,
        detail: 'no companion'
      }))
    };
    await expect(iosDevice([answered, answered]).afterCreate()).resolves.toBeUndefined();
    await expect(iosDevice([answered, stuck]).afterCreate()).rejects.toThrow(
      'wallet B: the notification permission prompt was not settled (idb-unavailable): no companion'
    );
  });
});
