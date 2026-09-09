import { UNKNOWN_GROUP_ID } from 'app/templates/history/activity-grouping';

import { ActionableNoteInput, isNoteActionable } from './useActionableActivity';

const NATIVE = 'mtst1nativefaucetxxxxxxxxxxxxxxxxxxxxxxxx';
const OTHER = 'mtst1otherfaucetxxxxxxxxxxxxxxxxxxxxxxxxx';

const note = (over: Partial<ActionableNoteInput> = {}): ActionableNoteInput => ({
  faucetId: NATIVE,
  isBeingClaimed: false,
  ...over
});

describe('isNoteActionable — auto-consume', () => {
  it('is NOT actionable for a native note while auto-consume is on', () => {
    // The default configuration: NativeNoteAutoConsumeManager will claim this
    // without the user. Badging it tells them to do what the wallet is doing.
    expect(isNoteActionable(note(), NATIVE, true)).toBe(false);
  });

  it('IS actionable for the same note once auto-consume is off', () => {
    expect(isNoteActionable(note(), NATIVE, false)).toBe(true);
  });

  it('is actionable for a non-native note regardless of the setting', () => {
    expect(isNoteActionable(note({ faucetId: OTHER }), NATIVE, true)).toBe(true);
    expect(isNoteActionable(note({ faucetId: OTHER }), NATIVE, false)).toBe(true);
  });

  it('is actionable for a native swap-order note — the auto-consumer skips those', () => {
    expect(isNoteActionable(note({ swapOrder: { id: 'o1' } }), NATIVE, true)).toBe(true);
  });

  it('is actionable when the native faucet id is not resolved yet', () => {
    // Better to over-surface than to silently swallow an action because a
    // memoised chain lookup has not returned.
    expect(isNoteActionable(note(), null, true)).toBe(true);
  });
});

describe('isNoteActionable — in flight', () => {
  it('is not actionable once a claim is already running', () => {
    // The old dot stayed lit through the very act of clearing it.
    expect(isNoteActionable(note({ faucetId: OTHER, isBeingClaimed: true }), NATIVE, false)).toBe(false);
  });

  it('in-flight beats every other reason to show it', () => {
    expect(isNoteActionable(note({ isBeingClaimed: true, swapOrder: { id: 'o1' } }), NATIVE, false)).toBe(false);
  });
});

describe('group keys', () => {
  it('files a sender-less action under the unknown group', () => {
    expect(UNKNOWN_GROUP_ID).toBe('unknown');
  });
});
