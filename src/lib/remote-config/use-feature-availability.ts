import { useEffect, useSyncExternalStore } from 'react';

import { usePageActive } from 'app/layouts/page-active';

import { type BridgeFeature, type FeatureAvailability, featureAvailability } from './availability';
import { type E2eOverrides, getE2eOverrides, subscribeE2eOverrides } from './e2e-overrides';
import {
  type BridgeConfigSnapshot,
  getBridgeConfigSnapshot,
  holdFastPoll,
  initBridgeConfig,
  subscribeBridgeConfig
} from './runtime';

const AVAILABLE: FeatureAvailability = { state: 'available' };

export interface BridgeConfigSnapshotOptions {
  /**
   * Whether this reader also loads the config. Defaults to true; a reader that only names a token passes false, since
   * every page realm loads it at boot and follows every change of the effective network through
   * `followEffectiveNetwork`.
   */
  load?: boolean;
}

/** This realm's bridge config snapshot, re-rendering on every change the runtime publishes. */
export function useBridgeConfigSnapshot({ load = true }: BridgeConfigSnapshotOptions = {}): BridgeConfigSnapshot {
  const snapshot = useSyncExternalStore(subscribeBridgeConfig, getBridgeConfigSnapshot);
  // Keyed on the network, so a Developer Settings switch loads that network's copy at once. Never rejects.
  useEffect(() => (load ? void initBridgeConfig() : undefined), [load, snapshot.network]);
  return snapshot;
}

// The overrides are a store of their own: an E2E hook that sets one has to reach a control already on screen.
function useAvailabilityInputs(): { snapshot: BridgeConfigSnapshot; overrides: E2eOverrides } {
  const snapshot = useBridgeConfigSnapshot();
  const overrides = useSyncExternalStore(subscribeE2eOverrides, getE2eOverrides);
  return { snapshot, overrides };
}

export interface FeatureAvailabilityOptions {
  /**
   * Whether the caller draws the control or notice this availability greys out, and so holds the 60 s fast poll
   * while it reads unavailable. Defaults to true; a branch that draws neither passes false. A function is resolved
   * against the availability just computed, and the fast poll sees only that boolean.
   */
  hold?: boolean | ((availability: FeatureAvailability) => boolean);
  chainId?: number;
}

// A function closes over whether the caller draws this reading. Resolved here, the effect keeps a boolean hold:
// the same cadence, and a hidden entry does not hold just because a function is truthy.
function resolveHold(
  hold: boolean | ((availability: FeatureAvailability) => boolean),
  availability: FeatureAvailability
): boolean {
  return typeof hold === 'function' ? hold(availability) : hold;
}

// A greyed-out control on the page the user is looking at holds the 60 s cadence, whatever greyed it, so it recovers
// within about a minute. Loading never holds; the first load is already in flight.
function useFastPollWhileUnavailable(availability: FeatureAvailability, hold: boolean): void {
  const pageActive = usePageActive();
  const unavailable = availability.state === 'unavailable';
  useEffect(() => (hold && unavailable && pageActive ? holdFastPoll() : undefined), [hold, unavailable, pageActive]);
}

/** The availability of the feature a control starts. */
export function useFeatureAvailability(
  feature: BridgeFeature,
  { hold = true, chainId }: FeatureAvailabilityOptions = {}
): FeatureAvailability {
  const { snapshot, overrides } = useAvailabilityInputs();
  const availability = featureAvailability(feature, snapshot, overrides, chainId);
  useFastPollWhileUnavailable(availability, resolveHold(hold, availability));
  return availability;
}

/**
 * One control that opens a choice of features, such as Receive's Cross Chain (Fast or Slow bridge-in): available
 * while any is; else loading while any is; else the first reason other than not configured; else not configured, so
 * the control reads as not configured only on a network that configures none of its features.
 */
export function useAnyFeatureAvailability(
  features: readonly [BridgeFeature, ...BridgeFeature[]],
  { hold = true, chainId }: FeatureAvailabilityOptions = {}
): FeatureAvailability {
  const { snapshot, overrides } = useAvailabilityInputs();
  const [first, ...rest] = features;
  const head = featureAvailability(first, snapshot, overrides, chainId);
  const all = [head, ...rest.map(feature => featureAvailability(feature, snapshot, overrides, chainId))];
  const available = all.some(candidate => candidate.state === 'available');
  const availability = available
    ? AVAILABLE
    : (all.find(candidate => candidate.state === 'loading') ??
      all.find(candidate => candidate.state === 'unavailable' && candidate.reason !== 'not-configured') ??
      head);
  useFastPollWhileUnavailable(availability, resolveHold(hold, availability));
  return availability;
}
