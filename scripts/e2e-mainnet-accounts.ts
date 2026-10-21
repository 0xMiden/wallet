import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Same shape as `isMainnetAccessCodeComplete` in src/lib/mainnet-access.ts. Kept here so this file does not load the SDK. */
export const INVITE_CODE_RE = /^(?:[0-9]{8}|[A-Za-z0-9]{12})$/;

export type MainnetAccountSecrets = {
  plain?: { address: string; seed: string };
  guardian?: { address: string; seed: string; keyPair: string };
};

export function defaultInviteCodesPath(): string {
  return join(homedir(), '.config', 'wallet-e2e', 'mainnet-invite-codes');
}

export function defaultAccountSecretsPath(): string {
  return join(homedir(), '.config', 'wallet-e2e', 'mainnet-accounts.json');
}

/** First line is the public account's code, second is the Guardian account's. The error never includes a code. */
export function readInviteCodes(text: string): { plain: string; guardian: string } {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length !== 2) throw new Error(`expected 2 invite codes, found ${lines.length}`);
  if (!INVITE_CODE_RE.test(lines[0]) || !INVITE_CODE_RE.test(lines[1])) {
    throw new Error('an invite code has the wrong shape');
  }
  return { plain: lines[0], guardian: lines[1] };
}

/** Mode 0600. Refuses a payload that still carries invitation material. */
export function writeAccountSecrets(filePath: string, secrets: MainnetAccountSecrets): void {
  const dumped = JSON.stringify(secrets);
  if (/invite|accessCode|invitation/i.test(dumped)) {
    throw new Error('refusing to write invite material into the account file');
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
  chmodSync(filePath, 0o600);
}

function main(): void {
  const file = process.env.E2E_MAINNET_INVITE_CODES ?? defaultInviteCodesPath();
  readInviteCodes(readFileSync(file, 'utf8'));
  process.stdout.write('2 invite codes ready\n');
  process.stdout.write(
    'Register them with E2E_NETWORK=mainnet E2E_MAINNET_BOOTSTRAP=1 yarn test:e2e:mainnet:run after the mainnet extension build.\n'
  );
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('e2e-mainnet-accounts.ts') || entry.endsWith('e2e-mainnet-accounts.js')) main();
