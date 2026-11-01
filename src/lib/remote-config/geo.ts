import { BOUNDED_JSON_FAILURES, type BoundedJsonFailure } from 'lib/remote-json';

import type { OneClickConfig } from './schema';

/**
 * Place rules from a wallet-config document. A rule is a phrase such as "block NY state" or
 * "block UK", answered "yes" or "no". The same list can name earn today and swap later.
 * `scripts/validate.mjs` in 0xMiden/wallet-config checks the same phrases; keep the two together.
 */

/** Features a place rule can turn off. A document may name others; this build ignores those. */
export const GEO_FEATURES = ['wallet', 'earn', 'swap'] as const;
export type GeoFeature = (typeof GEO_FEATURES)[number];

/** A place a rule blocks. `region` is the ISO 3166-2 subdivision, such as NY, and only set for a state rule. */
export interface GeoPlace {
  country: string;
  region?: string;
}

export type GeoBlocks = Partial<Record<GeoFeature, GeoPlace[]>>;

/** The service exposes policy decisions, never the connection's country, region or address. */
export interface FeatureEligibility {
  network: string;
  version: number;
  allowed: Record<GeoFeature, boolean>;
}

export const STARTUP_ELIGIBILITY_STAGES = [
  'endpoint_overrides',
  'config_initialization',
  'eligibility_lookup',
  'config_refresh',
  'eligibility_retry'
] as const;
export const STARTUP_ELIGIBILITY_REASONS = [
  'override_load_failed',
  'config_unavailable',
  'config_initialization_failed',
  'endpoint_missing',
  'endpoint_invalid',
  'request_failed',
  'response_invalid',
  'network_mismatch',
  'version_mismatch',
  'unexpected'
] as const;
export const STARTUP_ELIGIBILITY_REQUEST_FAILURES = BOUNDED_JSON_FAILURES;
export const STARTUP_ELIGIBILITY_RETRIES = [
  'not_attempted',
  'config_not_advanced',
  'refresh_failed',
  'retry_failed'
] as const;
export type StartupEligibilityReason = (typeof STARTUP_ELIGIBILITY_REASONS)[number];
export type StartupEligibilityRequestFailure = BoundedJsonFailure;
export interface StartupEligibilityDiagnostics {
  startupEligibilityStage: (typeof STARTUP_ELIGIBILITY_STAGES)[number];
  startupEligibilityReason: StartupEligibilityReason;
  startupEligibilityRetry: (typeof STARTUP_ELIGIBILITY_RETRIES)[number];
  startupEligibilityRequestFailure?: StartupEligibilityRequestFailure;
}

/** A failed startup decision keeps geo-gated features off until the page restarts; the wallet stays open. */
export type GeoLookup =
  | { state: 'loading' }
  | { state: 'failed'; diagnostics?: StartupEligibilityDiagnostics }
  | ({ state: 'ready' } & FeatureEligibility);

/** Structural feature availability; live route and market probes remain separate. */
export function geoFeatureEnabled(
  feature: GeoFeature,
  config: {
    features: { earn: boolean; nearIntents?: unknown };
    swap?: { etaUrl?: string; oneClick?: OneClickConfig };
  }
): boolean {
  if (feature === 'wallet') return true;
  if (feature === 'earn') return config.features.earn;
  return (
    Boolean(config.swap?.etaUrl) ||
    (config.features.nearIntents === true && (config.swap?.oneClick?.midenAssets.length ?? 0) > 0)
  );
}

const PHRASE_ALIASES: Readonly<Record<string, GeoPlace>> = {
  'ny state': { country: 'US', region: 'NY' },
  'new york': { country: 'US', region: 'NY' },
  uk: { country: 'GB' },
  'united kingdom': { country: 'GB' },
  'great britain': { country: 'GB' }
};

function isGeoFeature(name: string): name is GeoFeature {
  return (GEO_FEATURES as readonly string[]).includes(name);
}

/**
 * The place a phrase names, or undefined when this build does not know it. Unknown phrases are left
 * out of the parsed rules so a newer phrase does not make this build reject the whole document.
 * "block US-CA" and "block DE" need no alias: the country is ISO 3166-1 and the region ISO 3166-2.
 */
export function parseGeoPhrase(phrase: string): GeoPlace | undefined {
  const text = phrase.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!text.startsWith('block ')) return undefined;
  const place = text.slice('block '.length);
  if (Object.prototype.hasOwnProperty.call(PHRASE_ALIASES, place)) return PHRASE_ALIASES[place];
  if (/^[a-z]{2}$/.test(place)) return { country: place.toUpperCase() };
  const subdivision = /^([a-z]{2})-([a-z0-9]{1,3})$/.exec(place);
  if (!subdivision?.[1] || !subdivision[2]) return undefined;
  return { country: subdivision[1].toUpperCase(), region: subdivision[2].toUpperCase() };
}

/** True when the document blocks at least one place for a feature this build enforces. */
export function hasGeoBlocks(config: { geo?: GeoBlocks } | null | undefined): boolean {
  if (!config?.geo) return false;
  return GEO_FEATURES.some(feature => (config.geo?.[feature]?.length ?? 0) > 0);
}

/**
 * Whether `place` is inside a block list. `unknown` means a state rule covers the country and the
 * lookup did not say which state: the feature stays off, because an unstated state is not a pass.
 */
export function placeBlocked(
  blocks: readonly GeoPlace[],
  place: { country: string; region?: string }
): 'allow' | 'block' | 'unknown' {
  const country = place.country.toUpperCase();
  const region = place.region?.toUpperCase();
  const forCountry = blocks.filter(block => block.country === country);
  if (forCountry.length === 0) return 'allow';
  if (forCountry.some(block => block.region === undefined)) return 'block';
  if (!region) return 'unknown';
  return forCountry.some(block => block.region === region) ? 'block' : 'allow';
}

/**
 * The "yes" places for one feature. A value other than "yes" or "no", or a feature whose rules are
 * not an object, rejects the document. An unknown feature or phrase is skipped.
 */
export function readGeoBlocks(value: unknown, invalid: () => never): GeoBlocks | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const blocks: GeoBlocks = {};
  for (const [feature, rules] of Object.entries(value)) {
    if (!isGeoFeature(feature)) continue;
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) return invalid();
    const places: GeoPlace[] = [];
    for (const [phrase, answer] of Object.entries(rules)) {
      if (answer !== 'yes' && answer !== 'no') return invalid();
      const place = parseGeoPhrase(phrase);
      if (!place && feature === 'wallet' && answer === 'yes') return invalid();
      if (!place || answer === 'no') continue;
      places.push(place);
    }
    if (feature === 'wallet' || places.length > 0) blocks[feature] = places;
  }
  return Object.keys(blocks).length > 0 ? blocks : undefined;
}
