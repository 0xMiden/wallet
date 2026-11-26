import { validateMnemonic } from '@miden/hd-key';
import { PRIVACY_POLICY_URL, SUPPORT_URL } from 'app/constants';
import { parsePrivateKeyPair } from 'lib/miden/guardian/private-key-pair';

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
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|private key|recovery phrase|seed phrase)\s*[:=]\s*\S/i.test(input)
  ) {
    return true;
  }
  const labelledValue = /(?:^\s*|\bmy\s+)(?:password|private key|recovery phrase|seed phrase)\s+is\s+(?=\S)/gim;
  const troubleshooting =
    /^(?:missing|lost|gone|forgotten|stolen|compromised|leaked|exposed|wrong|incorrect|safe|not[ \t]+(?:working|accepted))(?=[ \t]*(?:[.,?!;]+(?=\s|$)|\r?\n|$))/i;
  for (const match of input.matchAll(labelledValue)) {
    const valueStart = (match.index ?? 0) + match[0].length;
    if (!troubleshooting.test(input.slice(valueStart))) return true;
  }

  const scalar = /^(?:0x)?[0-9a-f]{64}$/i.exec(input.trim())?.[0];
  if (scalar && parsePrivateKeyPair(`${scalar}:${scalar}`)) return true;
  for (const [pair] of input.matchAll(/\b(?:0x)?[0-9a-f]{64}\s*:\s*(?:0x)?[0-9a-f]{64}\b/gi)) {
    if (parsePrivateKeyPair(pair)) return true;
  }
  for (const [, hex] of input.matchAll(/\b(?:0x)?([0-9a-f]{66,4096})\b/gi)) {
    if (hex !== undefined && hex.length % 2 === 0) return true;
  }

  const words = input.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const length of [12, 15, 18, 21, 24]) {
    for (let start = 0; start + length <= words.length; start += 1) {
      if (validateMnemonic(words.slice(start, start + length).join(' '))) return true;
    }
  }
  return false;
}
