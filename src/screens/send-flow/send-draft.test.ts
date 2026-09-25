import { type SendDraft, setSendDraft, consumeSendDraft, clearSendDraft } from './send-draft';

const makeDraft = (over: Partial<SendDraft> = {}): SendDraft => ({
  amount: '12.5',
  recipientAddress: '0xrecipient',
  tokenId: 'token-abc',
  ...over
});

describe('send-draft', () => {
  // The module holds a singleton, module-scoped `draft`. Reset it before every
  // test so cases don't leak state into one another.
  beforeEach(() => {
    clearSendDraft();
  });

  describe('initial / empty state', () => {
    it('consumeSendDraft returns null when there is no draft', () => {
      expect(consumeSendDraft()).toBeNull();
    });

    it('clearSendDraft is a no-op when already empty', () => {
      expect(() => clearSendDraft()).not.toThrow();
      expect(consumeSendDraft()).toBeNull();
    });
  });

  describe('setSendDraft', () => {
    it('stores a draft for the next consume', () => {
      setSendDraft(makeDraft());
      expect(consumeSendDraft()).toEqual(makeDraft());
    });

    it('returns undefined (void)', () => {
      expect(setSendDraft(makeDraft())).toBeUndefined();
    });

    it('overwrites a previously set draft with the latest value', () => {
      setSendDraft(makeDraft({ amount: '1' }));
      setSendDraft(makeDraft({ amount: '2' }));
      expect(consumeSendDraft()).toEqual(makeDraft({ amount: '2' }));
    });

    it('stores the exact object reference passed in', () => {
      const draft = makeDraft();
      setSendDraft(draft);
      // Same reference is handed back, not a copy.
      expect(consumeSendDraft()).toBe(draft);
    });

    it('preserves empty-string field values verbatim', () => {
      const empty: SendDraft = { amount: '', recipientAddress: '', tokenId: '' };
      setSendDraft(empty);
      expect(consumeSendDraft()).toEqual(empty);
    });
  });

  describe('consumeSendDraft (one-shot read)', () => {
    it('returns the stored draft the first time', () => {
      const draft = makeDraft();
      setSendDraft(draft);
      expect(consumeSendDraft()).toEqual(draft);
    });

    it('clears the draft so a second consume returns null', () => {
      setSendDraft(makeDraft());
      expect(consumeSendDraft()).not.toBeNull();
      expect(consumeSendDraft()).toBeNull();
    });
  });

  describe('clearSendDraft', () => {
    it('removes an existing draft', () => {
      setSendDraft(makeDraft());
      clearSendDraft();
      expect(consumeSendDraft()).toBeNull();
    });

    it('is idempotent', () => {
      setSendDraft(makeDraft());
      clearSendDraft();
      clearSendDraft();
      expect(consumeSendDraft()).toBeNull();
    });

    it('returns undefined (void)', () => {
      setSendDraft(makeDraft());
      expect(clearSendDraft()).toBeUndefined();
    });
  });

  describe('full handoff lifecycle', () => {
    it('supports set → consume → cleared, then re-set', () => {
      const first = makeDraft({ amount: '10' });
      setSendDraft(first);
      expect(consumeSendDraft()).toEqual(first);
      expect(consumeSendDraft()).toBeNull();

      const second = makeDraft({ amount: '20', tokenId: 'other' });
      setSendDraft(second);
      expect(consumeSendDraft()).toEqual(second);
      expect(consumeSendDraft()).toBeNull();
    });
  });
});
