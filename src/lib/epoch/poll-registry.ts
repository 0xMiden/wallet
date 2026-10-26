export { earnDepositPollKey, earnWithdrawPollKey } from './intent-key';

export interface EarnLockManager {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: object | null) => Promise<void>
  ): Promise<void>;
}

export const getEarnLocks = (): EarnLockManager | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.locks;

export interface IntentPollContext {
  isCurrent(): boolean;
  markTerminal(): void;
}

export interface IntentPollOptions {
  key: string;
  intervalMs: number;
  maxAttempts: number;
  immediate?: boolean;
  tick(context: IntentPollContext): Promise<void>;
}

interface PollSession {
  timer?: ReturnType<typeof setTimeout>;
  terminal: boolean;
  release(): void;
}

/** A session owns its intent through requests, durable writes and cooldowns. */
export function createIntentPollCoordinator({
  getLocks = getEarnLocks
}: {
  getLocks?: () => EarnLockManager | undefined;
} = {}) {
  const sessions = new Map<string, PollSession>();

  function startIntentPoll(options: IntentPollOptions): void {
    const { key, intervalMs, maxAttempts, tick } = options;
    if (sessions.has(key)) return;
    let release!: () => void;
    const completion = new Promise<void>(resolve => {
      release = resolve;
    });
    const session: PollSession = { terminal: false, release };
    sessions.set(key, session);
    const isCurrent = () => sessions.get(key) === session;
    const finish = () => {
      if (session.timer !== undefined) clearTimeout(session.timer);
      if (isCurrent()) sessions.delete(key);
      session.release();
    };
    let attempts = 0;
    let cooldownMs = 30_000;
    const context: IntentPollContext = {
      isCurrent,
      markTerminal: () => {
        session.terminal = true;
      }
    };
    const schedule = (delay: number) => {
      session.timer = setTimeout(() => {
        void run();
      }, delay);
    };
    const run = async () => {
      if (!isCurrent()) return;
      attempts += 1;
      try {
        await tick(context);
      } catch (error) {
        if (isCurrent()) console.warn('[earn-poll] tick failed', error);
      } finally {
        if (!isCurrent()) return;
        if (session.terminal) {
          finish();
        } else if (attempts >= maxAttempts) {
          attempts = 0;
          schedule(cooldownMs);
          cooldownMs = Math.min(cooldownMs * 2, 300_000);
        } else {
          schedule(intervalMs);
        }
      }
    };
    const own = async (lock: object | null) => {
      if (!lock || !isCurrent()) {
        finish();
        return;
      }
      if (options.immediate) void run();
      else schedule(intervalMs);
      await completion;
    };
    // Never await this request at the caller: its callback holds a document-lifetime lease.
    try {
      const locks = getLocks();
      const request = locks ? locks.request(`earn-poll:${key}`, { ifAvailable: true }, own) : own({});
      void request.catch(error => {
        if (isCurrent()) console.warn('[earn-poll] lock failed', error);
        finish();
      });
    } catch (error) {
      console.warn('[earn-poll] lock failed', error);
      finish();
    }
  }

  function dispose(): void {
    const previous = [...sessions.values()];
    sessions.clear();
    for (const session of previous) {
      if (session.timer !== undefined) clearTimeout(session.timer);
      session.release();
    }
  }

  return { startIntentPoll, isPollActive: (key: string) => sessions.has(key), dispose };
}

const coordinator = createIntentPollCoordinator();
export const startIntentPoll = coordinator.startIntentPoll;
export const isPollActive = coordinator.isPollActive;
export const clearPollRegistryForTests = coordinator.dispose;
if (typeof window !== 'undefined') window.addEventListener('pagehide', coordinator.dispose);
