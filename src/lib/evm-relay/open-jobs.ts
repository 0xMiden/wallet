/**
 * The relay jobs that a submit of this realm left open. A submit that rejects with `RelayUnknownOutcomeError` or
 * `RelayStillPendingError` reports the job here. A flow whose relay error does not come back to it as a typed error (a
 * library that wraps the error and drops its `cause`) starts a watch before it sends and reads the open jobs after the
 * send. A watch sees only the jobs of its chain and address, and only while it is open.
 */
import type { Address } from 'viem';

import { lowerAddress } from './parse';
import type { RelayJobRef } from './types';

export interface OpenRelayJobWatch {
  /** The open jobs that a submit reported since the watch started, oldest first. */
  jobs(): RelayJobRef[];
  /** Ends the watch. Later reports do not reach it. */
  stop(): void;
}

interface Watcher {
  chainId: number;
  address: Address;
  jobs: RelayJobRef[];
}

const watchers = new Set<Watcher>();

/** Starts a watch of the open jobs of `address` (letter case ignored) on `chainId`. */
export function watchOpenRelayJobs(chainId: number, address: string): OpenRelayJobWatch {
  const lower = lowerAddress(address);
  if (lower === null) throw new TypeError('relay open jobs: the address is not valid');
  const watcher: Watcher = { chainId, address: lower, jobs: [] };
  watchers.add(watcher);
  return {
    jobs: () => [...watcher.jobs],
    stop: () => {
      watchers.delete(watcher);
    }
  };
}

/** Gives an open job of `address` to each watch of its chain and address. The submitter calls it. */
export function reportOpenRelayJob(address: string, job: RelayJobRef): void {
  const lower = lowerAddress(address);
  if (lower === null) return;
  for (const watcher of watchers) {
    if (watcher.chainId === job.chainId && watcher.address === lower) watcher.jobs.push(job);
  }
}
