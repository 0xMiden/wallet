import semver from 'semver';

import { parseUpdateManifest, selectUpdateMetadata } from './manifest';
import type { UpdateAvailability, UpdateAvailabilityAdapter, UpdateNotice } from './types';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_UNKNOWN_RETRY_MS = 60_000;
const MAX_UNKNOWN_RETRY_MS = 60 * 60 * 1_000;

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
  notice: UpdateNotice | null;
}

export class UpdateController {
  private readonly adapter: UpdateAvailabilityAdapter;
  private readonly loadManifest: () => Promise<unknown>;
  private readonly now: () => number;
  private readonly cacheDurationMs: number;
  private readonly timeoutMs: number;
  private readonly unknownRetryBaseMs: number;
  private cached?: CachedResult;
  private inFlight?: Promise<UpdateNotice | null>;
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

  check({ force = false }: { force?: boolean } = {}): Promise<UpdateNotice | null> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!force && this.cached && this.cached.expiresAt > now) return Promise.resolve(this.cached.notice);
    if (!force && this.retryAfter > now) return Promise.resolve(null);

    const generation = this.generation;
    const request = this.runCheck(generation).finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    this.inFlight = request;
    return request;
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.inFlight = undefined;
    this.retryAfter = 0;
    this.unknownCount = 0;
  }

  private async runCheck(generation: number): Promise<UpdateNotice | null> {
    const availability = await this.checkWithTimeout();
    if (generation !== this.generation) return null;
    if (availability.status === 'unknown') {
      this.unknownCount += 1;
      const delay = Math.min(this.unknownRetryBaseMs * 2 ** (this.unknownCount - 1), MAX_UNKNOWN_RETRY_MS);
      this.retryAfter = this.now() + delay;
      return null;
    }

    this.unknownCount = 0;
    this.retryAfter = 0;
    const notice = availability.status === 'available' ? await this.toNotice(availability) : null;
    if (generation !== this.generation) return null;
    this.cached = { notice, expiresAt: this.now() + this.cacheDurationMs };
    return notice;
  }

  private async checkWithTimeout(): Promise<UpdateAvailability> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<UpdateAvailability>(resolve => {
      timer = setTimeout(() => resolve({ status: 'unknown' }), this.timeoutMs);
    });
    try {
      return await Promise.race([this.adapter.check(), timeout]);
    } catch {
      return { status: 'unknown' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async toNotice(
    availability: Extract<UpdateAvailability, { status: 'available' }>
  ): Promise<UpdateNotice | null> {
    if (!semver.valid(availability.currentVersion) || !semver.valid(availability.availableVersion)) return null;
    if (!semver.gt(availability.availableVersion, availability.currentVersion)) return null;

    let summary: string | null = null;
    let urgency: UpdateNotice['urgency'] = 'normal';
    try {
      const manifest = parseUpdateManifest(await this.loadManifest());
      const metadata = selectUpdateMetadata(manifest, this.adapter.platform, availability.availableVersion);
      if (metadata) {
        summary = metadata.summary;
        urgency = metadata.urgency;
      }
    } catch {
      // Availability remains authoritative when optional presentation metadata is unavailable.
    }

    return {
      platform: this.adapter.platform,
      currentVersion: availability.currentVersion,
      availableVersion: availability.availableVersion,
      summary,
      urgency,
      action: availability.action
    };
  }
}
