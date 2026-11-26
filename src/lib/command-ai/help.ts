import { validateMnemonic } from '@miden/hd-key';

import { PRIVACY_POLICY_URL, SUPPORT_URL } from 'app/constants';

import type { CommandHelpTopic } from './schema';

const protocol = 'https://0xmiden.github.io/protocol/';

export const COMMAND_HELP_TOPICS = {
  Miden: { source: protocol },
  Privacy: { source: PRIVACY_POLICY_URL, next: 'Verify' },
  Verify: { source: PRIVACY_POLICY_URL },
  Bridge: { source: `${PRIVACY_POLICY_URL}#swaps-and-bridges`, next: 'Pending' },
  Notes: { source: `${protocol}note.html`, next: 'Accept' },
  Accept: { source: SUPPORT_URL },
  Pending: { source: SUPPORT_URL },
  Decline: { source: SUPPORT_URL },
  Fees: { source: SUPPORT_URL },
  Recovery: { source: SUPPORT_URL },
  Network: { source: SUPPORT_URL },
  Assistant: { source: PRIVACY_POLICY_URL },
  Safety: { source: SUPPORT_URL },
  Wallet: { source: SUPPORT_URL }
} as const satisfies Record<CommandHelpTopic, { source: string; next?: CommandHelpTopic }>;

export function containsCommandSecret(input: string): boolean {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|private key|recovery phrase|seed phrase)\s*[:=]\s*\S|^\s*(?:my\s+)?(?:password|private key|recovery phrase|seed phrase)\s+is\s+\S/im.test(
      input
    )
  ) {
    return true;
  }
  const words = input.trim().replace(/\s+/g, ' ').split(' ');
  return [12, 15, 18, 21, 24].includes(words.length) && validateMnemonic(words.join(' '));
}
