import fs from 'fs';
import path from 'path';

// #478 — the auto-consume and delegate-proof settings copy must explain the
// controls in plain language and stay accurate to the wallet's behaviour:
//   - auto-consume just automates the Claim action and does NOT charge fees
//     (the reported misconception was that it "absorbs transaction fees");
//   - delegated proving runs on remote servers (fast) while local proving runs
//     on-device (private/slower), and the wallet falls back to local when the
//     service is unavailable.
// These guards pin those invariants so the explanatory copy can't silently drift
// back to a bare/misleading label.

const EN_DIR = path.join(__dirname, '../../../public/_locales/en');
type Entry = { message: string };
const messages: Record<string, Entry> = JSON.parse(fs.readFileSync(path.join(EN_DIR, 'messages.json'), 'utf8'));
const enJson: Record<string, string> = JSON.parse(fs.readFileSync(path.join(EN_DIR, 'en.json'), 'utf8'));

const msg = (key: string): string => {
  const entry = messages[key];
  if (!entry) throw new Error(`en/messages.json is missing key: ${key}`);
  return entry.message;
};

describe('auto-consume + proving settings copy accuracy (#478)', () => {
  it('explains delegated vs local proving and the fallback', () => {
    const desc = msg('delegateProofSettingsDescription');
    expect(desc).toMatch(/remote|server/i); // delegated = remote servers
    expect(desc).toMatch(/local/i); // vs local proving
    expect(desc).toMatch(/unavailable|fall|down|instead/i); // the fallback to local
  });

  it('auto-consume copy explains it claims notes and does not charge fees', () => {
    const desc = msg('autoConsumeSettingsDescription');
    expect(desc).toMatch(/claim/i); // explains what consuming does
    expect(desc).toMatch(/fee/i); // addresses the "absorbs fees" misconception
  });

  it('keeps en/messages.json and en/en.json in sync for the edited keys', () => {
    for (const key of ['delegateProofSettingsDescription', 'autoConsumeSettingsDescription']) {
      expect(enJson[key]).toBe(msg(key));
    }
  });
});
