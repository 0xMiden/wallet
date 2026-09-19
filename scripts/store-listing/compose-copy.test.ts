import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * These tests execute the public CLI rather than importing helper functions.
 * That covers argument parsing, validation order, path handling, formatting,
 * and file writes through the same entry point used to prepare uploads.
 *
 * Policy tests use deliberate source mutations. Each test name identifies the
 * production change it must catch: a relaxed limit, reordered shared block,
 * copied fact, platform term leak, unsupported claim, or Unicode dash. A test
 * that only restated the checked-in JSON would not protect the validator.
 */
type TextBlock = {
  id: string;
  heading?: string;
  text?: string;
  bullets?: string[];
};

type PlatformCopy = {
  fields: Record<string, string | string[]>;
  blocks: TextBlock[];
  blockOrder: string[];
};

type CopySource = {
  shared: {
    blocks: TextBlock[];
    blockOrder: string[];
  };
  platforms: Record<'appStore' | 'playStore' | 'chromeWebStore', PlatformCopy>;
};

type GeneratedCopy = {
  fields: Record<string, string | string[]>;
  sharedBlocks: TextBlock[];
  platformBlocks: TextBlock[];
  blockOrder: string[];
  description: string;
  screenshots: Array<{ id: string; headline: string; alt: string }>;
  promotionalArtwork: Array<{ id: string; kind: string; headline: string; alt: string }>;
};

const repositoryRoot = path.resolve(__dirname, '../..');
const canonicalSourcePath = path.join(repositoryRoot, 'store-listing/listing-copy.json');
const schemaPath = path.join(repositoryRoot, 'store-listing/schema/listing-copy.schema.json');
const scriptPath = path.join(repositoryRoot, 'scripts/store-listing/compose-copy.mjs');
const temporaryDirectories: string[] = [];

function loadCanonicalSource(): CopySource {
  return JSON.parse(readFileSync(canonicalSourcePath, 'utf8')) as CopySource;
}

function serializeSource(source: CopySource): string {
  // Keep the temporary fixture itself ASCII-only while still exercising JSON
  // escapes that decode to forbidden Unicode dash code points.
  return `${JSON.stringify(source, null, 2)
    .replaceAll(String.fromCodePoint(0x2013), '\\u2013')
    .replaceAll(String.fromCodePoint(0x2014), '\\u2014')}\n`;
}

function generate(source: CopySource) {
  // Every invocation gets an isolated output tree. Reusing one directory could
  // hide a generator that failed to replace a stale file.
  const directory = mkdtempSync(path.join(tmpdir(), 'bread-listing-copy-'));
  temporaryDirectories.push(directory);

  const sourcePath = path.join(directory, 'listing-copy.json');
  const outputRoot = path.join(directory, 'generated');
  const markdownPath = path.join(directory, 'STORE_LISTING.md');
  writeFileSync(sourcePath, serializeSource(source));

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--source', sourcePath, '--output-root', outputRoot, '--markdown', markdownPath],
    { cwd: repositoryRoot, encoding: 'utf8' }
  );

  const readOutput = (store: string): GeneratedCopy =>
    JSON.parse(readFileSync(path.join(outputRoot, store, 'copy.json'), 'utf8')) as GeneratedCopy;

  return { markdownPath, outputRoot, readOutput, result };
}

function expectInvalid(mutate: (source: CopySource) => void, expectedMessage: string) {
  // JSON cloning mirrors what the CLI receives and prevents a mutation test
  // from changing the canonical object used by a later test.
  const source = JSON.parse(JSON.stringify(loadCanonicalSource())) as CopySource;
  mutate(source);
  const { result } = generate(source);

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(expectedMessage);
}

