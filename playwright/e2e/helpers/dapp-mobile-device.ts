import { execFile } from 'node:child_process';

import { HarnessFault } from './dapp-cells';
import type { PromptSettlement } from '../ios/helpers/system-alerts';

/** What a mobile leg's platform adds around the journey. */
export type MobileSurface = 'ios' | 'android';
export interface MobileDevice {
  readonly surface: MobileSurface;
  /** Makes `<host>:<port>` on every device the harness's listener for both page origins, and says how. */
  forwardPagePort(port: number): Promise<string>;
  /** Runs once both wallets exist: answers what the platform raises outside the webview. */
  afterCreate(): Promise<void>;
}

export type AdbRun = (serial: string, args: readonly string[]) => Promise<string>;
const adb: AdbRun = (serial, args) =>
  new Promise((resolve, reject) => {
    execFile('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });

/** `adb reverse --list`'s rules. With none it prints a bare newline, which a line count reads as one rule. */
export function parseReverseList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

/**
 * One reverse rule before a page opens keeps both phase-1 origins on the host (spike plan change 10). Never the host
 * alias 10.0.2.2: its origin would change the dApp's name, its sessions and its secure-context status (spec 3.2).
 */
export async function reversePagePort(serial: string, port: number, run: AdbRun = adb): Promise<string> {
  await run(serial, ['reverse', '--remove-all']);
  await run(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]);
  const rules = parseReverseList(await run(serial, ['reverse', '--list']));
  const rule = rules.find(line => line.endsWith(`tcp:${port} tcp:${port}`));
  if (rule === undefined) {
    throw new HarnessFault(`adb reverse lists no tcp:${port} rule on ${serial}: ${JSON.stringify(rules)}`);
  }
  return rule;
}

export function androidDevice(serials: readonly string[], run: AdbRun = adb): MobileDevice {
  return {
    surface: 'android',
    forwardPagePort: async port => {
      const rules: string[] = [];
      // One emulator at a time: parallel adb calls against two emulators race on the shared adb server.
      for (const serial of serials) rules.push(`${serial}: ${await reversePagePort(serial, port, run)}`);
      return rules.join('; ');
    },
    afterCreate: async () => undefined
  };
}

/** The simulators share the host's loopback, so nothing is forwarded; each wallet's notification prompt is answered. */
export function iosDevice(
  wallets: ReadonlyArray<{ settleNotificationPrompt(): Promise<PromptSettlement> }>
): MobileDevice {
  return {
    surface: 'ios',
    forwardPagePort: async port => `shared loopback on ${port}`,
    afterCreate: async () => {
      for (const [index, wallet] of wallets.entries()) {
        const prompt = await wallet.settleNotificationPrompt();
        if (!prompt.answered) {
          throw new Error(
            `wallet ${index === 0 ? 'A' : 'B'}: the notification permission prompt was not settled (${prompt.reason}): ${prompt.detail}`
          );
        }
      }
    }
  };
}
