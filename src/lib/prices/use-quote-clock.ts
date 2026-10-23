import { useEffect, useSyncExternalStore } from 'react';

// One clock for every mounted estimate, including long-lived approvals and activity lists.
const listeners = new Set<() => void>();
const deadlines = new Map<number, number>();
let revision = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
let armedFor: number | undefined;
const snapshot = () => revision;

const notify = () => {
  revision += 1;
  listeners.forEach(listener => listener());
};

const earliestDeadline = (now: number): number | undefined => {
  let earliest: number | undefined;
  for (const deadline of deadlines.keys()) {
    if (deadline <= now) continue;
    if (earliest === undefined || deadline < earliest) earliest = deadline;
  }
  return earliest;
};

const armDeadline = () => {
  const now = Date.now();
  const earliest = earliestDeadline(now);
  if (earliest === armedFor && deadlineTimer !== undefined) return;
  if (deadlineTimer !== undefined) {
    clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    armedFor = undefined;
  }
  if (earliest === undefined) return;
  const delay = earliest - now;
  if (delay <= 0) return;
  armedFor = earliest;
  deadlineTimer = setTimeout(() => {
    deadlineTimer = undefined;
    armedFor = undefined;
    notify();
    armDeadline();
  }, delay);
};

const registerDeadline = (deadline: number | undefined): (() => void) => {
  if (deadline === undefined || !Number.isFinite(deadline) || deadline <= Date.now()) return () => {};
  deadlines.set(deadline, (deadlines.get(deadline) ?? 0) + 1);
  armDeadline();
  return () => {
    const count = (deadlines.get(deadline) ?? 0) - 1;
    if (count <= 0) deadlines.delete(deadline);
    else deadlines.set(deadline, count);
    armDeadline();
  };
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(notify, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

export function useQuoteClock(deadline?: number): void {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => registerDeadline(deadline), [deadline]);
}
