import type { DeltaObject, HistoryEntry } from '@openzeppelin/guardian-client';

import {
  CLAIM_STARTED_ELSEWHERE_WINDOW_MS,
  ClaimStartedElsewhereError,
  claimNoteKeys,
  isClaimStartedElsewhere,
  notesClaimedIn
} from './claims-elsewhere';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const OWN = '0xAA11';
const OTHER = '0xbb22';

const pendingClaim = (overrides: {
  proposerId?: string;
  ageMs?: number;
  timestamp?: string;
  proposalType?: string;
  noteIds?: string[];
}): DeltaObject => ({
  accountId: '0xaccount',
  nonce: 8,
  prevCommitment: '0xprev',
  deltaPayload: {
    txSummary: { data: 'c3VtbWFyeQ==' },
    signatures: [],
    metadata: {
      proposalType: overrides.proposalType ?? 'consume_notes',
      noteIds: overrides.noteIds ?? ['0xN0TE']
    }
  },
  status: {
    status: 'pending',
    timestamp: overrides.timestamp ?? new Date(NOW - (overrides.ageMs ?? 5_000)).toISOString(),
    proposerId: overrides.proposerId ?? OTHER,
    cosignerSigs: []
  }
});

const noteKeys = claimNoteKeys(['n0te']);

describe('isClaimStartedElsewhere', () => {
  it('is true for a recent pending claim of the note that another signer proposed', () => {
    expect(isClaimStartedElsewhere(pendingClaim({}), OWN, noteKeys, NOW)).toBe(true);
  });

  it("never counts this device's own proposal, in any spelling of its commitment", () => {
    expect(isClaimStartedElsewhere(pendingClaim({ proposerId: 'aa11' }), OWN, noteKeys, NOW)).toBe(false);
  });

  it('ignores a proposal older than the window, which its device abandoned', () => {
    const stale = pendingClaim({ ageMs: CLAIM_STARTED_ELSEWHERE_WINDOW_MS + 1 });
    expect(isClaimStartedElsewhere(stale, OWN, noteKeys, NOW)).toBe(false);
  });

  it('ignores a proposal whose time cannot be read', () => {
    expect(isClaimStartedElsewhere(pendingClaim({ timestamp: 'not a time' }), OWN, noteKeys, NOW)).toBe(false);
  });

  it('ignores a claim of other notes and a proposal of another type', () => {
    expect(isClaimStartedElsewhere(pendingClaim({ noteIds: ['0xother'] }), OWN, noteKeys, NOW)).toBe(false);
    expect(isClaimStartedElsewhere(pendingClaim({ proposalType: 'p2id' }), OWN, noteKeys, NOW)).toBe(false);
  });

  it('ignores a delta that is not a pending proposal', () => {
    const candidate: DeltaObject = {
      ...pendingClaim({}),
      status: { status: 'candidate', timestamp: new Date(NOW).toISOString() }
    };
    expect(isClaimStartedElsewhere(candidate, OWN, noteKeys, NOW)).toBe(false);
  });

  it('reads the metadata that the Guardian attaches to the delta when the payload has none', () => {
    const base = pendingClaim({});
    const attached: DeltaObject = {
      ...base,
      metadata: { proposal: { proposalType: 'consume_notes', noteIds: ['N0TE'] } },
      deltaPayload: { txSummary: base.deltaPayload.txSummary, signatures: [] }
    };
    expect(isClaimStartedElsewhere(attached, OWN, noteKeys, NOW)).toBe(true);
  });
});

describe('notesClaimedIn', () => {
  const entry = (nonce: number, inputNoteIds: string[]): HistoryEntry => ({
    nonce,
    status: 'canonical',
    timestamp: new Date(NOW).toISOString(),
    inputNotes: inputNoteIds.map(noteId => ({ noteId, tag: 'p2id', noteType: 'public', assets: [] })),
    outputNotes: [{ noteId: '0xoutput', tag: 'p2id', noteType: 'public', assets: [] }],
    decodeWarnings: []
  });

  it('lists the input notes of every entry in the normalized form, and no output note', () => {
    const claimed = notesClaimedIn([entry(9, ['0xAB', '0xcd']), entry(8, ['ef'])]);
    expect([...claimed].sort()).toEqual(['ab', 'cd', 'ef']);
    expect(claimed.has('output')).toBe(false);
  });
});

describe('ClaimStartedElsewhereError', () => {
  it('names the notes', () => {
    const error = new ClaimStartedElsewhereError(['note-1', 'note-2']);
    expect(error.name).toBe('ClaimStartedElsewhereError');
    expect(error.noteIds).toEqual(['note-1', 'note-2']);
  });
});
