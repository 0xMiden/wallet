import semver from 'semver';

import { parseUpdateManifest, selectUpdateMetadata } from './manifest';
import type { UpdateAvailability, UpdateAvailabilityAdapter, UpdateCheckResult, UpdateNotice } from './types';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_UNKNOWN_RETRY_MS = 60_000;
const MAX_UNKNOWN_RETRY_MS = 60 * 60 * 1_000;

const UNKNOWN: UpdateCheckResult = { status: 'unknown' };
const NONE: UpdateCheckResult = { status: 'none' };

interface UpdateControllerOptions {
  adapter: UpdateAvailabilityAdapter;
  loadManifest: () => Promise<unknown>;
  now?: () => number;
  cacheDurationMs?: number;
  timeoutMs?: number;
  unknownRetryBaseMs?: number;
}

interface CachedResult {
  expiresAt: number;
  result: UpdateCheckResult;
}

export class UpdateController {
  private readonly adapter: UpdateAvailabilityAdapter;
  private readonly loadManifest: () => Promise<unknown>;
  private readonly now: () => number;
  private readonly cacheDurationMs: number;
  private readonly timeoutMs: number;
  private readonly unknownRetryBaseMs: number;
  private cached?: CachedResult;
  private inFlight?: Promise<UpdateCheckResult>;
  // The newest request, kept after it settles: a superseded request answers with
  // this instead of inventing a result of its own.
  private latest?: Promise<UpdateCheckResult>;
  private retryAfter = 0;
  private unknownCount = 0;
  private generation = 0;

  constructor(options: UpdateControllerOptions) {
    this.adapter = options.adapter;
    this.loadManifest = options.loadManifest;
    this.now = options.now ?? Date.now;
    this.cacheDurationMs = options.cacheDurationMs ?? SIX_HOURS_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.unknownRetryBaseMs = options.unknownRetryBaseMs ?? DEFAULT_UNKNOWN_RETRY_MS;
  }

  /**
   * Ask the platform whether an update is available.
   *
   * `force` is the whole of "check again now": it supersedes any request in
   * flight and drops the cache and the backoff. A plain check reuses all three,
   * which is what an app foreground wants - the platform's answer does not
   * change every time the user switches back to the wallet.
   */
  check({ force = false }: { force?: boolean } = {}): Promise<UpdateCheckResult> {
    const now = this.now();
    if (force) {
      this.generation += 1;
      this.cached = undefined;
      this.retryAfter = 0;
      this.unknownCount = 0;
    } else {
      if (this.inFlight) return this.inFlight;
      if (this.cached && this.cached.expiresAt > now) return Promise.resolve(this.cached.result);
      // Inside the backoff the platform has not answered, which is not the same
      // as "no update": saying `none` here would retract a card it confirmed.
      if (this.retryAfter > now) return Promise.resolve(UNKNOWN);
    }

    const generation = this.generation;
    const request = this.runCheck(generation).finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    this.inFlight = request;
    this.latest = request;
    return request;
  }

  private async runCheck(generation: number): Promise<UpdateCheckResult> {
    const availability = await this.checkWithTimeout();
    if (generation !== this.generation) return this.supersededResult();
    if (availability.status === 'unknown') {
      this.unknownCount += 1;
      const delay = Math.min(this.unknownRetryBaseMs * 2 ** (this.unknownCount - 1), MAX_UNKNOWN_RETRY_MS);
      this.retryAfter = this.now() + delay;
      return UNKNOWN;
    }

    this.unknownCount = 0;
    this.retryAfter = 0;
    if (availability.status === 'none') {
      // The hint is optional and may load the manifest; the answer the platform
      // already gave must not wait for it.
      void this.hintAvailableVersion(availability.currentVersion);
      this.cached = { result: NONE, expiresAt: this.now() + this.cacheDurationMs };
      return NONE;
    }

    const notice = await this.toNotice(availability);
    if (generation !== this.generation) return this.supersededResult();
    const result: UpdateCheckResult = notice ? { status: 'available', notice } : NONE;
    this.cached = { result, expiresAt: this.now() + this.cacheDurationMs };
    return result;
  }

  // A forced check always replaces `latest` before the superseded request can
  // reach here, so its callers see the newer answer rather than a stale one.
  private supersededResult(): Promise<UpdateCheckResult> {
    return this.latest ?? Promise.resolve(UNKNOWN);
  }

  private checkWithTimeout(): Promise<UpdateAvailability> {
    return this.withTimeout(() => this.adapter.check(), UNKNOWN as UpdateAvailability);
  }

  /**
   * Bound optional work so it can never hold up an authoritative answer. The
   * fallback is what the caller shows when the deadline passes.
   */
  private async withTimeout<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>(resolve => {
      timer = setTimeout(() => resolve(fallback), this.timeoutMs);
    });
    try {
      return await Promise.race([work(), timeout]);
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async toNotice(
    availability: Extract<UpdateAvailability, { status: 'available' }>
  ): Promise<UpdateNotice | null> {
    if (!semver.valid(availability.currentVersion) || !semver.valid(availability.availableVersion)) return null;
    if (!semver.gt(availability.availableVersion, availability.currentVersion)) return null;

    const metadata = await this.withTimeout(async () => {
      const manifest = parseUpdateManifest(await this.loadManifest());
      return selectUpdateMetadata(manifest, this.adapter.platform, availability.availableVersion);
    }, null);

    return {
      platform: this.adapter.platform,
      currentVersion: availability.currentVersion,
      availableVersion: availability.availableVersion,
      // Availability remains authoritative when optional presentation metadata
      // is unavailable, invalid, or too slow.
      summary: metadata?.summary ?? null,
      urgency: metadata?.urgency ?? 'normal',
      action: availability.action
    };
  }

  private async hintAvailableVersion(currentVersion: string): Promise<void> {
    const hint = this.adapter.hintAvailableVersion;
    if (!hint) return;
    // The adapter decides whether a hint is due before this runs, so a throttled
    // hint costs no catalog fetch.
    const loadCandidate = async (): Promise<string | null> => {
      const manifest = await this.withTimeout(async () => parseUpdateManifest(await this.loadManifest()), null);
      if (!manifest) return null;
      const candidate = manifest.releases
        .filter(
          release =>
            release.platforms.some(name => name === this.adapter.platform) && semver.gt(release.version, currentVersion)
        )
        .sort((left, right) => semver.rcompare(left.version, right.version))[0];
      return candidate?.version ?? null;
    };
    try {
      await hint.call(this.adapter, loadCandidate);
    } catch {
      // Invalid optional metadata cannot create or suppress authoritative availability.
    }
  }
}
