import {
  parseUpdateManifest,
  selectUpdateMetadata,
  type UpdateManifest,
  type UpdateReleaseMetadata,
  validateUpdateManifest
} from './manifest';

const validRelease: UpdateReleaseMetadata = {
  version: '1.17.0',
  summary: 'Security fixes and reliability improvements.',
  urgency: 'normal',
  platforms: ['chrome', 'android', 'ios']
};

const release = (overrides: Record<string, unknown> = {}) => ({
  ...validRelease,
  ...overrides
});

describe('parseUpdateManifest', () => {
  it('accepts a strict versioned catalog without releases', () => {
    expect(parseUpdateManifest({ schemaVersion: 1, releases: [] })).toEqual({ schemaVersion: 1, releases: [] });
  });

  it('accepts a valid release without trusting extra runtime types', () => {
    expect(parseUpdateManifest({ schemaVersion: 1, releases: [release()] })).toEqual({
      schemaVersion: 1,
      releases: [release()]
    });
  });

  it('ignores a duplicate release and a non-object entry without suppressing valid metadata', () => {
    expect(
      parseUpdateManifest({
        schemaVersion: 1,
        releases: [release(), 'not a release', release({ summary: 'A duplicate version.' })]
      }).releases
    ).toEqual([release()]);
  });

  it('ignores an invalid release without suppressing valid metadata', () => {
    expect(
      parseUpdateManifest({
        schemaVersion: 1,
        releases: [release({ summary: '<b>unsafe</b>' }), release({ version: '1.18.0', platforms: ['ios'] })]
      }).releases
    ).toEqual([release({ version: '1.18.0', platforms: ['ios'] })]);
  });

  it.each([
    ['not an object', 'must be an object'],
    [{ schemaVersion: 2, releases: [] }, 'schema'],
    [{ schemaVersion: 1, releases: '1.17.0' }, 'releases'],
    [{ schemaVersion: 1, releases: [release({ version: '1.17' })] }, 'version'],
    [{ schemaVersion: 1, releases: [release(), release({ summary: 'Second entry for the same release.' })] }, 'unique'],
    [{ schemaVersion: 1, releases: [release({ urgency: 'mandatory' })] }, 'urgency'],
    [{ schemaVersion: 1, releases: [release({ summary: '<b>Install this</b>' })] }, 'plain text'],
    [{ schemaVersion: 1, releases: [release({ summary: 'line one\nline two' })] }, 'plain text'],
    [{ schemaVersion: 1, releases: [release({ summary: 'x'.repeat(281) })] }, '280'],
    [{ schemaVersion: 1, releases: [release({ action: 'Install' })] }, 'unknown'],
    // An append-only catalog every client downloads needs a ceiling, or it
    // grows into every device's storage unnoticed.
    [
      {
        schemaVersion: 1,
        releases: Array.from({ length: 51 }, (_, index) => release({ version: `1.${index}.0` }))
      },
      'at most 50'
    ],
    [{ schemaVersion: 1, releases: [release({ platforms: [] })] }, 'non-empty'],
    [{ schemaVersion: 1, releases: [release({ platforms: { chrome: { version: '1.17.0' } } })] }, 'non-empty'],
    [{ schemaVersion: 1, releases: [release({ platforms: ['chrome', 'chrome'] })] }, 'unique'],
    [{ schemaVersion: 1, releases: [release({ platforms: ['firefox'] })] }, 'platform'],
    // Desktop has no authoritative update source, so the schema itself refuses
    // an entry naming it; no separate release check is needed.
    [{ schemaVersion: 1, releases: [release({ platforms: ['desktop'] })] }, 'platform'],
    [
      {
        schemaVersion: 1,
        releases: [release({ version: '1.18.0', platforms: ['ios'] }), release()]
      },
      'ascending'
    ]
  ])('rejects an invalid catalog (%s)', (input, message) => {
    expect(() => validateUpdateManifest(input)).toThrow(message);
  });
});

describe('selectUpdateMetadata', () => {
  const laterRelease: UpdateReleaseMetadata = {
    version: '1.18.0',
    summary: 'A later staged release.',
    urgency: 'important',
    platforms: ['chrome', 'ios']
  };
  const manifest: UpdateManifest = {
    schemaVersion: 1,
    releases: [validRelease, laterRelease]
  };

  it('selects only an exact platform and available-version match', () => {
    expect(selectUpdateMetadata(manifest, 'android', '1.17.0')).toEqual({
      version: '1.17.0',
      summary: 'Security fixes and reliability improvements.',
      urgency: 'normal'
    });
    expect(selectUpdateMetadata(manifest, 'android', '1.18.0')).toBeNull();
  });

  it('keeps each release scoped to the platforms it names', () => {
    expect(selectUpdateMetadata(manifest, 'chrome', '1.18.0')?.summary).toBe('A later staged release.');
    expect(selectUpdateMetadata(manifest, 'ios', '1.17.0')?.summary).toBe(
      'Security fixes and reliability improvements.'
    );
  });

  it('does not return stale metadata for a newer authoritative version', () => {
    expect(selectUpdateMetadata(manifest, 'chrome', '1.19.0')).toBeNull();
  });
});
