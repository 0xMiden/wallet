import {
  clearPollRegistryForTests,
  earnDepositPollKey,
  earnWithdrawPollKey,
  endPoll,
  isPollActive,
  tryBeginPoll
} from './poll-registry';

describe('poll-registry', () => {
  beforeEach(() => clearPollRegistryForTests());

  it('claims a free key and rejects a second claim until it is released', () => {
    expect(tryBeginPoll('k1')).toBe(true);
    expect(isPollActive('k1')).toBe(true);
    expect(tryBeginPoll('k1')).toBe(false);

    endPoll('k1');
    expect(isPollActive('k1')).toBe(false);
    expect(tryBeginPoll('k1')).toBe(true);
  });

  it('tracks keys independently', () => {
    expect(tryBeginPoll('a')).toBe(true);
    expect(tryBeginPoll('b')).toBe(true);
    endPoll('a');
    expect(isPollActive('a')).toBe(false);
    expect(isPollActive('b')).toBe(true);
  });

  it('releasing an unclaimed key is a harmless no-op', () => {
    expect(() => endPoll('ghost')).not.toThrow();
    expect(isPollActive('ghost')).toBe(false);
  });

  it('namespaces deposit and withdraw keys so the same nonce never collides', () => {
    expect(earnDepositPollKey('N1')).not.toBe(earnWithdrawPollKey('N1'));
    expect(tryBeginPoll(earnDepositPollKey('N1'))).toBe(true);
    expect(tryBeginPoll(earnWithdrawPollKey('N1'))).toBe(true);
  });
});
