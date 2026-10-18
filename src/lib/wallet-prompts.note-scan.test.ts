import i18next from 'i18next';

import type { GuardianNoteRecoveryProgress, GuardianNoteRecoveryStep } from 'lib/guardian-note-recovery-progress';

import { guardianNoteScanText } from './wallet-prompts';

describe('guardianNoteScanText', () => {
  // With no resources loaded, `t` answers with the key.
  beforeAll(async () => {
    await i18next.init({ lng: 'en', resources: {} });
  });
  const t = i18next.t;
  const progress = (
    step: GuardianNoteRecoveryStep,
    extra: Partial<GuardianNoteRecoveryProgress> = {}
  ): GuardianNoteRecoveryProgress => ({ accountId: 'account-1', step, ...extra });

  it('says which step of the notes pass runs', () => {
    expect(guardianNoteScanText(progress('transport'), t)).toBe('guardianNoteRecoveryTransportStep');
    expect(guardianNoteScanText(progress('proposals'), t)).toBe('guardianNoteRecoveryProposalsStep');
    expect(guardianNoteScanText(progress('public'), t)).toBe('guardianNoteRecoveryPublicPreparingStep');
    expect(guardianNoteScanText(progress('public', { syncedToBlock: 10, latestBlock: 20 }), t)).toBe(
      'guardianNoteRecoveryPublicStep'
    );
  });

  it('is null outside the notes pass', () => {
    expect(guardianNoteScanText(null, t)).toBeNull();
    expect(guardianNoteScanText(progress('history'), t)).toBeNull();
    expect(guardianNoteScanText(progress('history-partial'), t)).toBeNull();
    expect(guardianNoteScanText(progress('history-failed'), t)).toBeNull();
  });
});
