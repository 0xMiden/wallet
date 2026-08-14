import fs from 'fs';
import path from 'path';

// The review screen's recall (expiration) copy must describe what the wallet
// actually does with an unclaimed send after its recall height passes.
//
// It used to read "the $amount$ returns to your wallet automatically". Nothing
// automatic happens for a non-native token: background auto-consume is gated on
// the native faucet id (`sync-manager.ts`), so a reclaimed TST/USDC note sits in
// the pending list until the user claims it — which is exactly what
// `playwright/e2e/tests/recall-reclaim.spec.ts` has to do (`claimAllNotes`) to
// get the money back. Promising an automatic return on the screen where a user
// decides whether a payment is recoverable is the worst place to be wrong.
//
// These guards pin the corrected claim so it cannot drift back.

const EN_DIR = path.join(__dirname, '../../../public/_locales/en');
type Entry = { message: string };
const messages: Record<string, Entry> = JSON.parse(fs.readFileSync(path.join(EN_DIR, 'messages.json'), 'utf8'));
const enJson: Record<string, string> = JSON.parse(fs.readFileSync(path.join(EN_DIR, 'en.json'), 'utf8'));

const msg = (key: string): string => {
  const entry = messages[key];
  if (!entry) throw new Error(`en/messages.json is missing key: ${key}`);
  return entry.message;
};

describe('recall/expiration copy accuracy', () => {
  it('does not promise the unclaimed amount comes back on its own', () => {
    const note = msg('recallReturnsNote');
    // Only the native asset auto-consumes; every other token needs a claim.
    expect(note).not.toMatch(/automatic/i);
    expect(note).not.toMatch(/by itself|on its own/i);
  });

  it('tells the sender they can claim it back, and names the amount', () => {
    const note = msg('recallReturnsNote');
    expect(note).toMatch(/claim/i);
    // The placeholder is what makes the sentence concrete ("the 250 TST");
    // losing it turns the copy into a generic reassurance.
    expect(note).toContain('$amount$');
  });

  it('keeps en/messages.json and en/en.json in sync for the edited key', () => {
    expect(enJson['recallReturnsNote']).toBe(msg('recallReturnsNote'));
  });
});
