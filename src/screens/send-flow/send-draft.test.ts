import {
  type SendDraft,
  setSendDraft,
  consumeSendDraft,
  hasSendDraft,
  clearSendDraft
} from './send-draft';

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
    it('hasSendDraft is false when no draft has been set', () => {
      expect(hasSendDraft()).toBe(false);
    });

    it('consumeSendDraft returns null when there is no draft', () => {
      expect(consumeSendDraft()).toBeNull();
    });

    it('clearSendDraft is a no-op when already empty', () => {
      expect(() => clearSendDraft()).not.toThrow();
      expect(hasSendDraft()).toBe(false);
      expect(consumeSendDraft()).toBeNull();
    });
  });

  describe('setSendDraft', () => {
    it('stores a draft so hasSendDraft becomes true', () => {
      expect(hasSendDraft()).toBe(false);
      setSendDraft(makeDraft());
      expect(hasSendDraft()).toBe(true);
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
      expect(hasSendDraft()).toBe(true);
      expect(consumeSendDraft()).toEqual(empty);
    });
  });

  describe('hasSendDraft', () => {
    it('reflects presence/absence across a full set → consume cycle', () => {
      expect(hasSendDraft()).toBe(false);
      setSendDraft(makeDraft());
      expect(hasSendDraft()).toBe(true);
      consumeSendDraft();
      expect(hasSendDraft()).toBe(false);
    });

    it('becomes false after clearSendDraft', () => {
      setSendDraft(makeDraft());
      expect(hasSendDraft()).toBe(true);
      clearSendDraft();
      expect(hasSendDraft()).toBe(false);
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
      expect(hasSendDraft()).toBe(false);
    });

    it('does not report a draft after consuming', () => {
      setSendDraft(makeDraft());
      consumeSendDraft();
      expect(hasSendDraft()).toBe(false);
    });
  });

  describe('clearSendDraft', () => {
    it('removes an existing draft', () => {
      setSendDraft(makeDraft());
      clearSendDraft();
      expect(hasSendDraft()).toBe(false);
      expect(consumeSendDraft()).toBeNull();
    });

    it('is idempotent', () => {
      setSendDraft(makeDraft());
      clearSendDraft();
      clearSendDraft();
      expect(hasSendDraft()).toBe(false);
    });

    it('returns undefined (void)', () => {
      setSendDraft(makeDraft());
      expect(clearSendDraft()).toBeUndefined();
    });
  });

  describe('full handoff lifecycle', () => {
    it('supports set → has → consume → cleared, then re-set', () => {
      const first = makeDraft({ amount: '10' });
      setSendDraft(first);
      expect(hasSendDraft()).toBe(true);
      expect(consumeSendDraft()).toEqual(first);
      expect(hasSendDraft()).toBe(false);

      const second = makeDraft({ amount: '20', tokenId: 'other' });
      setSendDraft(second);
      expect(hasSendDraft()).toBe(true);
      expect(consumeSendDraft()).toEqual(second);
      expect(hasSendDraft()).toBe(false);
    });
  });
});
