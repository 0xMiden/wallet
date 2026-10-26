/**
 * What the spec asserts the build was configured with.
 *
 * Restated here rather than shared with `build:chrome:telemetry` in
 * package.json, because a yarn script cannot import TypeScript. That duplication
 * is deliberate but NOT unguarded: `assertBuildIsTelemetryConfigured` reads
 * these values back out of the built bundle before any test runs, so a drift
 * between the two fails immediately and by name. Without that check drift would
 * be silent in the worst direction — an unconfigured build sends nothing, which
 * is precisely what the pre-consent test asserts.
 */

/**
 * A self-hosted-shaped key, which is what makes `APTABASE_HOST` load-bearing:
 * `A-SH-*` has no region to derive a host from, so the build MUST supply one and
 * cannot silently fall back to a real Aptabase region endpoint. An `A-EU-*` key
 * with a typo'd host would reach eu.aptabase.com; this cannot.
 */
export const APTABASE_APP_KEY = 'A-SH-0000000000';

/** Fixed, because the extension is built with it compiled in. */
export const SINK_PORT = 57399;

export const APTABASE_HOST = `http://127.0.0.1:${SINK_PORT}`;
