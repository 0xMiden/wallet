import {
  decideColdReRegisterSelfHeal,
  SELF_HEAL_AUTH_FAILURE_THRESHOLD,
  SELF_HEAL_MAX_ATTEMPTS,
  SELF_HEAL_COOLDOWN_MS,
  type SelfHealAttemptState
} from './guardian-selfheal';

const NOW = 1_000_000;

describe('decideColdReRegisterSelfHeal', () => {
  describe('persistence gate', () => {
    it('does not fire below the consecutive-401 threshold (transient 401)', () => {
      for (let fails = 0; fails < SELF_HEAL_AUTH_FAILURE_THRESHOLD; fails++) {
        expect(decideColdReRegisterSelfHeal(NOW, fails, undefined)).toBe(false);
      }
    });

    it('fires once the 401 has persisted to the threshold (no prior attempt)', () => {
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD, undefined)).toBe(true);
    });

    it('fires above the threshold too', () => {
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD + 5, undefined)).toBe(true);
    });
  });

  describe('bounded retry', () => {
    it('gives up once MAX_ATTEMPTS is reached, even with a persistent 401 past cooldown', () => {
      const state: SelfHealAttemptState = {
        attempts: SELF_HEAL_MAX_ATTEMPTS,
        lastAttemptAt: NOW - SELF_HEAL_COOLDOWN_MS - 1
      };
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD + 10, state)).toBe(false);
    });

    it('still fires on the last allowed attempt (attempts = MAX - 1) past cooldown', () => {
      const state: SelfHealAttemptState = {
        attempts: SELF_HEAL_MAX_ATTEMPTS - 1,
        lastAttemptAt: NOW - SELF_HEAL_COOLDOWN_MS - 1
      };
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD, state)).toBe(true);
    });
  });

  describe('cooldown', () => {
    it('does not fire again within the cooldown window', () => {
      const state: SelfHealAttemptState = { attempts: 1, lastAttemptAt: NOW - (SELF_HEAL_COOLDOWN_MS - 1) };
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD, state)).toBe(false);
    });

    it('fires again once the cooldown has fully elapsed', () => {
      const state: SelfHealAttemptState = { attempts: 1, lastAttemptAt: NOW - SELF_HEAL_COOLDOWN_MS };
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD, state)).toBe(true);
    });

    it('does not fire exactly one ms before the cooldown elapses', () => {
      const state: SelfHealAttemptState = { attempts: 1, lastAttemptAt: NOW - SELF_HEAL_COOLDOWN_MS + 1 };
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD, state)).toBe(false);
    });
  });

  describe('combined precedence', () => {
    it('persistence is checked before cooldown/attempts (below threshold never fires even if attempts=0 and cooldown elapsed)', () => {
      const state: SelfHealAttemptState = { attempts: 0, lastAttemptAt: NOW - SELF_HEAL_COOLDOWN_MS - 1 };
      expect(decideColdReRegisterSelfHeal(NOW, SELF_HEAL_AUTH_FAILURE_THRESHOLD - 1, state)).toBe(false);
    });
  });
});
