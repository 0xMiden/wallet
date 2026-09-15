import { EarnLockManager, getEarnLocks } from './poll-registry';

export interface EarnSubmissionContext {
  isCurrent(): boolean;
}

export type EarnSubmissionResult<T> = { acquired: false } | { acquired: true; value: T };

/** Submission ownership starts before exposing the row and ends after its durability writes. */
export function createEarnSubmissionLocks({
  getLocks = getEarnLocks
}: {
  getLocks?: () => EarnLockManager | undefined;
} = {}) {
  const sessions = new Set<{ cancel(): void }>();
  const localTails = new Map<string, Promise<void>>();

  function acquire<T>(
    attemptId: string,
    ifAvailable: boolean,
    operation: (context: EarnSubmissionContext) => Promise<T>
  ): Promise<EarnSubmissionResult<T>> {
    return new Promise<EarnSubmissionResult<T>>((resolve, reject) => {
      let release!: () => void;
      const completion = new Promise<void>(done => {
        release = done;
      });
      const finish = () => {
        sessions.delete(session);
        release();
      };
      const fail = (error: unknown) => {
        if (!sessions.has(session)) return;
        reject(error);
        finish();
      };
      const session = { cancel: () => fail(new Error('Earn submission owner disposed.')) };
      sessions.add(session);
      const context = { isCurrent: () => sessions.has(session) };
      const own = async (lock: object | null) => {
        if (!context.isCurrent()) return;
        if (!lock) {
          resolve({ acquired: false });
          finish();
          return;
        }
        // Disposal resolves completion independently of a parked network callback.
        void Promise.resolve()
          .then(async () => {
            if (!context.isCurrent()) return;
            const value = await operation(context);
            if (!context.isCurrent()) return;
            resolve({ acquired: true, value });
            finish();
          })
          .catch(fail);
        await completion;
      };
      try {
        const locks = getLocks();
        if (locks) {
          void locks.request(`earn-submit:${attemptId}`, { ifAvailable }, own).catch(fail);
        } else {
          const previous = localTails.get(attemptId);
          if (previous && ifAvailable) {
            void own(null);
            return;
          }
          localTails.set(attemptId, completion);
          void (previous ?? Promise.resolve()).then(() => own({})).catch(fail);
          void completion.then(() => {
            if (localTails.get(attemptId) === completion) localTails.delete(attemptId);
          });
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  async function withEarnSubmissionLock<T>(
    attemptId: string,
    operation: (context: EarnSubmissionContext) => Promise<T>
  ): Promise<T> {
    const result = await acquire(attemptId, false, operation);
    if (!result.acquired) throw new Error('Earn submission lock was not acquired.');
    return result.value;
  }

  function tryWithEarnSubmissionLock<T>(
    attemptId: string,
    operation: (context: EarnSubmissionContext) => Promise<T>
  ): Promise<EarnSubmissionResult<T>> {
    return acquire(attemptId, true, operation);
  }

  function dispose(): void {
    for (const session of sessions) session.cancel();
  }

  return { withEarnSubmissionLock, tryWithEarnSubmissionLock, dispose };
}

const submissionLocks = createEarnSubmissionLocks();
export const withEarnSubmissionLock = submissionLocks.withEarnSubmissionLock;
export const tryWithEarnSubmissionLock = submissionLocks.tryWithEarnSubmissionLock;
export const clearEarnSubmissionLocksForTests = submissionLocks.dispose;
if (typeof window !== 'undefined') window.addEventListener('pagehide', submissionLocks.dispose);
