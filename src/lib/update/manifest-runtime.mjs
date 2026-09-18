import semver from 'semver';

// A platform belongs here once the wallet has an authoritative update source for
// it. Desktop has none, so a desktop entry is rejected by the schema itself
// rather than by a separate release check.
const PLATFORM_NAMES = ['chrome', 'android', 'ios'];
const URGENCY_NAMES = ['normal', 'important', 'critical'];
const TOP_LEVEL_FIELDS = ['schemaVersion', 'releases'];
const RELEASE_FIELDS = ['version', 'summary', 'urgency', 'platforms'];
const SUMMARY_MAX_LENGTH = 280;
// The catalog only has to describe releases a client may still be behind, and a
// cap is what stops an append-only file growing into every device's storage.
const MAX_RELEASES = 50;

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const assertExactFields = (value, allowed, label) => {
  const unknown = Object.keys(value).filter(field => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown[0]}`);
};

const parseVersion = (value, label) => {
  if (typeof value !== 'string' || semver.valid(value) !== value) {
    throw new Error(`${label} must be a strict SemVer version`);
  }
  return value;
};

const parseSummary = value => {
  const hasUnsafeCharacter =
    typeof value === 'string' &&
    (value.includes('<') ||
      value.includes('>') ||
      [...value].some(character => {
        const code = character.codePointAt(0);
        return code !== undefined && (code < 32 || code === 127);
      }));
  if (typeof value !== 'string' || value.length === 0 || value.length > SUMMARY_MAX_LENGTH || hasUnsafeCharacter) {
    throw new Error(`summary must be plain text between 1 and ${SUMMARY_MAX_LENGTH} characters`);
  }
  return value;
};

const parseRelease = value => {
  if (!isRecord(value)) throw new Error('release must be an object');
  assertExactFields(value, RELEASE_FIELDS, 'release');
  const version = parseVersion(value.version, 'release version');
  const summary = parseSummary(value.summary);
  if (typeof value.urgency !== 'string' || !URGENCY_NAMES.includes(value.urgency)) {
    throw new Error('release urgency must be normal, important, or critical');
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    throw new Error('release platforms must be a non-empty array');
  }
  if (value.platforms.some(name => !PLATFORM_NAMES.includes(name))) {
    throw new Error('release platform must be chrome, android, or ios');
  }
  if (new Set(value.platforms).size !== value.platforms.length) {
    throw new Error('release platforms must be unique');
  }
  return { version, summary, urgency: value.urgency, platforms: [...value.platforms] };
};

const parseTopLevel = value => {
  if (!isRecord(value)) throw new Error('update manifest must be an object');
  assertExactFields(value, TOP_LEVEL_FIELDS, 'update manifest');
  if (value.schemaVersion !== 1) throw new Error('update manifest schemaVersion must be 1');
  if (!Array.isArray(value.releases)) throw new Error('update manifest releases must be an array');
  if (value.releases.length > MAX_RELEASES) {
    throw new Error(`update manifest must list at most ${MAX_RELEASES} releases`);
  }
  return value.releases;
};

export const parseUpdateManifest = value => {
  const rawReleases = parseTopLevel(value);
  const releases = [];
  const versions = new Set();
  for (const rawRelease of rawReleases) {
    try {
      const parsed = parseRelease(rawRelease);
      if (versions.has(parsed.version)) continue;
      versions.add(parsed.version);
      releases.push(parsed);
    } catch {
      // Remote entries fail independently so one malformed release cannot hide valid metadata.
    }
  }
  return { schemaVersion: 1, releases };
};

export const validateUpdateManifest = value => {
  const rawReleases = parseTopLevel(value);
  const releases = rawReleases.map(parseRelease);
  const versions = new Set();
  let previousVersion;
  for (const release of releases) {
    if (versions.has(release.version)) throw new Error('release versions must be unique');
    versions.add(release.version);
    if (previousVersion && semver.lte(release.version, previousVersion)) {
      throw new Error('release versions must be in ascending order');
    }
    previousVersion = release.version;
  }
  return { schemaVersion: 1, releases };
};

export const selectUpdateMetadata = (manifest, platform, availableVersion) => {
  const release = manifest.releases.find(
    item => item.version === availableVersion && item.platforms.includes(platform)
  );
  if (!release) return null;
  return { version: release.version, summary: release.summary, urgency: release.urgency };
};