afterAll(() => {
  temporaryDirectories.forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('store listing copy composition', () => {
  it('generates all copy files and the human-readable listing from the canonical source', () => {
    const { markdownPath, readOutput, result } = generate(loadCanonicalSource());

    expect(result.status).toBe(0);
    const appStore = readOutput('app-store');
    expect(appStore.description).toContain('Bread Wallet by Miden');
    expect(appStore.fields.keywords).toBe('miden,wallet,self-custody,privacy,crypto,blockchain,recovery,guardian,dapp');
    expect(readOutput('play-store').description).toContain('Bread Wallet by Miden');
    expect(readOutput('chrome-web-store').description).toContain('Bread Wallet by Miden');
    expect(readFileSync(markdownPath, 'utf8')).toContain('# Bread Wallet store listings');
  });

  it('keeps shared blocks byte-identical if a platform output path is changed', () => {
    // Catches a generator branch that reconstructs or edits shared prose per store.
    const { readOutput, result } = generate(loadCanonicalSource());
    expect(result.status).toBe(0);

    const outputs = ['app-store', 'play-store', 'chrome-web-store'].map(readOutput);
    expect(outputs[1].sharedBlocks).toEqual(outputs[0].sharedBlocks);
    expect(outputs[2].sharedBlocks).toEqual(outputs[0].sharedBlocks);
  });

  it('keeps shared blocks ahead of platform blocks if generator ordering is changed', () => {
    // Catches platform marketing text being inserted ahead of the common story.
    const source = loadCanonicalSource();
    const { readOutput, result } = generate(source);
    expect(result.status).toBe(0);

    const expectedShared = source.shared.blockOrder;
    for (const store of ['app-store', 'play-store', 'chrome-web-store']) {
      const output = readOutput(store);
      expect(output.blockOrder.slice(0, expectedShared.length)).toEqual(expectedShared);
      expect(output.blockOrder.slice(expectedShared.length)).toEqual(output.platformBlocks.map(({ id }) => id));
    }
  });

  it('rejects adding swap to App Store copy while retaining the Android fact', () => {
    // Catches both an iOS claim leak and accidental removal of the Android claim.
    const { readOutput, result } = generate(loadCanonicalSource());
    expect(result.status).toBe(0);
    expect(readOutput('app-store').description).not.toMatch(/\bswap\b/i);
    expect(readOutput('play-store').description).toMatch(/\bswap\b/i);

    expectInvalid(source => {
      source.platforms.appStore.blocks[0].bullets?.push('Swap supported assets.');
    }, 'App Store copy must not mention swap');
  });

  it.each([
    ['App Store', 'appStore', 'Unlock with fingerprint.', 'App Store authentication copy'],
    ['Google Play', 'playStore', 'Unlock with Face ID.', 'Google Play authentication copy'],
    ['Chrome Web Store', 'chromeWebStore', 'Unlock with Face ID.', 'Chrome authentication copy']
  ] as const)('rejects replacing %s authentication terminology', (_label, platform, text, error) => {
    // Catches mobile brand names leaking across platforms or into Chrome.
    expectInvalid(source => {
      source.platforms[platform].blocks[0].bullets?.push(text);
    }, error);
  });

  it.each([
    ['App Store subtitle', 'appStore', 'subtitle', 31, 'subtitle exceeds 30 characters'],
    ['App Store keywords', 'appStore', 'keywords', 101, 'keywords exceeds 100 bytes'],
    ['Google Play short description', 'playStore', 'shortDescription', 81, 'shortDescription exceeds 80 characters'],
    ['Chrome short description', 'chromeWebStore', 'shortDescription', 133, 'shortDescription exceeds 132 characters']
  ] as const)('rejects increasing %s past its first-party limit', (_label, platform, field, length, error) => {
    // Boundary mutations fail at limit + 1, where each store rejects input.
    expectInvalid(source => {
      source.platforms[platform].fields[field] = 'x'.repeat(length);
    }, error);
  });

  it('rejects reusing a fact id if a platform order duplicates it', () => {
    // Catches duplicate structural references even when prose remains unchanged.
    expectInvalid(source => {
      const [first] = source.platforms.appStore.blockOrder;
      source.platforms.appStore.blockOrder.push(first);
    }, 'App Store block order contains duplicate fact ids');
  });

  it('rejects copying an existing fact into a different block', () => {
    // Catches the same assertion returning under a fresh structural id.
    expectInvalid(source => {
      const sharedFact = source.shared.blocks[0].text;
      if (sharedFact) source.platforms.appStore.blocks[0].bullets?.push(sharedFact);
    }, 'App Store description repeats a fact');
  });

  it('rejects introducing an unsupported superlative', () => {
    // Catches a future marketing edit that restores the old Chrome claims.
    expectInvalid(source => {
      source.platforms.chromeWebStore.blocks[0].bullets?.push('The leading wallet for Miden.');
    }, 'Forbidden claim');
  });

  it.each([0x2013, 0x2014])('rejects introducing Unicode dash U+%s', codePoint => {
    // Both prohibited code points are constructed without embedding either one.
    expectInvalid(source => {
      source.platforms.playStore.blocks[0].bullets?.push(`Invalid${String.fromCodePoint(codePoint)}dash`);
    }, 'Unicode dashes are not allowed');
  });

  it('keeps screenshot headlines and alt text complete for every platform', () => {
    // Catches a visually complete scene that remains inaccessible or unnamed.
    const { readOutput, result } = generate(loadCanonicalSource());
    expect(result.status).toBe(0);

    for (const store of ['app-store', 'play-store', 'chrome-web-store']) {
      for (const screenshot of readOutput(store).screenshots) {
        expect(screenshot.id).not.toHaveLength(0);
        expect(screenshot.headline).not.toHaveLength(0);
        expect(screenshot.alt).not.toHaveLength(0);
      }
    }
  });

  it('uses the approved five-image Chrome sequence and assigns the remaining scenes to promo artwork', () => {
    const { readOutput, result } = generate(loadCanonicalSource());
    expect(result.status).toBe(0);

    const chrome = readOutput('chrome-web-store');
    expect(chrome.screenshots.map(({ id }) => id)).toEqual([
      'wallet-keys',
      'send-privacy',
      'receive',
      'guardian',
      'chrome-connect'
    ]);
    expect(chrome.promotionalArtwork.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'chrome-confirm', kind: 'smallPromo' },
      { id: 'chrome-side-panel', kind: 'marquee' }
    ]);
  });

  // The generated-copy directory is resolved from a slug the MANIFEST supplies. Without
  // containment, `path.resolve` happily walks out of the output root, so these two shapes wrote
  // wherever the process could reach. Both pass on an unguarded composer.
  it.each([
    ['a relative escape', '../escape'],
    ['an absolute path', path.join(tmpdir(), 'bread-listing-escape')]
  ])('refuses %s in a platform slug', (_label, slug) => {
    expectInvalid(source => {
      source.platforms.appStore.slug = slug;
    }, 'escapes root');
  });

  it('describes the canonical source with a JSON schema', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      $schema: string;
      required: string[];
    };

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.required).toEqual(expect.arrayContaining(['shared', 'platforms', 'screenshots']));
  });

  it('produces byte-identical files on repeated runs', () => {
    // Separate output roots expose timestamps, absolute paths, and stale-file reads.
    const first = generate(loadCanonicalSource());
    const second = generate(loadCanonicalSource());
    expect(first.result.status).toBe(0);
    expect(second.result.status).toBe(0);

    for (const store of ['app-store', 'play-store', 'chrome-web-store']) {
      const relativePath = path.join(store, 'copy.json');
      expect(readFileSync(path.join(first.outputRoot, relativePath))).toEqual(
        readFileSync(path.join(second.outputRoot, relativePath))
      );
    }
    expect(readFileSync(first.markdownPath)).toEqual(readFileSync(second.markdownPath));
  });
});
