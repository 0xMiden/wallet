import semver from 'semver';

/** Bridge and storage responses are untrusted input: every adapter re-checks them. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly `major.minor.patch`, as every platform's version is compared with semver. */
export const isStrictVersion = (value: unknown): value is string =>
  typeof value === 'string' && semver.valid(value) === value;
