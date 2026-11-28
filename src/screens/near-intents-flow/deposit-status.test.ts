import type { IOneClickPhase } from 'lib/miden/db/types';

import {
  depositDeadlineMs,
  type NearIntentsDepositScreen,
  nearIntentsDepositScreenOf,
  nearIntentsTrackingOf,
  waitsForDeposit
} from './deposit-status';
import { NEAR_TEST_DEADLINE, nearRowFixture, nearTrackingFixture } from './testing';

describe('nearIntentsTrackingOf', () => {
  it('reads the tracking of a row with a deposit address, else nothing', () => {
    expect(nearIntentsTrackingOf(nearRowFixture(nearTrackingFixture()))?.phase).toBe('depositing');
    expect(nearIntentsTrackingOf(nearRowFixture(nearTrackingFixture({ depositAddress: undefined })))).toBeUndefined();
    expect(nearIntentsTrackingOf(nearRowFixture(undefined))).toBeUndefined();
    expect(nearIntentsTrackingOf(undefined)).toBeUndefined();
  });
});

describe('depositDeadlineMs', () => {
  it('takes the funding deadline, else the quote deadline, else the request deadline', () => {
    const base = nearTrackingFixture();
    expect(depositDeadlineMs(base)).toBe(Date.parse(NEAR_TEST_DEADLINE));
    const noFunding = nearTrackingFixture({ fundingDeadline: undefined });
    noFunding.quote = { ...noFunding.quote, quote: { ...noFunding.quote.quote, deadline: '2026-11-10T15:00:00Z' } };
    expect(depositDeadlineMs(noFunding)).toBe(Date.parse('2026-11-10T15:00:00Z'));
    noFunding.quote = { ...noFunding.quote, quote: { ...noFunding.quote.quote, deadline: undefined } };
    expect(depositDeadlineMs(noFunding)).toBe(Date.parse(NEAR_TEST_DEADLINE));
    expect(depositDeadlineMs(nearTrackingFixture({ fundingDeadline: 'not a date' }))).toBeNaN();
  });
});

describe('nearIntentsDepositScreenOf', () => {
  it.each<[IOneClickPhase, boolean, NearIntentsDepositScreen, boolean]>([
    ['depositing', false, { kind: 'address', state: 'waiting' }, true],
    ['pending-deposit', false, { kind: 'address', state: 'waiting' }, true],
    ['pending-deposit', true, { kind: 'address', state: 'expired' }, true],
    ['incomplete-deposit', true, { kind: 'address', state: 'incomplete' }, true],
    ['expired', false, { kind: 'address', state: 'expired' }, false],
    ['known-deposit-tx', false, { kind: 'processing', step: 0 }, false],
    ['processing', false, { kind: 'processing', step: 1 }, false],
    ['arriving', false, { kind: 'processing', step: 2 }, false],
    ['delivered', false, { kind: 'success' }, false],
    ['refunded', false, { kind: 'failed', reason: 'refunded' }, false],
    ['failed', false, { kind: 'failed', reason: 'failed' }, false]
  ])('maps %s (deadline passed: %s) to its screen', (phase, deadlinePassed, screen, waits) => {
    expect(nearIntentsDepositScreenOf(phase, deadlinePassed)).toEqual(screen);
    expect(waitsForDeposit(phase)).toBe(waits);
  });
});
